# lean4-harness-plugin

> `deepseek-harness` 的 Lean 4 本地验证插件。
> 作者：ygw｜适用环境：Windows 11、Lean 4.26.0、Mathlib 4、deepseek-harness `0.1.3-alpha.2`。

`lean4-harness-plugin` 不替模型“猜”证明是否正确。模型生成 Lean 4 源码后，插件会调用本地 Lean 验证器，并把真实结果、诊断位置、错误信息和导入缓存状态返回给模型。模型据此修改代码并再次检查，直至 Lean 明确通过。

**当前已实现：**

- 完整 Lean 4 源码验证；
- 常驻 Lean LSP 进程复用；
- 结构化错误、警告、行号和列号；
- 精确 Mathlib 模块的 `.olean` 缓存检查；
- 缺失精确 Mathlib 模块时的用户一次授权与受控最小构建；
- tactic state 格式化；
- 可选的自然语言数学题规约 Skill。

更详细的运行关系见 [docs/architecture.md](docs/architecture.md)。

## 怎样使用

如果你已经打开 `http://127.0.0.1:3080/`，并且当前 Web Profile 已加载本插件，那么不需要手动启动 Lean，也不需要填写工具 JSON。只需新建对话，给模型数学题，并明确要求它在完成前调用 `lean_check`。

可以先把下面这段测试要求交给模型。它只给出任务，不给出答案：

```text
请使用 Lean 4 和 Mathlib 证明自然数加法满足：1 + 2 = 2 + 1。

要求：
1. 自行写出完整 Lean 4 源码；
2. 自行选择最小必要的 Mathlib 子模块，不要使用 import Mathlib；
3. 生成第一版代码后，必须调用 lean_check；
4. 若 lean_check 返回错误，请依据错误信息修改并继续验证；
5. 只有 lean_check 返回 verified 或 verified_with_warnings 后，才能说明证明完成。
```

第一次 `lean_check` 可能需要几十秒到数分钟：Lean LSP 需要把所需的、**已经存在于本机**的 `.olean` 文件读入内存。这不是下载或全量重编译 Mathlib。之后同一 Web 服务中的验证会复用常驻进程，结果里的 `reusedProcess` 通常为 `true`，速度会明显提升。

## Harness 如何加载和使用插件

本插件不需要复制到 deepseek-harness 的 `packages/` 目录。它作为一个 DSH Bundle 被 Profile 安装和加载：

```text
deepseek-harness Web Profile
        │
        │  安装 lean4-harness-plugin
        ▼
package.json 的 dsh.bundle 声明
        │
        ▼
cordis.patch.yml
        │  插入 lean4-harness-plugin/dsh
        ▼
dsh-plugin.js（Cordis 入口，apply(ctx)）
        │
        ├── 注册 lean_check
        ├── 注册 lean_repl_request
        ├── 注册 lean_format_tactic_state
        ├── 注入 Lean 验证提示
        └── 阻止模型直接执行危险的 Lake / Mathlib 操作
        │
        ▼
dist/index.js
        │
        ▼
LeanReplService + LeanFormatter
        │
        ▼
lean/ Lake 工作区 ──── D:/mathlib4 的本地 .olean 缓存
```

因此，deepseek-harness 是**宿主**，而 `D:\lean4-harness-plugin` 是 Lean 验证逻辑的唯一来源。以后修改插件时，只需重新构建本仓库并重启 Harness，不必在 Harness 源码中维护第二份 Lean 实现。

## 当前真实目录结构

以下是当前需要纳入版本控制的真实结构：

```text
lean4-harness-plugin/
├── package.json                         # npm 包、DSH Bundle 声明、构建和测试脚本
├── package-lock.json                    # Node 依赖锁定
├── tsconfig.json                        # TypeScript 编译配置
├── cordis.patch.yml                     # Profile 配置层：加载 lean4-harness-plugin/dsh
├── dsh-plugin.js                        # 真正的 Cordis / DSH 运行时入口
├── README.md                            # 安装、使用、配置和排错说明（本文件）
├── AGENTS.md                            # 项目开发约定
│
├── docs/
│   └── architecture.md                  # 运行架构、边界和后续演进
│
├── lean/                               # 插件自己的 Lean 4 Lake 工作区
│   ├── lean-toolchain                  # 锁定 leanprover/lean4:v4.26.0
│   ├── lakefile.lean                   # Lake 配置；当前使用 D:/mathlib4
│   ├── lake-manifest.json              # Lake 依赖清单
│   ├── Lean4Harness.lean               # 插件 Lean 库入口
│   ├── Main.lean                       # 可手动验证的 Lean 示例
│   └── README.md                       # Lean 工作区单独说明
│
├── scripts/
│   ├── Initialize-LeanEnvironment.ps1  # 检查 Lean / Lake / Mathlib 环境
│   └── Install-LeanProblemFormalizerSkill.ps1
│                                        # 将可选 Skill 安装到指定 DSH_HOME
│
├── skills/
│   └── lean-problem-formalizer/
│       └── SKILL.md                    # 数学题 → Lean 验证任务规约 Skill
│
├── src/                                # 可独立复用的 TypeScript 验证核心
│   ├── index.ts                        # TypeScript 公共 API；不是 Cordis 入口
│   ├── services/
│   │   └── lean-repl.ts                # 常驻 LSP、导入检查、受控构建、清理
│   ├── types/
│   │   └── index.ts                    # 诊断、配置与导入检查类型
│   ├── utils/
│   │   ├── formatter.ts                # Lean 诊断和 tactic state 格式化
│   │   └── object-utils.ts             # 统一空值判断工具
│   └── tests/
│       ├── formatter.test.ts           # 格式化测试
│       └── lean-repl.test.ts           # 真实常驻 Lean LSP 回归测试
│
└── tests/
    └── dsh-plugin.test.mjs             # Bundle 入口和工具契约测试
```
`dsh-plugin.js` 与 `src/index.ts` 的职责不同：前者由 deepseek-harness 加载，负责 Cordis 生命周期和模型工具；后者是可被其他 TypeScript 程序调用的验证核心 API。普通 Web 使用者只需要前者。

## 前置条件

| 必需项 | 当前项目要求 | 检查方式 |
| --- | --- | --- |
| 操作系统 | Windows 11；文档命令均为 PowerShell | `Get-ComputerInfo` |
| Node.js | `>= 22.19.0` | `node --version` |
| pnpm | deepseek-harness 使用的包管理器 | `pnpm --version` |
| deepseek-harness | 当前经过验证的版本：`0.1.3-alpha.2` | 查看 Harness 根目录 `package.json` |
| Lean | `leanprover/lean4:v4.26.0`，由 elan 安装 | `lean --version` |
| Lake | 与 Lean 同一工具链 | `lake --version` |
| Mathlib 4 | 与 Lean 4.26.0 匹配，且已有本地 `.olean` | `Test-Path 'D:\mathlib4\Mathlib'` |

当前 [lean/lakefile.lean](lean/lakefile.lean) 明确写有：

```lean
require mathlib from "D:/mathlib4"
```

所以插件**不会**在安装时下载 Mathlib库，也不会把 Mathlib库打包上传到 GitHub。当前电脑直接使用 `D:\mathlib4` 即可；另一台电脑若将 Mathlib 放在其他位置，必须先准备与 Lean 4.26.0 匹配的 Mathlib库，然后修改 `lean/lakefile.lean` 中的路径并重新构建插件。仅修改 Bundle 的 `mathlibRoot` 配置不能改变 Lake 的依赖路径。

可以先执行以下环境检查：

```powershell
Set-Location D:\lean4-harness-plugin
.\scripts\Initialize-LeanEnvironment.ps1
```

该脚本只构建插件自己的小型 Lake 工作区；不会执行 `lake update`，不会下载依赖，也不会全量重编译 `D:\mathlib4`。

## 首次安装到 deepseek-harness

以下步骤适用于新建或重新配置一个**独立** Harness Profile。

### 1. 构建并测试插件

```powershell
Set-Location D:\lean4-harness-plugin
npm install
npm run build
npm test
```

`npm test` 包含真实常驻 Lean LSP 回归测试，首次可能耗时约一分钟。它读取本地 `.olean`，不会重新下载或全量构建 Mathlib。

### 2. 将本地仓库链接到 Web Profile

在 Harness 源码目录运行：

```powershell
Set-Location D:\deepseek-harness\deepseek-harness
$env:DSH_HOME = 'D:\lean4-harness-plugin\.dsh-lean4-plugin-test'

pnpm dsh plugin --profile web add 'link:D:\lean4-harness-plugin'
pnpm dsh --profile web --dump-config
```

第二条命令的结果应出现：

```text
# == lean4-harness-plugin
- id: lean4-harness-plugin
  name: lean4-harness-plugin/dsh
```

这说明 Harness 已读取 `cordis.patch.yml`，并会从本仓库加载 `dsh-plugin.js`。如果同一 Profile 中仍出现旧的 `dsh-experimental-lean4-profile`，请先移除旧层；一个 Profile 中不应保留两套同名 `lean_check`。

### 3. 启动 Web UI

仍在同一个 PowerShell 窗口运行：

```powershell
pnpm dsh --profile web --no-open --port 3080
```

终端会打印带访问令牌的本地地址。令牌是本机访问凭证，不要发布到 GitHub、截图或聊天记录中。当前会话已经为你启动了同一个 Profile，因此现在可直接继续使用 `http://127.0.0.1:3080/`。

### 4. 在 Web 对话中验证

新建对话，把数学题交给模型，并在题目末尾加上：

```text
- 写出完整 Lean 4 源码和最小必要的 Mathlib 子模块导入；
- 不要使用顶层 import Mathlib；
- 第一版代码后必须调用 lean_check；
- 如果验证失败，依据 Lean 诊断修改并继续调用 lean_check；
- 只有 verified 才能宣布完成。
```

模型会自行生成 `lean_check` 的参数并调用工具。用户不需要在 Web 页面中手动填写 `source` 或文件名。

## 推荐的 Mathlib 测试题

为了确认模型使用的是 Mathlib 子模块而不是只验证纯 Lean 语法，可将下题交给模型。这里不提供证明代码：

```text
请使用 Lean 4 和 Mathlib 证明：对任意实数 x，sin (-x) = -sin x。

请自行选择最小必要的 Mathlib 子模块；不要使用 import Mathlib。
写出完整源码，并在宣布证明完成前调用 lean_check。
若检查失败，请依据诊断修改代码并继续验证。
```

在当前已完整恢复缓存的 `D:\mathlib4` 环境中，三角函数所需精确模块应直接命中 `.olean` 缓存，不应请求补齐授权。

## 模型工具说明

普通用户主要关注 `lean_check`。另外两个工具服务于高级调试或后续扩展。

| 工具 | 建议调用者 | 输入 | 返回 / 用途 |
| --- | --- | --- | --- |
| `lean_check` | 模型在每次完整源码生成或修改后调用 | `source`、`file_name` | 验证结果、诊断、导入缓存检查和可选构建结果。 |
| `lean_repl_request` | 高级 LSP / JSON 行调试流程 | `id`、`method`、可选 `params` | 原样转发 Lean LSP 或 JSON 行 REPL 请求；普通证明不需要。 |
| `lean_format_tactic_state` | 模型或调试工具 | `tactic_state` | 返回结构化目标和 Markdown。 |

注意：DSH Bundle 中的 `lean_check` 使用下划线参数 `file_name`。独立 TypeScript API 使用 `fileName`；两种接口不要混用。

典型结果包含：

```text
success: true / false                 # Lean 是否没有阻断性错误
status: verified / invalid / ...      # 稳定状态
reusedProcess: false / true           # 是否复用了常驻 Lean LSP
diagnostics: [...]                    # 文件、行、列、严重级别与消息
importInspection:                     # 显式 import 的本地缓存检查
  cachedImports: [...]
  missingImports: [...]
  buildTargets: [...]
```

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `verified` | Lean 无错误通过 | 可以说明证明已验证。 |
| `verified_with_warnings` | Lean 通过但有警告 | 可以说明通过，同时查看警告。 |
| `invalid` | 解析、类型检查或证明失败 | 根据 `diagnostics` 修改后重试。 |
| `configuration_error` | 工作区、导入或环境配置不正确 | 检查 Mathlib 路径、Lean 版本和精确导入。 |
| `authorization_rejected` | 用户拒绝构建缺失模块 | 不修改缓存；可换用可用模块或稍后批准。 |
| `authorization_cancelled` | 授权窗口被取消 | 重新发起验证或换用缓存模块。 |
| `authorization_unavailable` | 宿主没有可用授权通道 | 检查 Profile 是否提供用户授权服务。 |
| `build_failed` | 已授权精确模块构建失败 | 查看构建输出，检查 Lake / Mathlib 环境。 |

## Mathlib 缓存、授权与安全边界

普通验证只读取本地缓存：

```text
模型源码
   │
   ▼
检查每个精确 import 是否已有 .olean
   │
   ├── 全部命中 → 常驻 Lean LSP 验证
   │
   └── 缺失 Mathlib.* → 显示精确模块并请求用户一次授权
                         │
                         ├── 拒绝 / 取消 → 不构建，返回状态
                         └── 批准 → 仅构建该模块 → 重启 LSP → 再验证原源码
```

插件不会因为模型请求而执行：

- `lake update`；
- `lake clean`；
- `lake exe`；
- Mathlib 全量构建；
- 直接修改 `D:\mathlib4`；
- 将模型或未来 LeanCopilot 的建议视为已验证证明。

模型直接尝试执行上述 Lake 命令或写入受保护 Mathlib 目录时，会被最终工具守卫拒绝。顶层聚合导入 `import Mathlib` 不会被当成可自动补齐的精确模块；请始终选择具体的 `Mathlib.*` 子模块。

## Bundle 配置

默认配置位于 [cordis.patch.yml](cordis.patch.yml)：

```yaml
- insert:
    - id: lean4-harness-plugin
      name: 'lean4-harness-plugin/dsh'
      config:
        mathlibRoot: 'D:/mathlib4'
        requestTimeoutMs: 600000
        buildTimeoutMs: 600000
        prewarm: false
        prewarmSource: |
          import Mathlib.Data.Nat.Basic
```

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `workspaceRoot` | 插件包内的 `lean/` | Lake 工作区路径。 |
| `mathlibRoot` | `D:/mathlib4` | Mathlib 写入防护范围；不替代 `lakefile.lean` 的依赖路径。 |
| `lakeCommand` | `lake` | Lake 命令或绝对路径。 |
| `leanCommand` | `lean` | Lean 命令或绝对路径。 |
| `requestTimeoutMs` | `600000` | 前台启动、验证和诊断最大时长，单位毫秒。 |
| `buildTimeoutMs` | `600000` | 已授权精确模块构建最大时长，单位毫秒。 |
| `prewarm` | `false` | `true` 时 Web 启动后预热可信导入；`false` 时首个 `lean_check` 延迟启动。 |
| `prewarmTimeoutMs` | `90000` | 后台预热最大时长，单位毫秒。 |
| `prewarmSource` | `import Mathlib.Data.Nat.Basic` | 预热使用的可信源码。 |
| `maxResultChars` | `16000` | 返回给模型的 stderr / 构建输出最大字符数。 |

例如，希望明确固定路径并开启预热时，可在 `config` 中补充：

```yaml
workspaceRoot: 'D:/lean4-harness-plugin/lean'
mathlibRoot: 'D:/mathlib4'
lakeCommand: 'lake'
leanCommand: 'lean'
prewarm: true
prewarmTimeoutMs: 90000
```

修改 `cordis.patch.yml` 或 `package.json` 后，需要重新安装 Bundle：

```powershell
Set-Location D:\deepseek-harness\deepseek-harness
$env:DSH_HOME = 'D:\lean4-harness-plugin\.dsh-lean4-plugin-test'
pnpm dsh plugin --profile web remove lean4-harness-plugin
pnpm dsh plugin --profile web add 'link:D:\lean4-harness-plugin'
pnpm dsh --profile web --dump-config
```

## 可选：安装数学题规约 Skill

`lean-problem-formalizer` 不写证明，也不自动验证。它把自然语言数学题整理成适合交给 Lean 模型的任务说明：明确变量类型、量词、定义、前提、结论、歧义处置、最小导入约束与验证要求。

安装到当前隔离 Profile：

```powershell
Set-Location D:\lean4-harness-plugin
.\scripts\Install-LeanProblemFormalizerSkill.ps1 -DshHome 'D:\lean4-harness-plugin\.dsh-lean4-plugin-test'
```

之后在新的 Web 对话中说：

```text
请使用 lean-problem-formalizer，把下面的数学题整理成 Lean 4 证明与验证任务。
```

Skill 只规约题意；模型生成 Lean 源码后仍必须调用 `lean_check`。

## 日常开发与更新

### 只修改 TypeScript 核心或 Cordis 入口

```powershell
Set-Location D:\lean4-harness-plugin
npm run build
npm test
```

然后重启当前 Web 服务。因为 Profile 使用 `link:D:\lean4-harness-plugin`，无需重复执行 `dsh plugin add`。

### 从 GitHub 安装

另一台已经准备好 Lean 和 Mathlib 的电脑可固定到已审阅提交安装：

```powershell
Set-Location D:\deepseek-harness\deepseek-harness
$env:DSH_HOME = 'D:\dsh-lean4'
pnpm dsh plugin --profile lean4 add 'github:Cosmicwanderer1/lean4-harness-plugin#<已审阅提交哈希>'
pnpm dsh --profile lean4 --dump-config
pnpm dsh --profile lean4 --no-open --port 3080
```

Git 安装会执行本仓库的 `prepare` 脚本生成 `dist/`。pnpm 若提示允许构建脚本，只应在确认固定提交可信后允许。GitHub 安装不会自动提供 `D:\mathlib4`；没有配置兼容的本地 Mathlib 4 时，插件无法验证 Mathlib 定理。

## 故障排查

| 现象 | 常见原因 | 处理方式 |
| --- | --- | --- |
| Web 页面无法访问 | Web 未启动、端口被占用，或没有使用终端给出的本机地址 | 确认 `pnpm dsh --profile web --no-open --port 3080` 正在运行；端口冲突时关闭旧实例或改端口。 |
| 模型没有 `lean_check` | Bundle 未安装到当前 `DSH_HOME` / Profile，或 patch 修改后没有重新安装 | 执行 `pnpm dsh --profile web --dump-config`，确认出现 `lean4-harness-plugin/dsh`。 |
| 两套 `lean_check` 冲突 | 新 Bundle 和旧 `dsh-experimental-lean4-profile` 同时加载 | 同一 Profile 仅保留一套 Lean Bundle。 |
| 第一次验证很慢 | 首次启动 LSP、读取本地 `.olean`、加载大型精确模块 | 等待 600 秒前台期限；不要因此触发 Mathlib 全量构建。后续会复用进程。 |
| 缺失模块并请求授权 | `.olean` 中确实没有模型导入的精确 `Mathlib.*` 模块 | 核对模块名。批准后仅构建列出的精确目标；拒绝则不修改缓存。 |
| `configuration_error` | Lean / Lake 不在 PATH、版本不匹配，或 Mathlib 路径错误 | 检查 `lean --version`、`lake --version`、`D:\mathlib4` 和 `lean/lakefile.lean`。 |
| 看起来在“重构 Mathlib” | 首次 LSP 导入、精确模块补齐和全量构建被混淆 | 缓存命中时只读 `.olean`；只有明确授权且模块真实缺失时才构建精确目标。 |
| `TOOL_TIMEOUT` | 旧 Profile 仍使用 120 秒策略，或 LSP 初始化异常 | 确认 dump-config 包含 `requestTimeoutMs: 600000`，并重启使用新 Bundle 的 Web 服务。 |

## 卸载

卸载 Bundle 不会删除 Lean、Mathlib、仓库代码或证明文件，只会从指定 Profile 移除 Lean 工具：

```powershell
Set-Location D:\deepseek-harness\deepseek-harness
$env:DSH_HOME = 'D:\lean4-harness-plugin\.dsh-lean4-plugin-test'
pnpm dsh plugin --profile web remove lean4-harness-plugin
```

重启 Web 服务后，`lean_check`、`lean_repl_request` 和 `lean_format_tactic_state` 将不再出现在该 Profile 中。

## 独立 TypeScript API（开发者可选）

下列接口用于把验证核心嵌入其他 TypeScript 宿主；它不是 Web 使用插件的推荐方式，也没有 DSH Bundle 提供的用户授权与最终工具守卫。DSH 场景请始终安装 Bundle。

```ts
import { createLean4Plugin } from 'lean4-harness-plugin'

createLean4Plugin({
  registerService: (name, service) => container.register(name, service),
  registerTool: tool => harness.registerTool(tool),
}, {
  cwd: './lean',
})
```

## 发布状态

- GitHub 仓库：[Cosmicwanderer1/lean4-harness-plugin](https://github.com/Cosmicwanderer1/lean4-harness-plugin)
- 当前 Bundle 已在 deepseek-harness `0.1.3-alpha.2` 的真实独立 Profile 中启动验证。
- DSH 仍处于预览期。升级 Harness 后，请先执行 `--dump-config`，再使用一个小型 Lean 定理实际调用 `lean_check` 回归验证。
- Lean 诊断是唯一的成功依据。
