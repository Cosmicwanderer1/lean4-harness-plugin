# Lean 本地验证环境

该目录是插件的 Lean 4 Lake 工作区，相当于插件自己的 Lean 虚拟环境：

- lean-toolchain 固定 Lean 4 版本。
- .lake 保存 Lake 的本地构建产物和依赖缓存。
- lakefile.lean 定义插件的 Lean 包和依赖。
- Lean4Harness.lean、Main.lean 提供默认库和验证示例。

当前工具链为 leanprover/lean4:v4.26.0。本机已安装该版本时，执行初始化脚本不会重新下载 Lean，也不会访问网络：

    ..\scripts\Initialize-LeanEnvironment.ps1

## Mathlib 兼容性

插件只能使用 Lean 4 版本的 Mathlib 4。Mathlib 3 和 Mathlib 4 不是同一个依赖，不能交叉引用。

当前插件已经在 lakefile.lean 中配置 D:/mathlib4 作为本地 path dependency，并将工具链同步到 Lean 4.26.0。该目录已有 Mathlib 4 编译产物和 Lake 子依赖缓存，因此初始化脚本不需要重新下载 Mathlib。

初始化脚本只检查兼容性并构建插件工作区，不会把外部 Mathlib 目录复制进项目，也不会自动下载缺失依赖。更换机器时，需要将 lakefile.lean 中的本地路径改为该机器上的 Mathlib 4 目录，并保证工具链版本一致。
