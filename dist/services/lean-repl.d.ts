import type { LeanCheckOptions, LeanCheckResult, LeanImportBuildResult, LeanImportInspection, LeanReplConfig, ReplRequest, ReplResponse } from "../types/index.js";
/**
 * 管理 Lean 4 常驻验证进程，并提供兼容 JSON 行 REPL 的请求能力。
 * 默认通过 Lake 环境直接启动 lean --server，并复用同一 LSP 文档的 Mathlib 导入状态。
 * @author ygw
 */
export declare class LeanReplService {
    private process?;
    private readonly pendingRequests;
    private readonly lspPending;
    private readonly diagnosticsByUri;
    private readonly documentVersions;
    private readonly config;
    private lspBuffer;
    private serverReady?;
    private serverCwd?;
    private sessionDirectory?;
    private validationDocumentUri?;
    private validationDocumentPath?;
    private serverStderr;
    private checkQueue;
    private lakeEnvironment?;
    private lakeEnvironmentCwd?;
    private readonly pendingBuildInspections;
    /**
     * 创建 Lean 验证服务。
     * @param config 常驻进程、工作目录和超时配置。
     * @returns {LeanReplService} 服务实例。
     */
    constructor(config?: LeanReplConfig);
    /**
     * 预热常驻验证进程。
     * @returns {void} 启动操作在后台执行。
     */
    start(): void;
    /**
     * 向 JSON 行 REPL 或 LSP 服务发送一个请求。
     * @param request REPL 请求对象。
     * @returns {Promise<ReplResponse>} 对应的服务响应。
     */
    request(request: ReplRequest): Promise<ReplResponse>;
    /**
     * 在常驻 Lake/Lean 服务中检查源码。
     * @param options 源码、临时文件名和工作目录。
     * @returns {Promise<LeanCheckResult>} 检查结果和结构化诊断。
     */
    checkSource(options: LeanCheckOptions): Promise<LeanCheckResult>;
    /**
     * 检查 Lean 源码的精确导入是否可由当前本地 `.olean` 缓存满足。
     * 该方法只读取 Lake 环境和本地文件系统，绝不触发构建、缓存下载或网络访问。
     * @param source 完整 Lean 源码。
     * @param cwd 可选的 Lake 工作区目录。
     * @returns {Promise<LeanImportInspection>} 结构化的缓存命中、缺失模块和最小可授权构建目标。
     */
    inspectImports(source: string, cwd?: string): Promise<LeanImportInspection>;
    /**
     * 构建刚刚由本服务检查并经调用方授权的精确 Mathlib 模块。
     * @param inspection 由同一服务的 {@link inspectImports} 返回且尚未使用的检查对象。
     * @param signal 可选的调用取消信号。
     * @returns {Promise<LeanImportBuildResult>} 受限 Lake 构建结果。
     */
    buildMissingImports(inspection: LeanImportInspection, signal?: AbortSignal): Promise<LeanImportBuildResult>;
    /**
     * 停止常驻进程并清理会话文件。
     * @returns {void} 无返回值。
     */
    stop(): void;
    /**
     * 判断验证进程是否正在运行。
     * @returns {boolean} 进程存在时返回 true。
     */
    isRunning(): boolean;
    /**
     * 在验证队列中执行一份已授权的精确模块构建。
     * @param workspace Lake 工作区绝对路径。
     * @param inspection 已校验的精确模块清单。
     * @param signal 可选的调用取消信号。
     * @returns {Promise<LeanImportBuildResult>} Lake 的受限构建结果。
     */
    private runMissingImportBuild;
    /**
     * 关闭现有 Lean 读取进程并等待其释放可能被 Lake 替换的 `.olean` 句柄。
     * @returns {Promise<void>} 进程退出或有限等待期结束后返回。
     */
    private stopServerForArtifactChange;
    /**
     * Run Lake with a fixed argument array and bounded captured output.
     * @param workspace Lake 工作区绝对路径。
     * @param environment 已解析的 Lake 环境变量。
     * @param targets 已授权的精确 Mathlib 模块名。
     * @param signal 可选的调用取消信号。
     * @returns {Promise<LeanImportBuildResult>} 不泄露环境变量的构建摘要。
     */
    private runLakeBuild;
    private runPersistentCheck;
    private ensureServerReady;
    /**
     * 获取本服务唯一的常驻验证文档。
     * @returns {{ path: string; uri: string }} LSP 实际使用的文件路径与 URI。
     */
    private getValidationDocument;
    /**
     * 读取 Lake 为当前工作区计算的环境变量。
     * @param workspace Lake 工作区绝对路径。
     * @returns {Promise<NodeJS.ProcessEnv>} 可传递给 Lean 服务进程的环境变量。
     */
    private loadLakeEnvironment;
    /**
     * 缓存同一 Lake 工作区已解析的环境，避免导入检查与常驻服务重复执行 `lake env`。
     * @param workspace Lake 工作区绝对路径。
     * @returns {Promise<NodeJS.ProcessEnv>} 当前工作区可复用的环境变量。
     */
    private ensureLakeEnvironment;
    /**
     * 将 Lake 的 NAME=VALUE 输出合并到当前进程环境。
     * @param output Lake 环境变量原文。
     * @returns {NodeJS.ProcessEnv} Lean 服务启动环境。
     */
    private parseEnvironmentOutput;
    private initializeServer;
    private sendLspRequest;
    private sendLspNotification;
    /**
     * 等待 Lean 为指定文档版本完成所有诊断。
     * @param uri 已打开 Lean 文档的 URI。
     * @param version 需要完成的文档版本。
     * @returns {Promise<void>} Lean 返回同步响应后完成。
     */
    private waitForDiagnostics;
    private writeLspMessage;
    private handleLspData;
    private handleLspMessage;
    private handleDiagnostics;
    private toDiagnostic;
    private startJsonlProcess;
    private requestJsonl;
    private handleJsonlLine;
    private failServer;
    private rejectPending;
    private isReadyFor;
    private normalizeFileName;
    private validateRequest;
    private validateCheckOptions;
}
/**
 * 从完整 Lean 源码提取按出现顺序去重的普通 import 模块名。
 * @param source Lean 源码。
 * @returns {string[]} 仅包含显式模块名的导入列表。
 */
export declare function extractLeanImports(source: string): string[];
//# sourceMappingURL=lean-repl.d.ts.map