# DSH STORE 固定 Commit 发行与一次性 Profile 验收

> 作者：ygw
>
> 发行版本：`0.1.1`
>
> 目标环境：Windows 11、Node.js `>=22.19.0`、deepseek-harness `0.1.3-alpha.2`

本文记录本插件面向 DSH STORE 的可重复验收边界。它不把静态检查、一次性 Profile 验收或真实用户环境的长期运行混为一谈。

## 固定 Commit 发行契约

DSH STORE 审核固定 Git Commit，且不会运行第三方的 `install`、`prepare`、`build`、`test` 或插件运行时代码。本仓库因此满足以下约束：

| 检查点 | 发行版 `0.1.1` 的约束 |
| --- | --- |
| 运行入口 | `dsh-plugin.js` 已提交；它导入已提交的 `dist/index.js`。 |
| 类型入口 | `dist/index.d.ts` 已提交，并与同一 TypeScript 构建同步。 |
| 生命周期 | 不声明 `preinstall`、`install`、`postinstall`、`prepare`。 |
| 来源身份 | `package.json.repository` 精确指向 `https://github.com/Cosmicwanderer1/lean4-harness-plugin.git`。 |
| 许可证 | 仓库根目录 `LICENSE` 与 manifest 都声明 MIT。 |
| 兼容性 | `dsh.compatibility.dsh` 与 `dshReleases` 精确声明 `0.1.3-alpha.2`。 |
| 本地检查 | `npm run verify:distribution` 只读取本仓库文件，不下载、不构建、不启动 Lean。 |

开发者修改 `src/` 后，应依次执行：

```powershell
Set-Location D:\lean4-harness-plugin
npm run build
npm test
npm run verify:distribution
git diff --check
```

然后将 `src/`、同步生成的 `dist/`、manifest 与文档作为同一次提交的一部分。若 `dist/` 没有变更，必须先确认本次源码改动确实不影响 TypeScript 输出。

## 本次实际验收证据

2026-09-09 在 Windows 11 本机完成了版本 `0.1.1` 的一次性验收，固定来源为 Commit [`35508439b4883d4f844459b56f3c57a9a79f3ab6`](https://github.com/Cosmicwanderer1/lean4-harness-plugin/commit/35508439b4883d4f844459b56f3c57a9a79f3ab6)。结果如下：

| 验收项 | 结果 |
| --- | --- |
| `npm test` | 7 项通过、0 项失败；包含常驻 Lean LSP、缓存检查、Bundle 工具契约和 Store 发行契约。 |
| `npm run verify:distribution` | 通过；确认 `LICENSE`、canonical `repository`、精确 DSH 兼容性、`dist/index.js`、`dist/index.d.ts` 和无安装期脚本。 |
| 固定产物预览 | `npm pack --dry-run` 包含 `dist/`、许可证、Bundle 入口与发行文档。 |
| 一次性 Profile 安装 | 在临时 `DSH_HOME` 的 `web` Profile 中以 `link:D:\\lean4-harness-plugin` 安装成功；合成配置出现唯一的 `lean4-harness-plugin/dsh`。 |
| 一次性 Web 启动 | Profile 在临时端口监听；未携带临时令牌的请求返回 `401`，携带令牌的本机请求返回 `200`。令牌未写入仓库或本文档。 |
| 一次性卸载 | 停止临时服务后移除 `lean4-harness-plugin`；重新导出的 Profile 配置不再含有该入口。 |

这是一组本机、一次性的安装和启动证据，不等同于 DSH STORE 的独立安全审查，也不替代不同 DSH 版本或其他电脑上的验证。

## 一次性 Profile 验收步骤

以下步骤仅用于隔离验收，不应在日常真实 `DSH_HOME` 中执行。它不会删除 Lean、Mathlib、插件源仓库或其他 DSH Profile。

```powershell
Set-Location D:\deepseek-harness\deepseek-harness
$env:DSH_HOME = 'D:\lean4-harness-plugin\.dsh-store-profile-check'

pnpm dsh plugin --profile lean4-store-check add 'link:D:\lean4-harness-plugin'
pnpm dsh --profile lean4-store-check --dump-config

# 在独立 PowerShell 窗口短暂启动；确认终端出现本机监听地址后按 Ctrl+C 停止。
pnpm dsh --profile lean4-store-check --no-open --port 3081

# 停止后，卸载这一次性 Profile 中的 Bundle。
pnpm dsh plugin --profile lean4-store-check remove lean4-harness-plugin
pnpm dsh --profile lean4-store-check --dump-config
```

安装后的配置必须含有且仅含有一次 `lean4-harness-plugin/dsh` 入口；卸载后的配置不应再出现该入口。启动只证明 Bundle 可以被指定 DSH 版本装载；要证明 Lean 运行能力，仍应在该 Profile 中让模型实际调用一次 `lean_check`。

## 权限、依赖与失败边界

该插件会被 Store 识别为具有文件与命令能力。这是验证 Lean 4 所必需的能力信号，不是未披露行为：

- 只读访问：插件自己的 `lean/` 工作区、Lake 解析后的搜索路径，以及版本匹配的本地 Lean/Mathlib `.olean` 缓存；
- 受控命令：`lake env` 与 `lean --server`；经用户一次授权后，才可为已检查出的精确 `Mathlib.*` 目标执行受控 `lake build`；
- 明确禁止：模型自由 shell 命令、`lake update`、`lake clean`、`lake exe`、全量 Mathlib 构建、写入 `D:\mathlib4`、读取/上传凭据、联网调用 LeanCopilot；
- 失败行为：无法定位 Lean/Lake/缓存时返回配置错误；未经授权的缺失模块返回授权状态；子进程异常或超过配置时限时返回错误或超时状态，绝不伪造验证成功。

因此，静态扫描可能将该插件归为需要用户审阅的本地开发工具。只有 Lean 的实际诊断为 `verified` 或 `verified_with_warnings` 时，插件才会报告代码已通过验证。
