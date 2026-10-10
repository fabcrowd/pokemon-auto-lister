$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourcePath = Join-Path $RepoRoot 'tools\extension-wasm\content.js'
$OutputPath = Join-Path $RepoRoot 'dist\extension-wasm\content.js'

if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
  throw "Tracked extension content script not found: $SourcePath"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
Copy-Item -LiteralPath $SourcePath -Destination $OutputPath -Force
Write-Output "Updated $OutputPath from $SourcePath"
