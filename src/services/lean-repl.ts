import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ObjectUtils } from "../utils/object-utils.js";
import type {
  LeanCheckOptions,
  LeanCheckResult,
  LeanDiagnostic,
  LeanReplConfig,
  ReplRequest,
  ReplResponse
} from "../types/index.js";

type LspId = string | number;

interface LspMessage {
  jsonrpc: "2.0";
  id?: LspId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingMessage {
  resolve: (message: LspMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface VersionedDiagnostics {
  version: number;
  diagnostics: LeanDiagnostic[];
}

/**
 * 管理 Lean 4 常驻验证进程，并提供兼容 JSON 行 REPL 的请求能力。
 * 默认通过 Lake 环境直接启动 lean --server，并复用同一 LSP 文档的 Mathlib 导入状态。
 * @author ygw
 */
export class LeanReplService {
  private process?: ChildProcessWithoutNullStreams;
  private readonly pendingRequests = new Map<string, PendingMessage>();
  private readonly lspPending = new Map<LspId, PendingMessage>();
  private readonly diagnosticsByUri = new Map<string, VersionedDiagnostics>();
  private readonly documentVersions = new Map<string, number>();
  private readonly config: Required<Pick<
    LeanReplConfig,
    "command" | "requestTimeoutMs" | "leanCommand" | "lakeCommand" | "replMode" | "serverCommand"
  >> & LeanReplConfig;
  private lspBuffer = Buffer.alloc(0);
  private serverReady?: Promise<void>;
  private serverCwd?: string;
  private sessionDirectory?: string;
  private validationDocumentUri?: string;
  private validationDocumentPath?: string;
  private serverStderr = "";
  private checkQueue: Promise<void> = Promise.resolve();

  /**
   * 创建 Lean 验证服务。
   * @param config 常驻进程、工作目录和超时配置。
   * @returns {LeanReplService} 服务实例。
   */
  constructor(config: LeanReplConfig = {}) {
    this.config = {
      ...config,
      command: config.command ?? "lean-repl",
      requestTimeoutMs: config.requestTimeoutMs ?? 120000,
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
  start(): void {
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
  async request(request: ReplRequest): Promise<ReplResponse> {
    this.validateRequest(request);
    if (this.config.replMode === "jsonl") return this.requestJsonl(request);
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
  async checkSource(options: LeanCheckOptions): Promise<LeanCheckResult> {
    this.validateCheckOptions(options);
    const queuedCheck = this.checkQueue.then(() => this.runPersistentCheck(options));
    this.checkQueue = queuedCheck.then(() => undefined, () => undefined);
    return queuedCheck;
  }

  /**
   * 停止常驻进程并清理会话文件。
   * @returns {void} 无返回值。
   */
  stop(): void {
    const runningProcess = this.process;
    this.process = undefined;
    this.serverReady = undefined;
    this.serverCwd = undefined;
    if (!ObjectUtils.isEmpty(runningProcess)) {
      (runningProcess as ChildProcessWithoutNullStreams).kill();
    }
    this.rejectPending(new Error("Lean 验证服务已停止。"));
    this.documentVersions.clear();
    this.diagnosticsByUri.clear();
    this.validationDocumentUri = undefined;
    this.validationDocumentPath = undefined;
    const directory = this.sessionDirectory;
    this.sessionDirectory = undefined;
    if (!ObjectUtils.isEmpty(directory)) void rm(directory as string, { recursive: true, force: true });
  }

  /**
   * 判断验证进程是否正在运行。
   * @returns {boolean} 进程存在时返回 true。
   */
  isRunning(): boolean {
    return !ObjectUtils.isEmpty(this.process);
  }

  private async runPersistentCheck(options: LeanCheckOptions): Promise<LeanCheckResult> {
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
    } else {
      await this.sendLspNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "lean", version, text: options.source },
        // 验证会话只能复用已有 .olean，禁止临时文件触发 Lake 构建或远程缓存访问。
        dependencyBuildMode: "never"
      });
    }
    await this.waitForDiagnostics(uri, version);
    await new Promise<void>((resolveCompletion) => setImmediate(resolveCompletion));
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

  private async ensureServerReady(workspace: string): Promise<void> {
    if (this.isReadyFor(workspace)) {
      await this.serverReady;
      return;
    }
    if (!ObjectUtils.isEmpty(this.process)) this.stop();
    if (ObjectUtils.isEmpty(this.sessionDirectory)) {
      this.sessionDirectory = await mkdtemp(join(workspace, "LeanHarnessSession_"));
    }
    this.serverCwd = workspace;
    this.lspBuffer = Buffer.alloc(0);
    this.serverStderr = "";
    // Lake 只负责计算环境变量；直接启动 Lean 可以避免 Windows 下多层子进程管道不透传 LSP 数据。
    const lakeEnvironment = await this.loadLakeEnvironment(workspace);
    const childProcess = spawn(this.config.serverCommand, this.config.serverArgs ?? ["--server"], {
      cwd: workspace,
      env: lakeEnvironment,
      stdio: "pipe",
      windowsHide: true
    });
    this.process = childProcess;
    childProcess.stdout.on("data", (chunk: Buffer) => this.handleLspData(chunk));
    childProcess.stderr.on("data", (chunk: Buffer) => {
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
  private getValidationDocument(): { path: string; uri: string } {
    if (!ObjectUtils.isEmpty(this.validationDocumentPath) && !ObjectUtils.isEmpty(this.validationDocumentUri)) {
      return { path: this.validationDocumentPath as string, uri: this.validationDocumentUri as string };
    }
    if (ObjectUtils.isEmpty(this.sessionDirectory)) {
      throw new Error("Lean 验证会话目录未初始化。");
    }
    const filePath = join(this.sessionDirectory as string, "Validation.lean");
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
  private async loadLakeEnvironment(workspace: string): Promise<NodeJS.ProcessEnv> {
    const environmentProcess = spawn(this.config.lakeCommand, ["env"], {
      cwd: workspace,
      stdio: "pipe",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    return new Promise<NodeJS.ProcessEnv>((resolveEnvironment, rejectEnvironment) => {
      let settled = false;
      environmentProcess.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      environmentProcess.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      environmentProcess.once("error", (error) => {
        if (settled) return;
        settled = true;
        rejectEnvironment(new Error("读取 Lake 环境失败：" + error.message));
      });
      environmentProcess.once("exit", (code, signal) => {
        if (settled) return;
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
   * 将 Lake 的 NAME=VALUE 输出合并到当前进程环境。
   * @param output Lake 环境变量原文。
   * @returns {NodeJS.ProcessEnv} Lean 服务启动环境。
   */
  private parseEnvironmentOutput(output: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const line of output.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim();
      if (ObjectUtils.isEmpty(name)) continue;
      environment[name] = line.slice(separator + 1);
    }
    return environment;
  }

  private async initializeServer(workspace: string): Promise<void> {
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
        const initializeError = response.error as { code: number; message: string; data?: unknown };
        throw new Error("Lean server 初始化失败：" + initializeError.message);
      }
      await this.sendLspNotification("initialized", {});
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private sendLspRequest(method: string, params: unknown, requestId?: string): Promise<LspMessage> {
    if (ObjectUtils.isEmpty(this.process)) throw new Error("Lean server 进程未启动。");
    const id = requestId ?? randomUUID();
    return new Promise<LspMessage>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.lspPending.delete(id);
        rejectResponse(new Error("Lean LSP 请求超时：" + method));
      }, this.config.requestTimeoutMs);
      this.lspPending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      this.writeLspMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async sendLspNotification(method: string, params: unknown): Promise<void> {
    if (ObjectUtils.isEmpty(this.process)) throw new Error("Lean server 进程未启动。");
    this.writeLspMessage({ jsonrpc: "2.0", method, params });
  }

  /**
   * 等待 Lean 为指定文档版本完成所有诊断。
   * @param uri 已打开 Lean 文档的 URI。
   * @param version 需要完成的文档版本。
   * @returns {Promise<void>} Lean 返回同步响应后完成。
   */
  private async waitForDiagnostics(uri: string, version: number): Promise<void> {
    const response = await this.sendLspRequest("textDocument/waitForDiagnostics", { uri, version });
    if (!ObjectUtils.isEmpty(response.error)) {
      const error = response.error as { message: string };
      throw new Error("Lean 等待诊断失败：" + error.message);
    }
  }

  private writeLspMessage(message: LspMessage): void {
    if (ObjectUtils.isEmpty(this.process)) throw new Error("Lean server 进程未启动。");
    const payload = JSON.stringify(message);
    const frame = "Content-Length: " + Buffer.byteLength(payload, "utf8") + "\r\n\r\n" + payload;
    (this.process as ChildProcessWithoutNullStreams).stdin.write(frame, "utf8");
  }

  private handleLspData(chunk: Buffer): void {
    this.lspBuffer = Buffer.concat([this.lspBuffer, chunk]);
    const separator = Buffer.from("\r\n\r\n");
    while (true) {
      const headerEnd = this.lspBuffer.indexOf(separator);
      if (headerEnd < 0) return;
      const header = this.lspBuffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (ObjectUtils.isEmpty(lengthMatch)) {
        this.lspBuffer = this.lspBuffer.subarray(headerEnd + separator.length);
        continue;
      }
      const contentLength = Number((lengthMatch as RegExpExecArray)[1]);
      const contentStart = headerEnd + separator.length;
      if (this.lspBuffer.length < contentStart + contentLength) return;
      const body = this.lspBuffer.subarray(contentStart, contentStart + contentLength).toString("utf8");
      this.lspBuffer = this.lspBuffer.subarray(contentStart + contentLength);
      try {
        this.handleLspMessage(JSON.parse(body) as LspMessage);
      } catch {
        // 忽略不完整或非 JSON 的 server 输出，保持协议解析器可继续工作。
      }
    }
  }

  private handleLspMessage(message: LspMessage): void {
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
      const pending = this.lspPending.get(message.id as LspId);
      if (ObjectUtils.isEmpty(pending)) return;
      const request = pending as PendingMessage;
      clearTimeout(request.timer);
      this.lspPending.delete(message.id as LspId);
      request.resolve(message);
    }
  }

  private handleDiagnostics(params: unknown): void {
    if (ObjectUtils.isEmpty(params) || typeof params !== "object") return;
    const data = params as { uri?: string; version?: number; diagnostics?: unknown[] };
    if (ObjectUtils.isEmpty(data.uri)) return;
    const diagnostics = Array.isArray(data.diagnostics)
      ? data.diagnostics.map((item) => this.toDiagnostic(item, data.uri as string)).filter((item): item is LeanDiagnostic => !ObjectUtils.isEmpty(item))
      : [];
    this.diagnosticsByUri.set(data.uri as string, {
      version: data.version ?? 0,
      diagnostics
    });
  }

  private toDiagnostic(value: unknown, uri: string): LeanDiagnostic | undefined {
    if (ObjectUtils.isEmpty(value) || typeof value !== "object") return undefined;
    const item = value as {
      severity?: number;
      message?: string;
      range?: { start?: { line?: number; character?: number } };
    };
    if (typeof item.message !== "string") return undefined;
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

  private startJsonlProcess(): void {
    if (!ObjectUtils.isEmpty(this.process)) return;
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

  private async requestJsonl(request: ReplRequest): Promise<ReplResponse> {
    this.startJsonlProcess();
    if (ObjectUtils.isEmpty(this.process)) throw new Error("JSON 行 REPL 进程未能启动。");
    return new Promise<ReplResponse>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        rejectResponse(new Error("JSON 行 REPL 请求超时：" + request.method));
      }, this.config.requestTimeoutMs);
      this.pendingRequests.set(request.id, {
        resolve: resolveResponse as (message: LspMessage) => void,
        reject: rejectResponse,
        timer
      });
      (this.process as ChildProcessWithoutNullStreams).stdin.write(JSON.stringify(request) + "\n", "utf8");
    });
  }

  private handleJsonlLine(line: string): void {
    try {
      const response = JSON.parse(line) as ReplResponse;
      const pending = this.pendingRequests.get(response.id);
      if (ObjectUtils.isEmpty(pending)) return;
      const request = pending as PendingMessage;
      clearTimeout(request.timer);
      this.pendingRequests.delete(response.id);
      request.resolve(response as unknown as LspMessage);
    } catch {
      // 忽略 JSON 行 REPL 的日志行。
    }
  }

  private failServer(error: Error): void {
    this.process = undefined;
    this.serverReady = undefined;
    this.serverCwd = undefined;
    this.documentVersions.clear();
    this.diagnosticsByUri.clear();
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
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

  private isReadyFor(workspace: string): boolean {
    return !ObjectUtils.isEmpty(this.process) &&
      !ObjectUtils.isEmpty(this.serverReady) &&
      this.serverCwd === workspace;
  }

  private normalizeFileName(fileName?: string): string {
    const candidate = fileName ?? "Main.lean";
    if (candidate !== basename(candidate) || candidate.includes("/") || candidate.includes("\\")) {
      throw new Error("fileName 只能是当前验证会话中的 Lean 文件名。");
    }
    if (!candidate.endsWith(".lean")) throw new Error("fileName 必须以 .lean 结尾。");
    return candidate;
  }

  private validateRequest(request: ReplRequest): void {
    if (ObjectUtils.isEmpty(request) || ObjectUtils.isEmpty(request.id) || ObjectUtils.isEmpty(request.method)) {
      throw new Error("Lean REPL 请求必须包含非空的 id 和 method。");
    }
  }

  private validateCheckOptions(options: LeanCheckOptions): void {
    if (ObjectUtils.isEmpty(options) || typeof options.source !== "string") {
      throw new Error("Lean 源码检查参数必须包含 source 字符串。");
    }
  }
}
