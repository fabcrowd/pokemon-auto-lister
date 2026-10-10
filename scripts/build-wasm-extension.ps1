$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceRoot = Join-Path $RepoRoot 'tools\extension-wasm'
$OutputRoot = Join-Path $RepoRoot 'dist\extension-wasm'

foreach ($File in @('content.js', 'background.js', 'photo-detection.js')) {
  $SourcePath = Join-Path $SourceRoot $File
  $OutputPath = Join-Path $OutputRoot $File
  if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "Tracked extension source not found: $SourcePath"
  }

  New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
  Copy-Item -LiteralPath $SourcePath -Destination $OutputPath -Force
}

Write-Output "Updated extension content.js, background.js, and photo-detection.js in $OutputRoot"
