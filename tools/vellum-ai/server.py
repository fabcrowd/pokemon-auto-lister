"""Chrome extension sidecar — POST /detect, GET /health.

Run from tools/vellum-ai:
  .venv\\Scripts\\python server.py
  # or
  python server.py

Listens on http://127.0.0.1:7331
"""

from __future__ import annotations

import asyncio
import base64
import logging
import pathlib
import sys
from concurrent.futures import ThreadPoolExecutor

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import os as _os

# Default harvest dir for self-improving loop. Set VELLUM_HARVEST_DIR='' to disable.
if "VELLUM_HARVEST_DIR" not in _os.environ:
    _harvest_root = pathlib.Path(__file__).resolve().parent.parent.parent / "data" / "harvest"
    _os.environ["VELLUM_HARVEST_DIR"] = str(_harvest_root)

from pricing import get_price
from vellum_ai.identify_multi import identify_all_from_bytes

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# One worker so the GPU/CPU model runs serially (avoids OOM and contention)
_executor = ThreadPoolExecutor(max_workers=1)

app = FastAPI(title="pokemon-card-scanner", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class DetectRequest(BaseModel):
    image_b64: str  # base64-encoded JPEG from the webcam frame


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "pokemon-card-scanner"}


@app.post("/detect")
async def detect(req: DetectRequest) -> dict:
    try:
        image_bytes = base64.b64decode(req.image_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64 payload")

    loop = asyncio.get_event_loop()

    # Run CPU-bound pipeline off the async thread
    cards = await loop.run_in_executor(_executor, identify_all_from_bytes, image_bytes)

    results = []
    for card in cards:
        # as_dict() gives box as [x1,y1,x2,y2] and identity as a nested dict —
        # exactly the shape popup.js expects
        entry = card.as_dict()

        if not card.abstain and card.identity:
            price = await loop.run_in_executor(None, get_price, card.identity)
            # spread market_price, price_variant, price_low, price_high, price_source
            entry.update(price)

        results.append(entry)

    identified = sum(1 for r in results if not r.get("abstain"))
    logger.info("detect: %d detected, %d identified", len(results), identified)
    return {
        "cards": results,
        "total_detected": len(results),
        "total_identified": identified,
    }


if __name__ == "__main__":
    import os
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "7331"))
    uvicorn.run(app, host=host, port=port, reload=False)
