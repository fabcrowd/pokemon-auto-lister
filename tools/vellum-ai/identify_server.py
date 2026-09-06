"""
VellumAI FastAPI sidecar.

Run from tools/vellum-ai:
  python -m venv .venv
  .venv\\Scripts\\pip install -r requirements.txt
  .venv\\Scripts\\python identify_server.py
"""

from __future__ import annotations

import os
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

from vellum_ai import __version__
from vellum_ai.pipeline import identify_image_bytes
from vellum_ai.retrieve import get_index

app = FastAPI(title="VellumAI", version=__version__)


@app.get("/health")
def health() -> dict:
    index = get_index()
    return {
        "ok": True,
        "service": "vellum-ai",
        "version": __version(),
        "catalog": index.available(),
        "catalogDir": str(index.catalog_dir),
    }


@app.post("/identify")
async def identify(
    front: UploadFile = File(...),
    back: Optional[UploadFile] = File(None),
) -> JSONResponse:
    front_bytes = await front.read()
    back_bytes = await back.read() if back is not None else None
    result = identify_image_bytes(front_bytes, back_bytes)
    return JSONResponse(result)


def main() -> None:
    host = os.environ.get("VELLUM_AI_HOST", "127.0.0.1")
    port = int(os.environ.get("VELLUM_AI_PORT", "8787"))
    uvicorn.run("identify_server:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
