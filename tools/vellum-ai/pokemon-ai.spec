# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the Pokemon Card Scanner AI server (identify_server.py).
#
# Build from tools/vellum-ai/:
#   pyinstaller pokemon-ai.spec --distpath dist-py --workpath build-py --noconfirm
#
# Or via the top-level build script:
#   node installer/build.mjs
#
# Output: tools/vellum-ai/dist-py/identify_server/identify_server.exe
#
import sys
import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# ─── Collect data files from packages that embed models / assets ────────────

# rapidocr bundles ONNX models and config files inside the package
datas = []
datas += collect_data_files('rapidocr_onnxruntime', include_py_files=False)

# opencv may need Haar cascades etc.
datas += collect_data_files('cv2', include_py_files=False)

# The card detection ONNX model
ONNX_MODEL = Path('models/card_detect.onnx')
if ONNX_MODEL.exists():
    datas += [(str(ONNX_MODEL), 'models')]

# ─── Hidden imports ─────────────────────────────────────────────────────────

hiddenimports = [
    # uvicorn internals (not auto-detected due to dynamic loading)
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.loops.asyncio',
    'uvicorn.loops.uvloop',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.http.httptools_impl',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.protocols.websockets.websockets_impl',
    'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'uvicorn.lifespan.off',
    # fastapi / starlette
    'fastapi',
    'starlette',
    'starlette.routing',
    'starlette.middleware',
    'starlette.middleware.cors',
    # multipart
    'multipart',
    'python_multipart',
    # image/ML stack
    'PIL',
    'PIL._imaging',
    'PIL.Image',
    'numpy',
    'cv2',
    'onnxruntime',
    'ImageHash',
    'imagehash',
    # rapidocr
    'rapidocr_onnxruntime',
]

# Collect all submodules of rapidocr and vellum_ai package
hiddenimports += collect_submodules('rapidocr_onnxruntime')
hiddenimports += collect_submodules('vellum_ai')

# ─── Analysis ────────────────────────────────────────────────────────────────

a = Analysis(
    ['identify_server.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # optional heavy deps not needed for inference
        'torch',
        'torchvision',
        'ultralytics',
        'faiss',
        'open_clip',
        'paddleocr',
        'matplotlib',
        'tkinter',
        '_tkinter',
        'IPython',
        'jupyter',
        'notebook',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='identify_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX can break ONNX DLLs on Windows
    console=True,  # keep console for service log visibility
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='identify_server',
)
