# Builds the tracked extension source (tools\extension-wasm) into dist\.
#
#   (default)  dist\extension-wasm         developer build: localhost dashboard, test-photo collection, test hooks
#   -Sealed    dist\extension-wasm-sealed  the developer build with a source-URL check that also accepts
#                                          http://127.0.0.1, so the scorer can serve photos locally
#   -Store     dist\extension-wasm-store   the Chrome Web Store package, plus dist\extension-wasm-store.zip
#
# onnxruntime-web is not tracked. Run scripts\setup_vendor.ps1 first; the build stops without it and copies
# the vendor files unchanged, checking each against scripts\vendor-hashes.json.
param([string]$OutputRoot, [switch]$Sealed, [switch]$Store)

$ErrorActionPreference = 'Stop'

if ($Sealed -and $Store) { throw 'Choose one of -Sealed and -Store.' }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceRoot = Join-Path $RepoRoot 'tools\extension-wasm'
$DistRoot = Join-Path $RepoRoot 'dist'
$DefaultOutput = if ($Sealed) { 'extension-wasm-sealed' } elseif ($Store) { 'extension-wasm-store' } else { 'extension-wasm' }
$UseDefaultOutput = [string]::IsNullOrWhiteSpace($OutputRoot)
$OutputRoot = if ($UseDefaultOutput) { Join-Path $DistRoot $DefaultOutput } else { [System.IO.Path]::GetFullPath($OutputRoot) }

function Get-FileSha256([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# ─── vendor files: present, unmodified ────────────────────────────────────────

$Pinned = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'vendor-hashes.json') | ConvertFrom-Json
$VendorSource = Join-Path $SourceRoot 'vendor'
$SetupHint = 'Run: powershell -ExecutionPolicy Bypass -File scripts\setup_vendor.ps1'
foreach ($entry in $Pinned.files.PSObject.Properties) {
  $path = Join-Path $VendorSource $entry.Name
  if (-not (Test-Path -LiteralPath $path)) {
    throw "onnxruntime-web is missing: tools\extension-wasm\vendor\$($entry.Name) was not found. The extension will not start without it. $SetupHint"
  }
  if ((Get-FileSha256 $path) -ne $entry.Value) {
    throw "tools\extension-wasm\vendor\$($entry.Name) does not match scripts\vendor-hashes.json. Delete the vendor folder and fetch it again. $SetupHint"
  }
}

# ─── copy ─────────────────────────────────────────────────────────────────────

# The default outputs are rebuilt from nothing, so a file removed from the source cannot linger in the package.
if ($UseDefaultOutput -and (Test-Path -LiteralPath $OutputRoot)) {
  $resolved = (Resolve-Path -LiteralPath $OutputRoot).Path
  if (-not $resolved.StartsWith($DistRoot + '\')) { throw "Refusing to clear $resolved" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$VendorSourcePrefix = $VendorSource + '\'
Get-ChildItem -LiteralPath $SourceRoot -Recurse -File | ForEach-Object {
  # Only the pinned vendor files ship; anything else dropped into the folder (threaded builds, notes) stays behind.
  if ($_.FullName.StartsWith($VendorSourcePrefix) -and -not $Pinned.files.PSObject.Properties[$_.Name]) { return }
  $RelativePath = $_.FullName.Substring($SourceRoot.Length).TrimStart([char[]]@('\', '/'))
  $Destination = Join-Path $OutputRoot $RelativePath
  $DestinationDirectory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $Destination -Force
}

foreach ($entry in $Pinned.files.PSObject.Properties) {
  if ((Get-FileSha256 (Join-Path $OutputRoot "vendor\$($entry.Name)")) -ne $entry.Value) {
    throw "vendor\$($entry.Name) changed while being copied into $OutputRoot."
  }
}

# ─── variants ─────────────────────────────────────────────────────────────────

if ($Sealed) {
  $Lib = Join-Path $OutputRoot 'lib'
  Move-Item -LiteralPath (Join-Path $Lib 'net.js') -Destination (Join-Path $Lib 'net-shipped.js') -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'tools\extension-wasm-sealed\net.js') -Destination (Join-Path $Lib 'net.js') -Force
}

if ($Store) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'The store build needs node on the PATH.' }
  & node (Join-Path $PSScriptRoot 'lib\store-package.mjs') $OutputRoot
  if ($LASTEXITCODE -ne 0) { throw "store-package.mjs failed (exit $LASTEXITCODE)." }
  $ModelsDir = Join-Path $OutputRoot 'models'
  if ((Test-Path -LiteralPath $ModelsDir) -and -not (Get-ChildItem -LiteralPath $ModelsDir -Force)) { Remove-Item -LiteralPath $ModelsDir -Force }

  # Entry names use forward slashes, as the zip format and the store expect.
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $ZipPath = $OutputRoot.TrimEnd('\') + '.zip'
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $OutputRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
      $entryName = $_.FullName.Substring($OutputRoot.TrimEnd('\').Length + 1).Replace('\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }
  } finally {
    $zip.Dispose()
  }
  # The zip is what gets uploaded, so check it, not only the folder it was made from.
  $check = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $banned = @($check.Entries | Where-Object { $_.FullName -match '(^|/)models/|\.map$|\.md$|\.onnx$|\\' })
    if ($banned.Count -gt 0) { throw "The store zip contains files that must not ship: $($banned.FullName -join ', ')" }
    if (-not ($check.Entries | Where-Object { $_.FullName -eq 'manifest.json' })) { throw 'The store zip has no manifest.json at its root.' }
  } finally {
    $check.Dispose()
  }
  Write-Output "Wrote $ZipPath ($([math]::Round((Get-Item -LiteralPath $ZipPath).Length / 1MB, 1)) MB)"
}

Write-Output "Built tracked extension source into $OutputRoot"
