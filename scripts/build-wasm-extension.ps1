# -Sealed builds the sealed-test variant into dist\extension-wasm-sealed: identical except that its
# source-URL check also accepts http://127.0.0.1, so the scorer can serve photos locally.
param([string]$OutputRoot, [switch]$Sealed)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceRoot = Join-Path $RepoRoot 'tools\extension-wasm'
$OutputRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  if ($Sealed) { Join-Path $RepoRoot 'dist\extension-wasm-sealed' } else { Join-Path $RepoRoot 'dist\extension-wasm' }
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

if ($Sealed) {
  $Lib = Join-Path $OutputRoot 'lib'
  Move-Item -LiteralPath (Join-Path $Lib 'net.js') -Destination (Join-Path $Lib 'net-shipped.js') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'tools\extension-wasm-sealed\net.js') -Destination (Join-Path $Lib 'net.js') -Force
}

if ($Sealed) {
  # onnxruntime-web is downloaded by setup_vendor.ps1, not tracked, and the extension will not start without it.
  $Vendor = Join-Path $RepoRoot 'dist\extension-wasm\vendor'
  if (Test-Path -LiteralPath $Vendor) {
    Copy-Item -LiteralPath $Vendor -Destination $OutputRoot -Recurse -Force
  } else {
    Write-Warning 'dist\extension-wasm\vendor is missing; run scripts\setup_vendor.ps1 first or the sealed build will not start.'
  }
}

Write-Output "Built tracked extension source into $OutputRoot"
