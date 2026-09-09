import { ObjectUtils } from "./object-utils.js";
import type { LeanDiagnostic, TacticGoal, TacticState } from "../types/index.js";

/**
 * 将 Lean 的文本诊断和 tactic 状态转换为 Harness 易消费的结构。
 * @author ygw
 */
export class LeanFormatter {
  /**
   * 解析 Lean 编译器的标准错误文本。
   * @param output Lean 进程输出的文本。
   * @returns {LeanDiagnostic[]} 结构化诊断列表。
   */
  static parseDiagnostics(output: string): LeanDiagnostic[] {
    if (ObjectUtils.isEmpty(output)) return [];
    const diagnostics: LeanDiagnostic[] = [];
    const pattern = /^(.+?):(\d+):(\d+):\s*(error|warning|info):\s*(.*)$/gm;
    for (const match of output.matchAll(pattern)) {
      diagnostics.push({
        filePath: match[1],
        position: { line: Number(match[2]), column: Number(match[3]) },
        severity: match[4] as LeanDiagnostic["severity"],
        message: match[5].trim()
      });
    }
    return diagnostics;
  }

  /**
   * 解析常见的 Lean tactic 状态文本。
   * @param rawState Lean InfoView 或 REPL 返回的原始状态。
   * @returns {TacticState} 解析后的目标列表和原文。
   */
  static parseTacticState(rawState: string): TacticState {
    if (ObjectUtils.isEmpty(rawState)) return { goals: [], raw: rawState };
    const lines = rawState.split(/\r?\n/);
    const goals: TacticGoal[] = [];
    let current: TacticGoal | undefined;
    let context: string[] = [];

    const finishGoal = (): void => {
      if (ObjectUtils.isEmpty(current)) return;
      const goal = current as TacticGoal;
      goal.context = context;
      goals.push(goal);
      current = undefined;
      context = [];
    };

    for (const line of lines) {
      const caseMatch = /^case\s+(.+)\s*$/.exec(line.trim());
      if (caseMatch) {
        finishGoal();
        current = { caseName: caseMatch[1], context: [], target: "" };
        continue;
      }
      const targetIndex = line.indexOf("⊢");
      if (targetIndex >= 0) {
        if (ObjectUtils.isEmpty(current)) current = { caseName: "", context: [], target: "" };
        const goal = current as TacticGoal;
        goal.target = line.slice(targetIndex + 1).trim();
        continue;
      }
      if (!ObjectUtils.isEmpty(current) && line.trim() !== "") context.push(line.trim());
    }
    finishGoal();
    return { goals, raw: rawState };
  }

  /**
   * 将 tactic 状态渲染为 Markdown。
   * @param state 已解析的 tactic 状态。
   * @returns {string} Markdown 文本。
   */
  static formatTacticStateMarkdown(state: TacticState): string {
    if (state.goals.length === 0) return "已完成证明，当前没有待证明目标。";
    return state.goals.map((goal, index) => {
      const heading = goal.caseName ? `### 目标 ${index + 1}（${goal.caseName}）` : `### 目标 ${index + 1}`;
      const context = goal.context.length > 0 ? `\n${goal.context.map((item) => `- \`${item}\``).join("\n")}` : "\n- 无局部上下文";
      return `${heading}\n\n**上下文**${context}\n\n**待证明**\n\n\`\`\`lean\n⊢ ${goal.target}\n\`\`\``;
    }).join("\n\n");
  }

  /**
   * 将诊断列表渲染为紧凑 Markdown。
   * @param diagnostics 结构化诊断列表。
   * @returns {string} Markdown 文本。
   */
  static formatDiagnosticsMarkdown(diagnostics: LeanDiagnostic[]): string {
    if (diagnostics.length === 0) return "未发现诊断信息。";
    return diagnostics.map((diagnostic) => {
      const location = diagnostic.filePath && diagnostic.position
        ? `（${diagnostic.filePath}:${diagnostic.position.line}:${diagnostic.position.column}）`
        : "";
      return `- **${diagnostic.severity}**${location}：${diagnostic.message}`;
    }).join("\n");
  }
}
