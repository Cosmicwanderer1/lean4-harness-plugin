import { LeanReplService } from "./services/lean-repl.js";
import type { HarnessPluginContext, LeanHarnessPluginConfig, HarnessTool } from "./types/index.js";
/** 插件服务注册名称。 */
export declare const LEAN_REPL_SERVICE_NAME = "lean4.repl";
/**
 * 创建并注册 Lean 4 Harness 插件。
 * @param context deepseek-harness 或 Cordis 的最小注册上下文。
 * @param config 插件配置。
 * @returns {LeanReplService} 已注册的 Lean 服务实例。
 */
export declare function createLean4Plugin(context: HarnessPluginContext, config?: LeanHarnessPluginConfig): LeanReplService;
/**
 * 创建 Lean 相关 Harness 工具定义。
 * @param service Lean REPL 服务。
 * @returns {HarnessTool[]} 工具定义列表。
 */
export declare function createLeanTools(service: LeanReplService): HarnessTool[];
/**
 * 创建不依赖宿主注册器的默认插件对象，便于单元测试和手动集成。
 * @param config 插件配置。
 * @returns {object} 包含服务、工具和注册方法的插件对象。
 */
export declare function createStandalonePlugin(config?: LeanHarnessPluginConfig): {
    service: LeanReplService;
    tools: HarnessTool[];
    register: (context: HarnessPluginContext) => LeanReplService;
};
export { LeanFormatter } from "./utils/formatter.js";
export { LeanReplService } from "./services/lean-repl.js";
export type * from "./types/index.js";
//# sourceMappingURL=index.d.ts.map