# Download onnxruntime-web (ESM build + WASM files) into tools/extension-wasm/vendor/.
# Run once after cloning, before building the extension. The build copies this folder unchanged.
#
# Every file is checked against scripts/vendor-hashes.json, so what ships is exactly the upstream release.
# The threaded WASM files are not downloaded: the extension runs with numThreads = 1 and ort never asks for them.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/setup_vendor.ps1

$ErrorActionPreference = "Stop"

$HashFile = Join-Path $PSScriptRoot 'vendor-hashes.json'
$Pinned   = Get-Content -Raw -LiteralPath $HashFile | ConvertFrom-Json
$ORT_VERSION = $Pinned.ortVersion
$CDN_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT_VERSION/dist"
$CDN_ESM  = "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT_VERSION/dist/esm"
$VENDOR = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\extension-wasm\vendor'

New-Item -ItemType Directory -Force -Path $VENDOR | Out-Null

function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

Write-Host "Downloading onnxruntime-web $ORT_VERSION files to $VENDOR ..."

foreach ($entry in $Pinned.files.PSObject.Properties) {
    $file = $entry.Name
    $want = $entry.Value
    $base = if ($file -eq 'ort.wasm.min.js') { $CDN_ESM } else { $CDN_DIST }
    $dest = Join-Path $VENDOR $file
    if ((Test-Path -LiteralPath $dest) -and ((Get-Sha256 $dest) -eq $want)) {
        Write-Host "  [skip] $file already present and verified"
        continue
    }
    Write-Host "  Downloading $file ..."
    Invoke-WebRequest -Uri "$base/$file" -OutFile $dest -UseBasicParsing
    $got = Get-Sha256 $dest
    if ($got -ne $want) {
        Remove-Item -LiteralPath $dest -Force
        throw "$file does not match the pinned sha256 (expected $want, got $got). Nothing was kept."
    }
    Write-Host "    ok ($([math]::Round((Get-Item -LiteralPath $dest).Length / 1KB, 0)) KB)"
}

# Files from an earlier layout that the extension does not use.
foreach ($stale in 'ort-wasm-threaded.wasm', 'ort-wasm-simd-threaded.wasm') {
    $path = Join-Path $VENDOR $stale
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
        Write-Host "  [removed] unused $stale"
    }
}

Write-Host ""
Write-Host "Done. vendor/ contents:"
Get-ChildItem $VENDOR | Select-Object Name, @{N="KB";E={[math]::Round($_.Length/1KB,0)}}
