<#
.SYNOPSIS
Initialize and check the local Lake environment for Lean 4 Harness.

.DESCRIPTION
This script reuses installed Lean toolchains and local files. It does not download.
The plugin uses the local Mathlib 4 path dependency configured in lakefile.lean.

.AUTHOR
ygw
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $PSScriptRoot
$leanRoot = Join-Path $scriptRoot "lean"
$toolchainFile = Join-Path $leanRoot "lean-toolchain"

function Assert-CommandAvailable {
  param([string] $CommandName)
  if ($null -eq (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Command '$CommandName' was not found. Install and configure elan/Lean first."
  }
}

Assert-CommandAvailable "elan"
Assert-CommandAvailable "lean"
Assert-CommandAvailable "lake"

if (-not (Test-Path -LiteralPath $toolchainFile)) {
  throw "Missing Lean toolchain file: $toolchainFile"
}

$toolchain = (Get-Content -LiteralPath $toolchainFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($toolchain)) {
  throw "Lean toolchain file is empty: $toolchainFile"
}

$installedToolchains = elan toolchain list | Out-String
if ($installedToolchains -notmatch [regex]::Escape($toolchain)) {
  throw "Required Lean toolchain '$toolchain' is not installed. This script will not download it."
}

Write-Host "Lean toolchain: $toolchain"
Write-Host "Mathlib 4: local D:/mathlib4 path dependency"

Push-Location $leanRoot
try {
  lake --version
  lake env lean --version
  Write-Host "Building Lean workspace without downloading external dependencies..."
  lake build
  if ($LASTEXITCODE -ne 0) {
    throw "Lake build failed with exit code: $LASTEXITCODE"
  }
  lake env lean Main.lean
  if ($LASTEXITCODE -ne 0) {
    throw "Lean example verification failed with exit code: $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Host "Lean local environment initialization completed."
