# Lean 4 Harness Plugin 开发指导

> 项目：`lean4-harness-plugin`
> 作者：`ygw`
> 适用环境：Windows 11、Node.js 20+、Lean 4、Lake
> 当前阶段：基础验证插件已完成，正在向 deepseek-harness 的正式宿主集成和智能建议能力演进。

## 1. 插件定位

本插件是 `deepseek-harness` 面向 Lean 4 代码生成场景的验证与辅助服务。

模型生成 Lean 4 代码后，插件负责将代码放入隔离且可复现的 Lean 工作区，调用 Lean 编译器或 REPL 进行验证，并把编译结果、错误位置、警告、目标状态和相关上下文转换为模型能够继续处理的结构化结果。

插件的核心价值不是替模型直接“猜测证明”，而是提供可信的外部反馈：

1. 验证模型生成的 Lean 4 代码是否能够通过解析、精化（elaboration，即将语法代码解析为带类型的核心表达式）和编译。
2. 返回可定位到文件、行号和列号的诊断信息。
3. 在证明未完成时提取 tactic state（战术状态），展示局部上下文和待证明目标。
4. 在接入 LeanCopilot 后，为失败或未完成的证明生成候选 tactic、证明片段或修正建议。
5. 将验证结果和建议反馈给 deepseek-harness，使模型能够执行“生成代码 -> 验证 -> 修正 -> 再验证”的闭环。

Lean 编译器的验证结果是事实依据；LeanCopilot 的输出是候选建议，必须再次交给 Lean 验证，不能直接视为正确证明。

## 2. 当前架构

```text
deepseek-harness
        |
        | Harness/Cordis 注册适配层
        v
src/index.ts
        |
        +-- LeanReplService
        |     +-- 常驻 Lean LSP 源码检查
        |     +-- LSP 与 JSON 行 REPL 请求
        |     +-- 进程生命周期、超时和错误处理
        |
        +-- Harness Tools
        |     +-- lean_check
        |     +-- lean_repl_request
        |     +-- lean_format_tactic_state
        |
        +-- LeanFormatter
        |     +-- 编译诊断解析
        |     +-- tactic state 解析
        |     +-- Markdown 转换
        |
        v
lean/ 工作区
        +-- lean-toolchain
        +-- lakefile.lean
        +-- Lean4Harness.lean
        +-- Main.lean
```

主要代码位置：

- `src/index.ts`：插件入口、服务注册和 Harness 工具注册。
- `src/services/lean-repl.ts`：Lean 子进程、请求关联、超时、源码检查和进程清理。
- `src/utils/formatter.ts`：Lean 诊断、tactic state 和 Markdown 格式化。
- `src/types/index.ts`：REPL 协议、检查结果、工具和宿主注册接口。
- `lean/`：版本锁定的 Lean 4/Lake 工作区。

当前项目使用 `HarnessPluginContext` 作为最小宿主接口。实际接入 deepseek-harness 或 Cordis 时，应在这一边界实现适配，不要在核心服务中硬编码未知宿主 SDK 的内部对象。

## 3. 核心工作流

标准验证流程如下：

```text
模型生成 Lean 代码
        |
        v
创建临时文件或验证会话
        |
        v
Lean 编译器 / Lean REPL
        |
        +-- 通过：返回 verified 结果
        |
        +-- 失败：解析诊断和 tactic state
                         |
                         v
                 可选调用 LeanCopilot
                         |
                         v
                 产生候选修正建议
                         |
                         v
                 再次提交 Lean 验证
```

任何建议都必须携带其来源、适用文件或目标上下文，并经过 Lean 再验证。建议生成失败、超时或外部服务不可用时，验证功能仍应独立工作。

## 4. 开发原则

### 4.1 验证优先

- Lean 编译结果是成功与否的唯一权威依据。
- 不允许通过字符串匹配、模型自评或“看起来像证明”的规则将代码标记为成功。
- 诊断结果需要尽量保留原始输出，同时提供结构化字段，方便模型和用户分别消费。
- 编译成功、只存在警告、编译失败、进程崩溃、超时和环境缺失必须区分表示。

### 4. 可复现与隔离

- 每次验证应明确 Lean toolchain、Lake 工作目录、依赖版本和编译参数。
- 不同模型会话之间不能共享可变的证明状态，除非显式使用会话 ID 和同步机制。
- 临时文件必须在验证结束后清理；清理失败需要记录警告，但不能掩盖验证结果。
- 用户代码和模型生成代码均视为不可信输入。路径、文件名、命令参数和工作目录必须经过校验。
- 默认隐藏子进程窗口，避免 Windows 11 下弹出额外控制台窗口。

### 4.3 结果可追溯

验证结果应能够关联到以下信息：

- 请求 ID 和会话 ID。
- Lean、Lake、Mathlib（如果使用）。
- 输入源码或源码摘要。
- 实际执行的工作目录和命令配置，但不得泄露敏感环境变量。
- 标准输出、标准错误和结构化诊断。
- 建议提供方、候选内容和再验证结果。

日志中不得记录 API 密钥、完整环境变量、未经脱敏的用户隐私数据或不必要的完整源码。

## 5. 错误与状态模型

建议统一使用以下几类状态，避免只返回布尔值：

| 状态 | 含义 |
| --- | --- |
| `verified` | Lean 验证通过，没有阻断性错误 |
| `verified_with_warnings` | Lean 验证通过，但存在警告 |
| `invalid` | Lean 解析、类型检查或编译失败 |
| `suggestion_available` | 有未验证的候选建议 |
| `suggestion_verified` | 候选建议已通过 Lean 验证 |
| `timeout` | 编译、REPL 或建议服务超过时间限制 |
| `process_error` | 子进程启动、通信或退出异常 |
| `configuration_error` | Lean、Lake、依赖或外部服务配置错误 |

错误响应应包含机器可读代码、用户可读消息和可选的诊断数据。不得捕获通用异常后静默忽略，也不得把环境故障伪装成 Lean 代码错误。

## 6. 测试要求

每次修改至少执行与影响范围匹配的检查：

- TypeScript：`npm run build`。
- 单元测试：`npm test`。
- Lean 工作区：在 `lean/` 目录执行 `lake build` 和 `lake env lean Main.lean`。
- 服务变更：验证成功源码、失败源码、诊断解析、超时、进程退出和参数校验。
- 建议适配器变更：测试成功响应、空响应、非法响应、超时、取消、外部服务错误和候选再验证。
- Windows 11：验证路径包含空格、子进程窗口隐藏、临时目录清理和 PATH 中的 `lean.exe`/`lake.exe`。

## 7. 代码与文档规范

- 新增或修改的代码文件应包含 `@author ygw` 标识。
- 类、接口、公开方法和关键私有方法必须有用途、参数和返回值说明。
- 保持方法短小，复杂流程拆分为可测试的方法。
- 优先复用现有 `LeanReplService`、`LeanFormatter` 和类型定义，不重复实现进程管理或诊断解析。
- 空值判断统一使用项目中的 `ObjectUtils.isEmpty()`，并在必要处补充类型和格式校验。
- 不把宿主 SDK、Mathlib 的未确认 API 写成事实；通过适配器和配置隔离外部依赖。
- 业务功能新增、修改或重构后，立即更新 `.specstory/history/docs/开发进度.md` 和 `.specstory/history/docs/session.md`。
- 过程记录应描述决策、验证结果和问题修复，但不记录密钥、隐私数据或无关的完整输入。

## 8. Windows 11 开发约定

推荐使用 PowerShell：

```powershell
npm install
npm run build
npm test
Set-Location lean
lake build
lake env lean Main.lean
```

开发工具应通过 Node.js 跨平台路径 API 构造路径，不手写依赖单一斜杠方向的路径。Lean 和 Lake 命令默认从 PATH 查找，也应支持通过配置显式指定命令路径。

## 9. 不应做的事情

- 不将未经过 Lean 验证的模型标记为证明成功。
- 不把普通 `lean.exe` 当作 JSON REPL 使用；编译器检查和 REPL 通信是两条不同路径。
- 不在核心服务中直接依赖某个未确认的 deepseek-harness/Cordis 内部对象。
- 不通过拼接字符串执行用户提供的命令、路径或参数。
- 不为了通过测试而放宽 Lean 检查、吞掉诊断或伪造成功结果。
- 不无限重试编译或建议请求。
- 不提交 `node_modules/`、`dist/`、`.lake/` 或包含密钥的配置文件。

## 10. 完成标准

一个 Lean 验证相关功能只有同时满足以下条件才算完成：

1. 输入、输出和错误状态已经定义并写入类型。
2. 核心服务和宿主注册边界清晰，外部依赖通过适配器接入。
3. 成功、失败、异常和超时路径都有测试。
4. Lean 实际执行结果与返回状态一致。
5. 若涉及建议，候选建议和最终验证结果明确区分。
6. README、开发进度和会话记录已同步。
7. 在 Windows 11 环境完成构建和相关运行验证。

## 11. 本地 Lean 虚拟环境

`lean/` 是本插件的本地 Lean 虚拟环境，由 Lean toolchain 和 Lake 工作区共同构成，不等同于 Python venv。开发时应优先复用本机已安装且与 `lean/lean-toolchain` 一致的 Lean 版本；`.lake/` 只保存本项目的构建产物和依赖缓存。

Mathlib 必须使用 Lean 4 版本的 Mathlib 4，并且其 lean-toolchain 必须与插件完全一致。当前项目通过 lean/lakefile.lean 使用本机 D:/mathlib4 的本地 path dependency。Lean 3 Mathlib 不能作为 Lean 4 Lake 依赖使用。初始化和兼容性检查使用 scripts/Initialize-LeanEnvironment.ps1，该脚本默认不联网下载依赖。

## 12. 常驻验证服务

`LeanReplService` 的默认模式是常驻 Lean LSP 服务。每个服务实例仅执行一次 `lake env` 以取得已解析的 Lake 环境变量，随后直接运行 `lean --server`，避免 Windows 下由 `lake env` 转发 LSP 标准输入输出时出现的管道继承问题。

服务实例加载时会在后台预热一个可信的精确导入，默认是 `import Mathlib.Data.Nat.Basic`。`D:/mathlib4/Mathlib.lean` 是聚合源码且没有已构建的 `Mathlib.olean`，因此不得把 `import Mathlib` 作为默认预热或模型生成代码的默认导入；应按证明实际需求选择最小模块。部署可通过 `prewarmSource` 替换预热源码。

服务实例只打开一个内部 `Validation.lean` 文档，预热和所有 `lean_check` 请求均通过该文档的 `textDocument/didChange` 串行更新。这一点是复用已加载声明的必要条件：Lean LSP 为每个已打开文档配置独立工作进程，持续新建文件会导致每个工作进程再次加载导入。调用方传入的 `fileName` 是返回诊断用的逻辑名称，不应据此创建多个内部文件。

内部文档必须使用 `dependencyBuildMode: "never"` 打开。它只允许使用 `D:/mathlib4` 和 `lean/.lake` 中已经存在的 `.olean` 及依赖缓存，禁止临时验证触发 `lake update`、依赖构建、远程缓存访问或任何下载。首次加载本地产物可能需要几十秒；后续同文档增量检查应显著更快。默认超时为 120 秒，服务停止后必须清理会话目录。
