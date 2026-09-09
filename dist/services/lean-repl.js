import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ObjectUtils } from "../utils/object-utils.js";
const DEFAULT_BUILD_TIMEOUT_MS = 600000;
const MAX_BUILD_OUTPUT_CHARS = 1000000;
const MATHLIB_MODULE_PATTERN = /^Mathlib\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/**
 * 管理 Lean 4 常驻验证进程，并提供兼容 JSON 行 REPL 的请求能力。
 * 默认通过 Lake 环境直接启动 lean --server，并复用同一 LSP 文档的 Mathlib 导入状态。
 * @author ygw
 */
export class LeanReplService {
    process;
    pendingRequests = new Map();
    lspPending = new Map();
    diagnosticsByUri = new Map();
    documentVersions = new Map();
    config;
    lspBuffer = Buffer.alloc(0);
    serverReady;
    serverCwd;
    sessionDirectory;
    validationDocumentUri;
    validationDocumentPath;
    serverStderr = "";
    checkQueue = Promise.resolve();
    lakeEnvironment;
    lakeEnvironmentCwd;
    pendingBuildInspections = new Map();
    /**
     * 创建 Lean 验证服务。
     * @param config 常驻进程、工作目录和超时配置。
     * @returns {LeanReplService} 服务实例。
     */
    constructor(config = {}) {
        this.config = {
            ...config,
            command: config.command ?? "lean-repl",
            requestTimeoutMs: config.requestTimeoutMs ?? 120000,
            buildTimeoutMs: config.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
            leanCommand: config.leanCommand ?? "lean",
            lakeCommand: config.lakeCommand ?? "lake",
            replMode: config.replMode ?? "lsp",
            serverCommand: config.serverCommand ?? config.leanCommand ?? "lean"
        };
    }
    /**
     * 预热常驻验证进程。
     * @returns {void} 启动操作在后台执行。
     */
    start() {
        if (this.config.replMode === "jsonl") {
            this.startJsonlProcess();
            return;
        }
        const workspace = resolve(this.config.cwd ?? process.cwd());
        void this.ensureServerReady(workspace).catch(() => undefined);
    }
    /**
     * 向 JSON 行 REPL 或 LSP 服务发送一个请求。
     * @param request REPL 请求对象。
     * @returns {Promise<ReplResponse>} 对应的服务响应。
     */
    async request(request) {
        this.validateRequest(request);
        if (this.config.replMode === "jsonl")
            return this.requestJsonl(request);
        const workspace = resolve(this.config.cwd ?? process.cwd());
        await this.ensureServerReady(workspace);
        const response = await this.sendLspRequest(request.method, request.params ?? {}, request.id);
        return { id: request.id, result: response.result, error: response.error };
    }
    /**
     * 在常驻 Lake/Lean 服务中检查源码。
     * @param options 源码、临时文件名和工作目录。
     * @returns {Promise<LeanCheckResult>} 检查结果和结构化诊断。
     */
    async checkSource(options) {
        this.validateCheckOptions(options);
        const queuedCheck = this.checkQueue.then(() => this.runPersistentCheck(options));
        this.checkQueue = queuedCheck.then(() => undefined, () => undefined);
        return queuedCheck;
    }
    /**
     * 检查 Lean 源码的精确导入是否可由当前本地 `.olean` 缓存满足。
     * 该方法只读取 Lake 环境和本地文件系统，绝不触发构建、缓存下载或网络访问。
     * @param source 完整 Lean 源码。
     * @param cwd 可选的 Lake 工作区目录。
     * @returns {Promise<LeanImportInspection>} 结构化的缓存命中、缺失模块和最小可授权构建目标。
     */
    async inspectImports(source, cwd) {
        if (typeof source !== "string" || source.length === 0) {
            throw new Error("Lean 导入检查必须提供非空 source 字符串。");
        }
        const workspace = resolve(cwd ?? this.config.cwd ?? process.cwd());
        const environment = await this.ensureLakeEnvironment(workspace);
        const imports = extractLeanImports(source);
        const searchPaths = leanSearchPaths(environment, workspace);
        const cachedImports = [];
        const missingImports = [];
        for (const moduleName of imports) {
            if (await hasModuleArtifact(moduleName, searchPaths)) {
                cachedImports.push(moduleName);
            }
            else {
                missingImports.push(moduleName);
            }
        }
        const buildTargets = missingImports.filter(moduleName => MATHLIB_MODULE_PATTERN.test(moduleName));
        const unbuildableImports = missingImports.filter(moduleName => !MATHLIB_MODULE_PATTERN.test(moduleName));
        const inspection = {
            imports,
            cachedImports,
            missingImports,
            buildTargets,
            unbuildableImports
        };
        // Only a result created by this service instance and still held in this map can authorize a
        // build. This prevents a caller from submitting arbitrary Lake targets after user approval.
        if (buildTargets.length > 0 && unbuildableImports.length === 0) {
            this.pendingBuildInspections.set(inspection, {
                workspace,
                // Preserve the exact target snapshot. Object identity alone is insufficient because a
                // caller could mutate a JavaScript array after the user has reviewed it.
                buildTargets: [...buildTargets]
            });
        }
        return inspection;
    }
    /**
     * 构建刚刚由本服务检查并经调用方授权的精确 Mathlib 模块。
     * @param inspection 由同一服务的 {@link inspectImports} 返回且尚未使用的检查对象。
     * @param signal 可选的调用取消信号。
     * @returns {Promise<LeanImportBuildResult>} 受限 Lake 构建结果。
     */
    async buildMissingImports(inspection, signal) {
        validateBuildInspection(inspection);
        const pendingInspection = this.pendingBuildInspections.get(inspection);
        if (ObjectUtils.isEmpty(pendingInspection)) {
            throw new Error("受控 Mathlib 构建只能使用同一服务刚刚产生且尚未使用的导入检查结果。");
        }
        if (!sameStringList(inspection.buildTargets, pendingInspection.buildTargets)) {
            throw new Error("受控 Mathlib 构建目标与检查时列出的精确模块不一致。");
        }
        this.pendingBuildInspections.delete(inspection);
        const queuedBuild = this.checkQueue.then(() => this.runMissingImportBuild(pendingInspection.workspace, inspection, signal));
        this.checkQueue = queuedBuild.then(() => undefined, () => undefined);
        return queuedBuild;
    }
    /**
     * 停止常驻进程并清理会话文件。
     * @returns {void} 无返回值。
     */
    stop() {
        const runningProcess = this.process;
        this.process = undefined;
        this.serverReady = undefined;
        this.serverCwd = undefined;
        this.lakeEnvironment = undefined;
        this.lakeEnvironmentCwd = undefined;
        this.pendingBuildInspections.clear();
        if (!ObjectUtils.isEmpty(runningProcess)) {
            runningProcess.kill();
        }
        this.rejectPending(new Error("Lean 验证服务已停止。"));
        this.documentVersions.clear();
        this.diagnosticsByUri.clear();
        this.validationDocumentUri = undefined;
        this.validationDocumentPath = undefined;
        const directory = this.sessionDirectory;
        this.sessionDirectory = undefined;
        if (!ObjectUtils.isEmpty(directory))
            void rm(directory, { recursive: true, force: true });
    }
    /**
     * 判断验证进程是否正在运行。
     * @returns {boolean} 进程存在时返回 true。
     */
    isRunning() {
        return !ObjectUtils.isEmpty(this.process);
    }
    /**
     * 在验证队列中执行一份已授权的精确模块构建。
     * @param workspace Lake 工作区绝对路径。
     * @param inspection 已校验的精确模块清单。
     * @param signal 可选的调用取消信号。
     * @returns {Promise<LeanImportBuildResult>} Lake 的受限构建结果。
     */
    async runMissingImportBuild(workspace, inspection, signal) {
        if (signal?.aborted)
            throw abortError(signal.reason);
        const environment = await this.ensureLakeEnvironment(workspace);
        // Lake may replace `.olean` files. Close the persistent reader first so Windows does not keep
        // stale handles open and the next check always creates a fresh Lean view of the artifact set.
        if (this.serverCwd === workspace || this.isReadyFor(workspace)) {
            await this.stopServerForArtifactChange();
        }
        return this.runLakeBuild(workspace, environment, inspection.buildTargets, signal);
    }
    /**
     * 关闭现有 Lean 读取进程并等待其释放可能被 Lake 替换的 `.olean` 句柄。
     * @returns {Promise<void>} 进程退出或有限等待期结束后返回。
     */
    async stopServerForArtifactChange() {
        const runningProcess = this.process;
        const directory = this.sessionDirectory;
        this.process = undefined;
        this.serverReady = undefined;
        this.serverCwd = undefined;
        this.lakeEnvironment = undefined;
        this.lakeEnvironmentCwd = undefined;
        this.pendingBuildInspections.clear();
        this.documentVersions.clear();
        this.diagnosticsByUri.clear();
        this.validationDocumentUri = undefined;
        this.validationDocumentPath = undefined;
        this.sessionDirectory = undefined;
        this.rejectPending(new Error("Lean 验证服务因受控 Mathlib 构建而重启。"));
        if (!ObjectUtils.isEmpty(runningProcess)) {
            const child = runningProcess;
            const exited = waitForProcessExit(child);
            child.kill();
            await exited;
        }
        if (!ObjectUtils.isEmpty(directory)) {
            await rm(directory, { recursive: true, force: true });
        }
    }
    /**
     * Run Lake with a fixed argument array and bounded captured output.
     * @param workspace Lake 工作区绝对路径。
     * @param environment 已解析的 Lake 环境变量。
     * @param targets 已授权的精确 Mathlib 模块名。
     * @param signal 可选的调用取消信号。
     * @returns {Promise<LeanImportBuildResult>} 不泄露环境变量的构建摘要。
     */
    runLakeBuild(workspace, environment, targets, signal) {
        return new Promise((resolveBuild, rejectBuild) => {
            let stdout = "";
            let stderr = "";
            let completed = false;
            let timer;
            let childProcess;
            const append = (current, chunk) => (current + chunk.toString()).slice(-MAX_BUILD_OUTPUT_CHARS);
            const settle = (result) => {
                if (completed)
                    return;
                completed = true;
                if (timer !== undefined)
                    clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                resolveBuild(result);
            };
            const abort = () => {
                childProcess.kill();
                settle({
                    buildTargets: [...targets],
                    success: false,
                    output: mergeBuildOutput(stdout, `${stderr}\n受控 Mathlib 构建已取消。`)
                });
            };
            try {
                childProcess = spawn(this.config.lakeCommand, ["build", ...targets], {
                    cwd: workspace,
                    env: environment,
                    stdio: "pipe",
                    windowsHide: true
                });
            }
            catch (error) {
                rejectBuild(error);
                return;
            }
            childProcess.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
            childProcess.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
            childProcess.once("error", (error) => {
                settle({
                    buildTargets: [...targets],
                    success: false,
                    output: mergeBuildOutput(stdout, `${stderr}\n${error.message}`)
                });
            });
            childProcess.once("exit", (code, exitSignal) => {
                const exitDetail = exitSignal === null ? "" : `\nLake 被信号 ${exitSignal} 终止。`;
                settle({
                    buildTargets: [...targets],
                    success: code === 0,
                    output: mergeBuildOutput(stdout, stderr + exitDetail),
                    ...(code === null ? {} : { exitCode: code })
                });
            });
            timer = setTimeout(() => {
                childProcess.kill();
                settle({
                    buildTargets: [...targets],
                    success: false,
                    output: mergeBuildOutput(stdout, `${stderr}\n受控 Mathlib 构建超过 ${this.config.buildTimeoutMs}ms 限制。`)
                });
            }, this.config.buildTimeoutMs);
            if (signal?.aborted) {
                abort();
            }
            else {
                signal?.addEventListener("abort", abort, { once: true });
            }
        });
    }
    async runPersistentCheck(options) {
        const workspace = resolve(options.cwd ?? this.config.cwd ?? process.cwd());
        const reusedProcess = this.isReadyFor(workspace);
        await this.ensureServerReady(workspace);
        if (ObjectUtils.isEmpty(this.sessionDirectory)) {
            throw new Error("Lean 验证会话目录未初始化。");
        }
        const sourceFileName = this.normalizeFileName(options.fileName);
        const { path: filePath, uri } = this.getValidationDocument();
        const version = (this.documentVersions.get(uri) ?? 0) + 1;
        const isOpen = this.documentVersions.has(uri);
        await writeFile(filePath, options.source, "utf8");
        this.documentVersions.set(uri, version);
        if (isOpen) {
            await this.sendLspNotification("textDocument/didChange", {
                textDocument: { uri, version },
                contentChanges: [{ text: options.source }]
            });
        }
        else {
            await this.sendLspNotification("textDocument/didOpen", {
                textDocument: { uri, languageId: "lean", version, text: options.source },
                // 验证会话只能复用已有 .olean，禁止临时文件触发 Lake 构建或远程缓存访问。
                dependencyBuildMode: "never"
            });
        }
        await this.waitForDiagnostics(uri, version);
        await new Promise((resolveCompletion) => setImmediate(resolveCompletion));
        const diagnostics = (this.diagnosticsByUri.get(uri)?.diagnostics ?? []).map((diagnostic) => ({
            ...diagnostic,
            // 会话物理文件是内部实现细节；对宿主保留模型提交时提供的逻辑文件名。
            filePath: sourceFileName
        }));
        const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
        return {
            exitCode: hasErrors ? 1 : 0,
            success: !hasErrors,
            stdout: "",
            stderr: this.serverStderr,
            diagnostics,
            reusedProcess,
            workspace
        };
    }
    async ensureServerReady(workspace) {
        if (this.isReadyFor(workspace)) {
            await this.serverReady;
            return;
        }
        if (!ObjectUtils.isEmpty(this.process))
            this.stop();
        if (ObjectUtils.isEmpty(this.sessionDirectory)) {
            this.sessionDirectory = await mkdtemp(join(workspace, "LeanHarnessSession_"));
        }
        this.serverCwd = workspace;
        this.lspBuffer = Buffer.alloc(0);
        this.serverStderr = "";
        // Lake 只负责计算环境变量；直接启动 Lean 可以避免 Windows 下多层子进程管道不透传 LSP 数据。
        const lakeEnvironment = await this.ensureLakeEnvironment(workspace);
        const childProcess = spawn(this.config.serverCommand, this.config.serverArgs ?? ["--server"], {
            cwd: workspace,
            env: lakeEnvironment,
            stdio: "pipe",
            windowsHide: true
        });
        this.process = childProcess;
        childProcess.stdout.on("data", (chunk) => this.handleLspData(chunk));
        childProcess.stderr.on("data", (chunk) => {
            this.serverStderr = (this.serverStderr + chunk.toString()).slice(-16000);
        });
        childProcess.once("error", (error) => this.failServer(error));
        childProcess.once("exit", (code, signal) => {
            this.failServer(new Error("Lean server 已退出（code=" + (code ?? "unknown") + ", signal=" + (signal ?? "none") + "）。"));
        });
        const ready = this.initializeServer(workspace);
        this.serverReady = ready;
        await ready;
    }
    /**
     * 获取本服务唯一的常驻验证文档。
     * @returns {{ path: string; uri: string }} LSP 实际使用的文件路径与 URI。
     */
    getValidationDocument() {
        if (!ObjectUtils.isEmpty(this.validationDocumentPath) && !ObjectUtils.isEmpty(this.validationDocumentUri)) {
            return { path: this.validationDocumentPath, uri: this.validationDocumentUri };
        }
        if (ObjectUtils.isEmpty(this.sessionDirectory)) {
            throw new Error("Lean 验证会话目录未初始化。");
        }
        const filePath = join(this.sessionDirectory, "Validation.lean");
        const uri = pathToFileURL(filePath).href;
        this.validationDocumentPath = filePath;
        this.validationDocumentUri = uri;
        return { path: filePath, uri };
    }
    /**
     * 读取 Lake 为当前工作区计算的环境变量。
     * @param workspace Lake 工作区绝对路径。
     * @returns {Promise<NodeJS.ProcessEnv>} 可传递给 Lean 服务进程的环境变量。
     */
    async loadLakeEnvironment(workspace) {
        const environmentProcess = spawn(this.config.lakeCommand, ["env"], {
            cwd: workspace,
            stdio: "pipe",
            windowsHide: true
        });
        let stdout = "";
        let stderr = "";
        return new Promise((resolveEnvironment, rejectEnvironment) => {
            let settled = false;
            environmentProcess.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
            });
            environmentProcess.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
            });
            environmentProcess.once("error", (error) => {
                if (settled)
                    return;
                settled = true;
                rejectEnvironment(new Error("读取 Lake 环境失败：" + error.message));
            });
            environmentProcess.once("exit", (code, signal) => {
                if (settled)
                    return;
                settled = true;
                if (code !== 0) {
                    const detail = stderr.trim();
                    rejectEnvironment(new Error("读取 Lake 环境失败（code=" + (code ?? "unknown") + ")：" + detail));
                    return;
                }
                resolveEnvironment(this.parseEnvironmentOutput(stdout));
            });
        });
    }
    /**
     * 缓存同一 Lake 工作区已解析的环境，避免导入检查与常驻服务重复执行 `lake env`。
     * @param workspace Lake 工作区绝对路径。
     * @returns {Promise<NodeJS.ProcessEnv>} 当前工作区可复用的环境变量。
     */
    async ensureLakeEnvironment(workspace) {
        if (!ObjectUtils.isEmpty(this.lakeEnvironment) && this.lakeEnvironmentCwd === workspace) {
            return this.lakeEnvironment;
        }
        const environment = await this.loadLakeEnvironment(workspace);
        this.lakeEnvironment = environment;
        this.lakeEnvironmentCwd = workspace;
        return environment;
    }
    /**
     * 将 Lake 的 NAME=VALUE 输出合并到当前进程环境。
     * @param output Lake 环境变量原文。
     * @returns {NodeJS.ProcessEnv} Lean 服务启动环境。
     */
    parseEnvironmentOutput(output) {
        const environment = { ...process.env };
        for (const line of output.split(/\r?\n/)) {
            const separator = line.indexOf("=");
            if (separator <= 0)
                continue;
            const name = line.slice(0, separator).trim();
            if (ObjectUtils.isEmpty(name))
                continue;
            environment[name] = line.slice(separator + 1);
        }
        return environment;
    }
    async initializeServer(workspace) {
        try {
            const response = await this.sendLspRequest("initialize", {
                processId: process.pid,
                rootUri: pathToFileURL(workspace).href,
                capabilities: {
                    workspace: { configuration: false },
                    textDocument: { synchronization: { dynamicRegistration: false } }
                },
                workspaceFolders: [{ uri: pathToFileURL(workspace).href, name: basename(workspace) }]
            });
            if (!ObjectUtils.isEmpty(response.error)) {
                const initializeError = response.error;
                throw new Error("Lean server 初始化失败：" + initializeError.message);
            }
            await this.sendLspNotification("initialized", {});
        }
        catch (error) {
            this.stop();
            throw error;
        }
    }
    sendLspRequest(method, params, requestId) {
        if (ObjectUtils.isEmpty(this.process))
            throw new Error("Lean server 进程未启动。");
        const id = requestId ?? randomUUID();
        return new Promise((resolveResponse, rejectResponse) => {
            const timer = setTimeout(() => {
                this.lspPending.delete(id);
                rejectResponse(new Error("Lean LSP 请求超时：" + method));
            }, this.config.requestTimeoutMs);
            this.lspPending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
            this.writeLspMessage({ jsonrpc: "2.0", id, method, params });
        });
    }
    async sendLspNotification(method, params) {
        if (ObjectUtils.isEmpty(this.process))
            throw new Error("Lean server 进程未启动。");
        this.writeLspMessage({ jsonrpc: "2.0", method, params });
    }
    /**
     * 等待 Lean 为指定文档版本完成所有诊断。
     * @param uri 已打开 Lean 文档的 URI。
     * @param version 需要完成的文档版本。
     * @returns {Promise<void>} Lean 返回同步响应后完成。
     */
    async waitForDiagnostics(uri, version) {
        const response = await this.sendLspRequest("textDocument/waitForDiagnostics", { uri, version });
        if (!ObjectUtils.isEmpty(response.error)) {
            const error = response.error;
            throw new Error("Lean 等待诊断失败：" + error.message);
        }
    }
    writeLspMessage(message) {
        if (ObjectUtils.isEmpty(this.process))
            throw new Error("Lean server 进程未启动。");
        const payload = JSON.stringify(message);
        const frame = "Content-Length: " + Buffer.byteLength(payload, "utf8") + "\r\n\r\n" + payload;
        this.process.stdin.write(frame, "utf8");
    }
    handleLspData(chunk) {
        this.lspBuffer = Buffer.concat([this.lspBuffer, chunk]);
        const separator = Buffer.from("\r\n\r\n");
        while (true) {
            const headerEnd = this.lspBuffer.indexOf(separator);
            if (headerEnd < 0)
                return;
            const header = this.lspBuffer.subarray(0, headerEnd).toString("ascii");
            const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
            if (ObjectUtils.isEmpty(lengthMatch)) {
                this.lspBuffer = this.lspBuffer.subarray(headerEnd + separator.length);
                continue;
            }
            const contentLength = Number(lengthMatch[1]);
            const contentStart = headerEnd + separator.length;
            if (this.lspBuffer.length < contentStart + contentLength)
                return;
            const body = this.lspBuffer.subarray(contentStart, contentStart + contentLength).toString("utf8");
            this.lspBuffer = this.lspBuffer.subarray(contentStart + contentLength);
            try {
                this.handleLspMessage(JSON.parse(body));
            }
            catch {
                // 忽略不完整或非 JSON 的 server 输出，保持协议解析器可继续工作。
            }
        }
    }
    handleLspMessage(message) {
        if (message.method === "textDocument/publishDiagnostics") {
            this.handleDiagnostics(message.params);
            return;
        }
        if (message.method === "$/lean/fileProgress") {
            return;
        }
        if (!ObjectUtils.isEmpty(message.method) && !ObjectUtils.isEmpty(message.id) &&
            ObjectUtils.isEmpty(message.result) && ObjectUtils.isEmpty(message.error)) {
            this.writeLspMessage({ jsonrpc: "2.0", id: message.id, result: null });
            return;
        }
        if (!ObjectUtils.isEmpty(message.id)) {
            const pending = this.lspPending.get(message.id);
            if (ObjectUtils.isEmpty(pending))
                return;
            const request = pending;
            clearTimeout(request.timer);
            this.lspPending.delete(message.id);
            request.resolve(message);
        }
    }
    handleDiagnostics(params) {
        if (ObjectUtils.isEmpty(params) || typeof params !== "object")
            return;
        const data = params;
        if (ObjectUtils.isEmpty(data.uri))
            return;
        const diagnostics = Array.isArray(data.diagnostics)
            ? data.diagnostics.map((item) => this.toDiagnostic(item, data.uri)).filter((item) => !ObjectUtils.isEmpty(item))
            : [];
        this.diagnosticsByUri.set(data.uri, {
            version: data.version ?? 0,
            diagnostics
        });
    }
    toDiagnostic(value, uri) {
        if (ObjectUtils.isEmpty(value) || typeof value !== "object")
            return undefined;
        const item = value;
        if (typeof item.message !== "string")
            return undefined;
        const severity = item.severity === 2 ? "warning" : item.severity === 3 || item.severity === 4 ? "info" : "error";
        const start = item.range?.start;
        return {
            severity,
            filePath: fileURLToPath(uri),
            position: {
                line: (start?.line ?? 0) + 1,
                column: (start?.character ?? 0) + 1
            },
            message: item.message
        };
    }
    startJsonlProcess() {
        if (!ObjectUtils.isEmpty(this.process))
            return;
        const childProcess = spawn(this.config.command, this.config.args ?? [], {
            cwd: this.config.cwd,
            stdio: "pipe",
            windowsHide: true
        });
        this.process = childProcess;
        const reader = createInterface({ input: childProcess.stdout });
        reader.on("line", (line) => this.handleJsonlLine(line));
        childProcess.once("error", (error) => this.failServer(error));
        childProcess.once("exit", (code, signal) => {
            this.failServer(new Error("JSON 行 REPL 已退出（code=" + (code ?? "unknown") + ", signal=" + (signal ?? "none") + "）。"));
        });
    }
    async requestJsonl(request) {
        this.startJsonlProcess();
        if (ObjectUtils.isEmpty(this.process))
            throw new Error("JSON 行 REPL 进程未能启动。");
        return new Promise((resolveResponse, rejectResponse) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(request.id);
                rejectResponse(new Error("JSON 行 REPL 请求超时：" + request.method));
            }, this.config.requestTimeoutMs);
            this.pendingRequests.set(request.id, {
                resolve: resolveResponse,
                reject: rejectResponse,
                timer
            });
            this.process.stdin.write(JSON.stringify(request) + "\n", "utf8");
        });
    }
    handleJsonlLine(line) {
        try {
            const response = JSON.parse(line);
            const pending = this.pendingRequests.get(response.id);
            if (ObjectUtils.isEmpty(pending))
                return;
            const request = pending;
            clearTimeout(request.timer);
            this.pendingRequests.delete(response.id);
            request.resolve(response);
        }
        catch {
            // 忽略 JSON 行 REPL 的日志行。
        }
    }
    failServer(error) {
        this.process = undefined;
        this.serverReady = undefined;
        this.serverCwd = undefined;
        this.lakeEnvironment = undefined;
        this.lakeEnvironmentCwd = undefined;
        this.pendingBuildInspections.clear();
        this.documentVersions.clear();
        this.diagnosticsByUri.clear();
        this.rejectPending(error);
    }
    rejectPending(error) {
        for (const pending of this.lspPending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.lspPending.clear();
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
    isReadyFor(workspace) {
        return !ObjectUtils.isEmpty(this.process) &&
            !ObjectUtils.isEmpty(this.serverReady) &&
            this.serverCwd === workspace;
    }
    normalizeFileName(fileName) {
        const candidate = fileName ?? "Main.lean";
        if (candidate !== basename(candidate) || candidate.includes("/") || candidate.includes("\\")) {
            throw new Error("fileName 只能是当前验证会话中的 Lean 文件名。");
        }
        if (!candidate.endsWith(".lean"))
            throw new Error("fileName 必须以 .lean 结尾。");
        return candidate;
    }
    validateRequest(request) {
        if (ObjectUtils.isEmpty(request) || ObjectUtils.isEmpty(request.id) || ObjectUtils.isEmpty(request.method)) {
            throw new Error("Lean REPL 请求必须包含非空的 id 和 method。");
        }
    }
    validateCheckOptions(options) {
        if (ObjectUtils.isEmpty(options) || typeof options.source !== "string") {
            throw new Error("Lean 源码检查参数必须包含 source 字符串。");
        }
    }
}
/**
 * 从完整 Lean 源码提取按出现顺序去重的普通 import 模块名。
 * @param source Lean 源码。
 * @returns {string[]} 仅包含显式模块名的导入列表。
 */
export function extractLeanImports(source) {
    const imports = [];
    const seen = new Set();
    for (const line of source.split(/\r?\n/)) {
        const match = /^\s*import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\b/.exec(line);
        const moduleName = match?.[1];
        if (moduleName === undefined || seen.has(moduleName))
            continue;
        seen.add(moduleName);
        imports.push(moduleName);
    }
    return imports;
}
/**
 * 组合 Lake 环境与工作区构建目录中的 Lean 模块搜索根。
 * @param environment `lake env` 解析出的环境变量。
 * @param workspace Lake 工作区绝对路径。
 * @returns {string[]} 去重后的本地 `.olean` 搜索目录。
 */
function leanSearchPaths(environment, workspace) {
    const configured = environment.LEAN_PATH ?? "";
    const roots = configured.split(delimiter).map(item => item.trim()).filter(item => item !== "");
    roots.push(join(workspace, ".lake", "build", "lib", "lean"));
    return [...new Set(roots)];
}
/**
 * 判断某个模块在任一已解析搜索目录中是否已有编译产物。
 * @param moduleName Lean 模块名。
 * @param searchPaths 本地库根目录。
 * @returns {Promise<boolean>} 找到 `.olean` 时返回 true。
 */
async function hasModuleArtifact(moduleName, searchPaths) {
    const segments = moduleName.split(".");
    for (const root of searchPaths) {
        try {
            await access(join(root, ...segments) + ".olean");
            return true;
        }
        catch {
            // Continue searching the remaining local roots; this path is expected to be absent often.
        }
    }
    return false;
}
/**
 * 验证一个检查对象只能请求精确 Mathlib 子模块，且不存在其它缺失导入。
 * @param inspection 不可信的跨边界检查对象。
 * @returns {void} 合法时无返回值。
 */
function validateBuildInspection(inspection) {
    if (!Array.isArray(inspection?.buildTargets) || inspection.buildTargets.length === 0) {
        throw new Error("受控 Mathlib 构建必须包含至少一个精确模块目标。");
    }
    if (!Array.isArray(inspection.unbuildableImports) || inspection.unbuildableImports.length > 0) {
        throw new Error("存在无法受控构建的缺失导入，拒绝执行 Lake 构建。");
    }
    if (inspection.buildTargets.some(target => !MATHLIB_MODULE_PATTERN.test(target))) {
        throw new Error("受控 Mathlib 构建只接受精确 Mathlib 子模块名。");
    }
    if (new Set(inspection.buildTargets).size !== inspection.buildTargets.length) {
        throw new Error("受控 Mathlib 构建目标不能重复。");
    }
}
/**
 * 比较两个模块列表是否保持检查时的顺序和内容完全一致。
 * @param left 第一个模块列表。
 * @param right 第二个模块列表。
 * @returns {boolean} 逐项相等时返回 true。
 */
function sameStringList(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
/**
 * 合并并限制 Lake 的标准输出与标准错误，防止工具结果无限增长。
 * @param stdout Lake 标准输出。
 * @param stderr Lake 标准错误或控制信息。
 * @returns {string} 有界的可读输出。
 */
function mergeBuildOutput(stdout, stderr) {
    return [stdout, stderr].filter(value => value.trim() !== "").join("\n").slice(-MAX_BUILD_OUTPUT_CHARS);
}
/**
 * 将未知取消原因转换为标准 Error。
 * @param reason 取消原因。
 * @returns {Error} 可抛出的错误对象。
 */
function abortError(reason) {
    if (reason instanceof Error)
        return reason;
    if (typeof reason === "string" && reason !== "")
        return new Error(reason);
    return new Error("受控 Mathlib 构建已取消。");
}
/**
 * 等待一个已终止的子进程退出，但不会因异常进程无限阻塞后续验证。
 * @param child 已请求结束的 Lean 子进程。
 * @returns {Promise<void>} 进程退出或五秒安全等待期到达后返回。
 */
function waitForProcessExit(child) {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve();
    return new Promise(resolveExit => {
        const timer = setTimeout(resolveExit, 5000);
        child.once("exit", () => {
            clearTimeout(timer);
            resolveExit();
        });
    });
}
//# sourceMappingURL=lean-repl.js.map