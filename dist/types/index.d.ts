/**
 * Lean 4 插件的公共协议、配置和宿主适配类型。
 * @author ygw
 */
/** Lean 源码位置。 */
export interface LeanPosition {
    /** 行号，从 1 开始。 */
    line: number;
    /** 列号，从 1 开始。 */
    column: number;
}
/** Lean 编译器或 REPL 返回的诊断信息。 */
export interface LeanDiagnostic {
    /** 诊断级别。 */
    severity: "error" | "warning" | "info";
    /** 可选的源文件路径。 */
    filePath?: string;
    /** 可选的源码位置。 */
    position?: LeanPosition;
    /** 面向用户的消息。 */
    message: string;
}
/** 一个 Lean tactic 状态中的目标。 */
export interface TacticGoal {
    /** case 名称；匿名目标为空字符串。 */
    caseName: string;
    /** 局部上下文文本。 */
    context: string[];
    /** 待证明的目标表达式。 */
    target: string;
}
/** 可供 Harness 展示和后处理的 tactic 状态。 */
export interface TacticState {
    /** 解析出的目标列表。 */
    goals: TacticGoal[];
    /** 无法归类的原始文本。 */
    raw: string;
}
/** JSON 行 REPL 请求。 */
export interface ReplRequest {
    /** 请求唯一标识。 */
    id: string;
    /** 操作名称，由具体 REPL 实现定义。 */
    method: string;
    /** 操作参数。 */
    params?: Record<string, unknown>;
}
/** JSON 行 REPL 响应。 */
export interface ReplResponse {
    /** 对应请求的唯一标识。 */
    id: string;
    /** 成功时的返回值。 */
    result?: unknown;
    /** 失败时的结构化错误。 */
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
/** Lean 进程服务配置。 */
export interface LeanReplConfig {
    /** 自定义 JSON 行 REPL 命令，仅在 replMode 为 jsonl 时使用。 */
    command?: string;
    /** 自定义 JSON 行 REPL 参数。 */
    args?: string[];
    /** 进程工作目录。 */
    cwd?: string;
    /** 单次请求超时毫秒数，默认 120000，覆盖首次加载本地 Mathlib 产物的时间。 */
    requestTimeoutMs?: number;
    /** 用户授权后构建精确缺失 Mathlib 模块的最大时长，默认 600000。 */
    buildTimeoutMs?: number;
    /** Lean 编译器命令，默认使用 PATH 中的 lean。 */
    leanCommand?: string;
    /** Lake 命令，用于读取工作区环境变量，默认使用 PATH 中的 lake。 */
    lakeCommand?: string;
    /** 验证进程模式，默认使用基于 Lake 的持久化 LSP 服务。 */
    replMode?: "lsp" | "jsonl";
    /** LSP 服务启动命令，默认使用 leanCommand 指定的 Lean。 */
    serverCommand?: string;
    /** LSP 服务参数，默认是 --server。 */
    serverArgs?: string[];
}
/** 一次源码导入与本地 `.olean` 缓存的核验结果。 */
export interface LeanImportInspection {
    /** 源码中按出现顺序提取且去重的导入模块。 */
    imports: string[];
    /** 已在当前 Lake/Lean 搜索路径中找到 `.olean` 的模块。 */
    cachedImports: string[];
    /** 没有找到 `.olean` 的模块。 */
    missingImports: string[];
    /** 可在获得一次明确授权后构建的精确 `Mathlib.*` 模块。 */
    buildTargets: string[];
    /** 不属于受控构建边界的缺失模块。 */
    unbuildableImports: string[];
}
/** 一次用户明确授权后的受控 Lake 构建结果。 */
export interface LeanImportBuildResult {
    /** 实际传递给 Lake 的精确 Mathlib 模块名。 */
    buildTargets: string[];
    /** Lake 是否以零退出码完成。 */
    success: boolean;
    /** 截断后的标准输出、标准错误或基础设施错误。 */
    output: string;
    /** Lake 正常退出时的退出码。 */
    exitCode?: number;
}
/** 源码检查参数。 */
export interface LeanCheckOptions {
    /** 源码内容。 */
    source: string;
    /** 逻辑文件名，用于诊断定位；同一服务内部始终复用一个常驻验证文档。 */
    fileName?: string;
    /** 检查时使用的工作目录。 */
    cwd?: string;
}
/** Lean 源码检查结果。 */
export interface LeanCheckResult {
    /** 进程退出码。 */
    exitCode: number;
    /** 是否通过检查。 */
    success: boolean;
    /** 标准输出原文。 */
    stdout: string;
    /** 标准错误原文。 */
    stderr: string;
    /** 解析后的诊断列表。 */
    diagnostics: LeanDiagnostic[];
    /** 本次检查是否复用了已经运行的验证进程。 */
    reusedProcess: boolean;
    /** 实际使用的 Lake 工作目录。 */
    workspace?: string;
}
/** Harness 工具定义。 */
export interface HarnessTool {
    /** 工具名称。 */
    name: string;
    /** 工具用途描述。 */
    description: string;
    /** 工具执行函数。 */
    execute: (input: unknown) => Promise<unknown>;
}
/** 宿主服务与工具注册能力的最小接口。 */
export interface HarnessPluginContext {
    /** 注册一个可注入的服务实例。 */
    registerService: (name: string, service: unknown) => void;
    /** 注册一个 Harness 工具。 */
    registerTool: (tool: HarnessTool) => void;
}
/** 插件配置。 */
export interface LeanHarnessPluginConfig extends LeanReplConfig {
    /** 是否注册工具，默认 true。 */
    registerTools?: boolean;
}
//# sourceMappingURL=index.d.ts.map