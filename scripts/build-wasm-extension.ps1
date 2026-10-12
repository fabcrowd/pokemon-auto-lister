param([string]$OutputRoot)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceRoot = Join-Path $RepoRoot 'tools\extension-wasm'
$OutputRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  Join-Path $RepoRoot 'dist\extension-wasm'
} else {
  [System.IO.Path]::GetFullPath($OutputRoot)
}

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
Get-ChildItem -LiteralPath $SourceRoot -Recurse -File | ForEach-Object {
  $RelativePath = $_.FullName.Substring($SourceRoot.Length).TrimStart([char[]]@('\', '/'))
  $Destination = Join-Path $OutputRoot $RelativePath
  $DestinationDirectory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $Destination -Force
}

Write-Output "Built tracked extension source into $OutputRoot"
