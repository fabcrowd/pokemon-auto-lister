"""End-to-end identify pipeline for one front image."""

from __future__ import annotations

from typing import Any, Dict, Optional

import cv2
import numpy as np

from .collectr_resolve import get_collectr_catalog
from .detect import detect_and_rectify
from .fusion import default_margin, default_require_ocr, fuse_candidates
from .ocr import run_ocr
from .rectify import blur_score, estimate_centering, glare_score
from .retrieve import get_index


def identify_image_bytes(front_bytes: bytes, back_bytes: Optional[bytes] = None) -> Dict[str, Any]:
    array = np.frombuffer(front_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        return _abstain("invalid_image")

    detected = detect_and_rectify(image)
    if not detected["ok"]:
        return _abstain(detected["reason"] or "no_card_detected")

    rectified = detected["rectified"]
    glare = glare_score(rectified)
    blur = blur_score(rectified)
    centering = estimate_centering(rectified)

    # Holo foils routinely light up >8% of pixels — only reject extreme flash washout.
    if glare >= 0.35:
        return {
            **_abstain("glare_too_high"),
            "grading": {"centering": centering},
            "captureQa": {"glare": glare, "blur": blur},
        }
    if blur < 15:
        return {
            **_abstain("blur_too_high"),
            "grading": {"centering": centering},
            "captureQa": {"glare": glare, "blur": blur},
        }

    index = get_index()
    clip_hits = index.search(rectified, k=20) if index.available() else []
    ocr = run_ocr(rectified)
    finish = _finish_heuristic(rectified)

    fused = fuse_candidates(
        clip_hits,
        ocr=ocr,
        require_ocr=default_require_ocr() and bool(clip_hits),
        margin=default_margin(),
    )

    # Collectr CSV fallback when CLIP catalog is missing or fusion abstains
    if fused.get("abstain") or not clip_hits:
        collectr = get_collectr_catalog()
        if collectr.available() and ocr.get("number"):
            hit = collectr.resolve(ocr)
            if hit:
                return {
                    "source": "vellum-ai",
                    "identity": {
                        "name": hit.get("name"),
                        "set": hit.get("set"),
                        "setCode": hit.get("setCode"),
                        "number": hit.get("number"),
                        "productId": hit.get("id"),
                        "game": "pokemon",
                    },
                    "finish": finish,
                    "confidence": "high",
                    "candidates": [hit],
                    "abstain": False,
                    "reason": "collectr-ocr",
                    "grading": {"centering": centering, "note": "AI centering QA — not a PSA grade"},
                    "captureQa": {"glare": glare, "blur": blur, "box": detected.get("box")},
                    "raw": {"ocr": ocr, "backProvided": back_bytes is not None, "resolve": "collectr-csv"},
                }
            # Ambiguous number — expose candidates for review
            cands = collectr.candidates_for_number(
                f"{ocr['number']}/{ocr['total']}" if ocr.get("total") else str(ocr["number"])
            )
            if cands:
                return {
                    "source": "vellum-ai",
                    "identity": None,
                    "finish": finish,
                    "confidence": "low",
                    "candidates": cands[:5],
                    "abstain": True,
                    "reason": "collectr_ambiguous",
                    "grading": {"centering": centering, "note": "AI centering QA — not a PSA grade"},
                    "captureQa": {"glare": glare, "blur": blur, "box": detected.get("box")},
                    "raw": {"ocr": ocr, "backProvided": back_bytes is not None},
                }

    if not clip_hits and fused.get("abstain"):
        fused = {
            "abstain": True,
            "reason": fused.get("reason") or ("ocr_missing" if not ocr.get("number") else "catalog_missing"),
            "identity": None,
            "confidence": "low",
            "candidates": fused.get("candidates") or [],
            "ocr": ocr,
        }

    return {
        "source": "vellum-ai",
        "identity": fused.get("identity"),
        "finish": finish,
        "confidence": fused.get("confidence", "low"),
        "candidates": fused.get("candidates", []),
        "abstain": bool(fused.get("abstain", True)),
        "reason": fused.get("reason"),
        "grading": {"centering": centering, "note": "AI centering QA — not a PSA grade"},
        "captureQa": {"glare": glare, "blur": blur, "box": detected.get("box")},
        "raw": {"ocr": ocr, "margin": fused.get("margin"), "backProvided": back_bytes is not None},
    }


def _finish_heuristic(rectified_bgr: np.ndarray) -> str:
    """Crude foil heuristic from highlight variance in art region."""
    h = rectified_bgr.shape[0]
    art = rectified_bgr[: int(h * 0.5), :, :]
    hsv = cv2.cvtColor(art, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1].astype(np.float32)
    val = hsv[:, :, 2].astype(np.float32)
    sparkle = float(np.std(val) + 0.5 * np.std(sat))
    if sparkle > 55:
        return "holo"
    if sparkle > 38:
        return "reverse"
    return "non_holo"


def _abstain(reason: str) -> Dict[str, Any]:
    return {
        "source": "vellum-ai",
        "identity": None,
        "finish": None,
        "confidence": "low",
        "candidates": [],
        "abstain": True,
        "reason": reason,
        "grading": None,
        "raw": {},
    }
