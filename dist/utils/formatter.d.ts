import type { LeanDiagnostic, TacticState } from "../types/index.js";
/**
 * 将 Lean 的文本诊断和 tactic 状态转换为 Harness 易消费的结构。
 * @author ygw
 */
export declare class LeanFormatter {
    /**
     * 解析 Lean 编译器的标准错误文本。
     * @param output Lean 进程输出的文本。
     * @returns {LeanDiagnostic[]} 结构化诊断列表。
     */
    static parseDiagnostics(output: string): LeanDiagnostic[];
    /**
     * 解析常见的 Lean tactic 状态文本。
     * @param rawState Lean InfoView 或 REPL 返回的原始状态。
     * @returns {TacticState} 解析后的目标列表和原文。
     */
    static parseTacticState(rawState: string): TacticState;
    /**
     * 将 tactic 状态渲染为 Markdown。
     * @param state 已解析的 tactic 状态。
     * @returns {string} Markdown 文本。
     */
    static formatTacticStateMarkdown(state: TacticState): string;
    /**
     * 将诊断列表渲染为紧凑 Markdown。
     * @param diagnostics 结构化诊断列表。
     * @returns {string} Markdown 文本。
     */
    static formatDiagnosticsMarkdown(diagnostics: LeanDiagnostic[]): string;
}
//# sourceMappingURL=formatter.d.ts.map