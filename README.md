# lean4-harness-plugin

面向 `deepseek-harness` 的 Lean 4 插件基础实现。当前版本包含一个常驻 Lean LSP 验证服务、源码检查工具、JSON 行 REPL 兼容适配和 tactic state Markdown 格式化器。

## 设计架构

面向 GitHub 读者的架构说明见 [docs/architecture.md](docs/architecture.md)。其中明确区分当前已经实现的验证闭环与后续计划接入的 LeanCopilot 建议能力。

## 目录

```text
lean4-harness-plugin/
├── lean/                       # 可由 Lake 管理的 Lean 4 工作区
│   ├── lean-toolchain
│   ├── lakefile.lean
│   ├── Lean4Harness.lean
│   └── Main.lean
└── src/
    ├── index.ts                # 插件入口与工具注册
    ├── services/lean-repl.ts   # Lean 子进程与 JSON 行协议
    ├── utils/formatter.ts      # 诊断和 tactic state 格式化
    ├── utils/object-utils.ts   # 统一空值判断
    └── types/index.ts          # 公共协议类型
```

## 安装与构建

需要 Node.js 20 或更高版本，并确保 `lean`、`lake` 已加入 PATH。Windows 11 下可使用 PowerShell 执行：

```powershell
npm install
npm run build
npm test
Set-Location lean
lake build
lake env lean Main.lean
```

本项目不强制绑定某个未公开的 Harness SDK。宿主只需要提供以下两个注册函数：

```ts
import { createLean4Plugin } from "lean4-harness-plugin";

createLean4Plugin({
  registerService: (name, service) => container.register(name, service),
  registerTool: (tool) => harness.registerTool(tool)
}, {
  cwd: "./lean"
});
```

## 工具

`lean_check` 接收 `{ source, fileName?, cwd? }`，默认由一个常驻 `lean --server` LSP 服务验证，返回退出码、原始输出和结构化诊断。

服务首次启动时只执行一次 `lake env` 来读取当前 Lake 工作区的环境变量，然后直接启动 Lean。这样可以在 Windows 11 下避开 `lake env` 多层进程的 LSP 管道问题，同时仍复用 Lake 配置的本地 Mathlib 和依赖路径。服务使用固定的内部 `Validation.lean` 文档：第一次检查会加载现有的 Mathlib `.olean` 到内存，之后同一服务实例的所有检查均通过 LSP 增量更新该文档，不会为每次 `lean_check` 重新启动 Lean、重新计算 Lake 环境或重新加载导入。

`fileName` 是返回诊断时使用的逻辑文件名，不会创建多个 LSP 文档。单个服务实例内的检查会串行执行；服务调用 `stop()` 后终止进程并删除内部会话目录。独立插件服务默认单次超时为 120 秒，可通过 `requestTimeoutMs` 调整；本项目提供的隔离 Harness Web profile 已将前台验证期限配置为 600 秒，并将后台预热单独限制为 90 秒。临时验证文档以 `dependencyBuildMode: "never"` 打开，禁止其触发 Lake 依赖构建、远程缓存或下载。

`lean_repl_request` 在默认 LSP 模式下接收 `{ id, method, params? }` 并转发为 Lean LSP 请求；设置 `replMode: "jsonl"` 后，它会连接配置的 JSON 行 REPL 命令。普通 `lean.exe` 编译器不是 JSON 行 REPL，不应作为 JSON 行模式的 `command` 使用。

`lean_format_tactic_state` 接收 tactic state 文本，返回解析后的目标和 Markdown。

## 通用数学题规约 Skill

`skills/lean-problem-formalizer/SKILL.md` 是一个通用的 Harness Skill：它不附带或偏向任何固定数学题，而是把当前用户输入的自然语言题目整理为可交给 Lean 证明模型的任务说明。规约结果会明确变量类型、量词、定义、假设、结论、歧义处置、最小精确 Mathlib 导入约束，以及必须通过 `lean_check` 才能宣布完成的验证闭环。当用户同时给出原题图片和文本转写时，Skill 会先核对上标、分数、端点和量词等易被 OCR 损坏的符号；清晰原题与转写冲突时，以原题为准。

在本项目的隔离 Lean Web 环境中，执行下列命令一次即可部署 Skill。脚本只复制该 Skill；若运行期目录中已有不同内容的同名文件，会停止并要求显式 `-Force`，不会静默覆盖本地修改。

```powershell
.\scripts\Install-LeanProblemFormalizerSkill.ps1 -DshHome 'D:\lean4-harness-plugin\.dsh-lean4-test'
```

部署后，在新建的 Web 对话中直接说明“请使用 `lean-problem-formalizer` 将下面的数学题整理为 Lean 4 验证任务”，随后粘贴题目即可。也可以明确写出 `lean-problem-formalizer` 让模型加载此 Skill。Skill 只负责题意规约；模型生成源码后仍需由 `lean_check` 实际验证。

## Lean 工作区

lean/lean-toolchain 当前锁定到 leanprover/lean4:v4.26.0，并通过 lean/lakefile.lean 使用本机 D:/mathlib4 的 Mathlib 4。当前示例使用 Mathlib.Data.Nat.Basic，避免要求生成未缓存的 Mathlib 总入口。首次运行 Main.lean 前需要执行一次 lake build，以生成本地 Lean4Harness 库的 .olean 文件；已有匹配版本的 Lean 和 Mathlib 4 缓存时不会重新下载。

常驻服务不会运行 `lake update`、`lake clean` 或 `lake exe`，也不会修改或重新编译 `D:/mathlib4`。它只从 Lake 已解析的 `LEAN_PATH` 中读取 `D:/mathlib4/.lake/build/lib/lean` 下已有的 `.olean` 文件。

## deepseek-harness 集成中的按需 Mathlib 补齐

本项目在 `D:/deepseek-harness/deepseek-harness` 的实验性集成层提供 `lean_check`。它先检查源码的显式导入是否已有 `.olean`：缓存命中时直接交给常驻 Lean 服务；缺失精确 `Mathlib.*` 模块时，通过 Harness 的用户授权界面列出模块名称和精确构建目标。只有用户选择一次允许后，服务才会以固定参数运行等价于 `lake build <精确模块>` 的受控构建，随后重启常驻 Lean 服务并再次验证同一份源码。

模型不能自行调用 `lake build`、`lake update`、`lake clean` 或 `lake exe`，也不能修改 `D:/mathlib4`。用户拒绝、取消、授权通道不可用、缺失非 Mathlib 模块，或使用聚合 `import Mathlib` 时，插件只返回可读状态，不进行构建。Lean 编译结果仍是唯一的验证依据；LeanCopilot 目前未接入。

## 本地 Lean 环境

`lean/` 是本插件的本地 Lean 虚拟环境，由 Lean toolchain 和 Lake 工作区共同构成，不等同于 Python venv。若 `lean/lean-toolchain` 指定的版本已经通过 elan 安装，项目不会重新下载 Lean。

可以使用 `scripts/Initialize-LeanEnvironment.ps1` 初始化和检查环境。该脚本默认不联网，也不会自动下载依赖。Mathlib 必须是与当前 Lean 版本匹配的 Mathlib 4；本机的 Lean 3 Mathlib 不能直接用于本项目。
