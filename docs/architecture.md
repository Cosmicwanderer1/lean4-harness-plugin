# Lean 4 Harness Plugin 架构说明

> 作者：ygw
> 适用环境：Windows 11、deepseek-harness、本地 Lean 4.26.0、Mathlib 4
> 状态：当前实现与后续演进设计均明确标注。

## 目标

本插件让 `deepseek-harness` 中的模型能够获得 Lean 4 的可信反馈：模型生成源码，Lean 编译器/LSP 给出唯一权威的验证结果。插件不会因代码“看起来正确”而把证明标记为成功。

```mermaid
flowchart TB
  User[用户] --> Web[deepseek-harness Web UI]
  Web --> Agent[模型 Agent]

  subgraph Formalization[题目规约层：已实现]
    Skill[lean-problem-formalizer Skill]
  end

  Agent --> Skill
  Agent -->|完整 Lean 源码| Check[lean_check]

  subgraph Guard[导入与安全控制层：已实现]
    Check --> Inspect[精确 import 与 .olean 检查]
    Inspect -->|命中| Verify
    Inspect -->|缺失精确 Mathlib 模块| Approval[用户一次授权]
    Approval -->|允许| BoundedBuild[仅构建授权的精确模块]
    Approval -->|拒绝或取消| Stop[返回可读状态]
    BoundedBuild --> Verify
    GuardTool[最终工具守卫] -.阻止.-> DirectLake[模型直接执行 Lake]
    GuardTool -.阻止.-> WriteMathlib[模型修改 Mathlib]
  end

  subgraph Verification[常驻验证层：已实现]
    Verify[Lean4Local Provider] --> Queue[串行请求队列]
    Queue --> LSP[常驻 lean --server]
    LSP --> Document[固定 Validation.lean 文档]
    Document --> Diagnostics[结构化诊断]
  end

  subgraph Local[本地可复现环境：已实现]
    Workspace[lean/ Lake 工作区]
    Toolchain[Lean 4.26.0]
    Cache[D:/mathlib4 的 .olean 缓存]
  end

  Verify --> Workspace
  Verify --> Cache
  Diagnostics --> Check
  Check --> Agent

  subgraph Future[后续演进：尚未接入]
    Copilot[LeanCopilot 建议适配器]
    Repair[有上限的建议 -> 再验证循环]
    Copilot --> Repair
  end

  Diagnostics -.提供上下文.-> Copilot
  Repair -.候选必须再验证.-> Check
```

## 当前验证闭环

1. 用户输入数学题，模型可先借助 `lean-problem-formalizer` 规约变量、量词、定义、假设和结论。
2. 模型生成完整 Lean 4 源码，并调用 `lean_check`。
3. 插件检查源码中的精确 `import` 是否在本地已有对应 `.olean`。
4. 缓存命中时，源码会提交给同一个常驻 Lean LSP 进程的固定内部文档，以增量方式获得诊断。
5. Lean 验证通过才返回 `verified` 或 `verified_with_warnings`；失败则返回结构化的文件、行、列、严重级别和原始诊断，供模型修改后再次验证。

正常验证不会重新下载或全量构建 Mathlib。常驻服务通过已经解析的 Lake 环境读取本地 `.olean`，并且内部文档使用 `dependencyBuildMode: "never"`，阻止临时验证触发依赖构建、远程缓存访问或下载。

## 缺失模块与授权边界

只有缺少明确的 `Mathlib.*` 子模块时，Bundle 才会向用户展示模块和精确构建目标，并请求一次授权。用户批准后，只允许构建该授权目标和 Lake 的必要依赖，服务重启后再验证原始源码。

以下情况均不会触发构建：用户拒绝或取消、授权通道不可用、缺失的不是 Mathlib 子模块，以及使用顶层聚合导入 `import Mathlib`。模型也被最终工具守卫阻止直接运行 `lake build`、`lake update`、`lake clean`、`lake exe` 或修改 `D:/mathlib4`。

## 组件职责

| 组件 | 当前状态 | 职责 |
| --- | --- | --- |
| `lean-problem-formalizer` | 已实现 | 忠实规约自然语言题目，核对图片、OCR 与文本中的符号差异。 |
| `lean_check` | 已实现 | 调用导入检查与常驻验证服务，返回稳定状态及结构化诊断。 |
| `LeanReplService` | 已实现 | 管理 Lean 子进程、超时、请求关联、LSP/JSON 行兼容模式和会话清理。 |
| `LeanFormatter` | 已实现 | 格式化诊断与 tactic state，输出便于模型继续处理的 Markdown。 |
| Mathlib 访问控制 | 已实现 | 优先复用本地 `.olean`，对缺失的精确模块执行用户授权的最小构建。 |
| LeanCopilot 适配器 | 尚未接入 | 未来只提供候选 tactic 或修正建议，不能替代 Lean 验证。 |
| 自动修正闭环 | 尚未接入 | 未来在次数、时间、成本与人工关闭开关的限制下执行。 |

## LeanCopilot 的后续原则

LeanCopilot 输出始终只是候选建议。后续接入将通过独立的建议提供者接口，与 `lean_check` 解耦；候选会在独立会话中重新验证，只有通过 Lean 的候选才可能标记为可靠结果。建议服务不可用、超时或返回空内容时，基础验证能力仍可单独工作。

## 本地与 GitHub 的边界

- GitHub 仓库保存可复用的源码、配置、脚本、README、测试、Skill 和本文件。
- `.specstory/` 保存本机开发过程、会话记录和工作草稿，已被 `.gitignore` 排除，不会上传。
- `node_modules/`、`dist/`、`lean/.lake/` 和临时 Lean 验证会话也只保留在本机。

## DSH Bundle 接入方式

本仓库也是一个可安装的 DSH Bundle：`package.json` 的 `dsh.bundle` 指向 `cordis.patch.yml`，该配置层加载 `lean4-harness-plugin/dsh`。此入口只承担 Cordis 生命周期、模型工具注册和最终 Mathlib 工具守卫；它直接复用同一仓库 `dist/` 中的 `LeanReplService` 与 `LeanFormatter`，避免在 `deepseek-harness` 源码目录维护第二份验证核心。适配层通过宿主已经注入的 `ctx.tools` 注册标准 JSON Schema 工具，不将 `@deepseek-ai/dsh-tools` 作为独立发行依赖，避免 Git 安装时出现内部包下载、授权或版本漂移问题。

开发时使用 `dsh plugin --profile <名称> add link:<插件绝对路径>`。DSH 将本地仓库链接到该 Profile 的依赖目录，并应用 Bundle 的 patch；启动该 Profile 后，模型即可获得 `lean_check`、`lean_repl_request` 与 `lean_format_tactic_state`。默认在首次 `lean_check` 时启动 Lean，之后保留同一常驻 LSP 文档；需要把首个导入成本转移到 Profile 启动阶段时，才显式设置 `prewarm: true`。源码改动后重新构建插件并重启 DSH 即可生效；只有 Bundle 元数据或 patch 改动才需要移除并重新添加。分发时也可使用 `github:Cosmicwanderer1/lean4-harness-plugin#<已审阅提交哈希>`；由于 Git 安装从源码执行 `prepare` 构建，用户必须按 pnpm 的提示明确授予该可信提交构建权限。
