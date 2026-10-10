# Download onnxruntime-web ESM build + WASM files into dist/extension-wasm/vendor/
# Run once before loading the extension in Chrome.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/setup_vendor.ps1

$ErrorActionPreference = "Stop"

$ORT_VERSION = "1.17.3"
$CDN_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT_VERSION/dist"
$CDN_ESM  = "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT_VERSION/dist/esm"
$VENDOR = "$PSScriptRoot\..\dist\extension-wasm\vendor"

if (-not (Test-Path $VENDOR)) {
    New-Item -ItemType Directory -Force -Path $VENDOR | Out-Null
}

# file → base CDN path
$FILES = @(
    @{ name = "ort.wasm.min.js";           base = $CDN_ESM  },
    @{ name = "ort-wasm.wasm";             base = $CDN_DIST },
    @{ name = "ort-wasm-simd.wasm";        base = $CDN_DIST },
    @{ name = "ort-wasm-threaded.wasm";    base = $CDN_DIST },
    @{ name = "ort-wasm-simd-threaded.wasm"; base = $CDN_DIST }
)

Write-Host "Downloading onnxruntime-web $ORT_VERSION files to $VENDOR ..."

foreach ($entry in $FILES) {
    $file = $entry.name
    $url  = "$($entry.base)/$file"
    $dest = "$VENDOR\$file"
    if (Test-Path $dest) {
        Write-Host "  [skip] $file already exists"
        continue
    }
    Write-Host "  Downloading $file ..."
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    $kb = [math]::Round((Get-Item $dest).Length / 1KB, 0)
    Write-Host "    → $kb KB"
}

Write-Host ""
Write-Host "Done. vendor/ contents:"
Get-ChildItem $VENDOR | Select-Object Name, @{N="KB";E={[math]::Round($_.Length/1KB,0)}}
