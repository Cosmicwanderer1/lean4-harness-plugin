# @author ygw
<#
.SYNOPSIS
将仓库内的 Lean 证明题规约 Skill 部署到指定 Harness 主目录。

.DESCRIPTION
仅复制一个已验证的 SKILL.md 到 DSH_HOME\skills。若目标文件存在且内容不同，
除非指定 -Force，否则停止执行，避免覆盖用户的本地修改。

.PARAMETER DshHome
目标 deepseek-harness 主目录；省略时读取 DSH_HOME 环境变量。

.PARAMETER Force
允许用仓库版本覆盖内容不同的同名目标文件。
#>
[CmdletBinding()]
param(
  [Parameter()]
  [string]$DshHome = $env:DSH_HOME,

  [Parameter()]
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RequiredPath {
  <#
  .SYNOPSIS
  解析并验证必须存在的文件路径。

  .PARAMETER Path
  [string] 待验证的路径。

  .PARAMETER Description
  [string] 用于错误信息的路径用途。

  .OUTPUTS
  [string] 规范化后的绝对路径。
  #>
  param(
    [Parameter(Mandatory)]
    [string]$Path,

    [Parameter(Mandatory)]
    [string]$Description
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description 不存在或不是文件：$Path"
  }

  return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
}

function Get-ContentHash {
  <#
  .SYNOPSIS
  计算文件的 SHA-256 内容摘要。

  .PARAMETER Path
  [string] 已存在的文件路径。

  .OUTPUTS
  [string] 大写 SHA-256 十六进制摘要。
  #>
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  throw '未提供 DshHome，且 DSH_HOME 环境变量为空。请通过 -DshHome 指定隔离 Harness 主目录。'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceFile = Get-RequiredPath -Path (Join-Path $repositoryRoot 'skills\lean-problem-formalizer\SKILL.md') -Description 'Skill 源文件'
$targetDirectory = Join-Path $DshHome 'skills\lean-problem-formalizer'
$targetFile = Join-Path $targetDirectory 'SKILL.md'

if (Test-Path -LiteralPath $targetFile -PathType Leaf) {
  $sourceHash = Get-ContentHash -Path $sourceFile
  $targetHash = Get-ContentHash -Path $targetFile
  if ($sourceHash -eq $targetHash) {
    Write-Output "Skill 已是最新版本：$targetFile"
    return
  }
  if (-not $Force) {
    throw "目标 Skill 已存在且内容不同：$targetFile。请先检查本地修改；确认覆盖时再添加 -Force。"
  }
}

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
Write-Output "已部署 lean-problem-formalizer：$targetFile"
