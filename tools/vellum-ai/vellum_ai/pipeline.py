"""End-to-end identify pipeline for one front image."""

from __future__ import annotations

from typing import Any, Dict, Optional

import cv2
import numpy as np

from .collectr_resolve import get_collectr_catalog
from .detect import detect_and_rectify
from .fusion import default_margin, default_require_ocr, fuse_candidates
from .local_verify import MIN_INLIERS, accept_verified, physical_hits, verify_candidates
from .name_candidates import get_name_index
from .ocr import read_name_lines, run_ocr
from .phash import get_catalog_phash_lookup, rerank_clip_hits
from .rectify import blur_score, estimate_centering, glare_score
from .retrieve import get_index


def identify_rectified_bytes(front_bytes: bytes) -> Dict[str, Any]:
    """Identify an already-rectified single-card crop (skips detect step)."""
    array = np.frombuffer(front_bytes, dtype=np.uint8)
    rectified = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if rectified is None:
        return _abstain("invalid_image")
    return _identify_rectified(rectified)


def identify_image_bytes(front_bytes: bytes, back_bytes: Optional[bytes] = None) -> Dict[str, Any]:
    array = np.frombuffer(front_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        return _abstain("invalid_image")

    detected = detect_and_rectify(image)
    if not detected["ok"]:
        return _abstain(detected["reason"] or "no_card_detected")

    result = _identify_rectified(detected["rectified"])
    # Attach box from detect step to captureQa
    if "captureQa" in result and detected.get("box"):
        result["captureQa"]["box"] = detected["box"]
    if "raw" in result:
        result["raw"]["backProvided"] = back_bytes is not None
    return result


# Common names (Pikachu, basic energies) have 60+ prints; cap the geometric pass.
_MAX_NAME_PRINTS = 80
# Same-art reprints (Twilight vs Prismatic Leafeon) score within ~40% of each other on geometry.
_REPRINT_RATIO = 0.4


def _num(value: Any) -> str:
    return str(value or "").split("/")[0].strip().lower().lstrip("0") or "0"


def _rank_name_prints(named: list, number: Optional[str], deep_hits: list) -> list:
    """Order name hits so the 80-print cap keeps the OCR number, then the CLIP score."""
    scores = {hit.get("id"): float(hit.get("score") or 0) for hit in deep_hits}
    wanted = _num(number) if number else ""

    def sort_key(item):
        index, hit = item
        number_rank = 0 if wanted and _num(hit.get("number")) == wanted else 1
        return (number_rank, -scores.get(hit.get("id"), 0.0), index)

    return [hit for _, hit in sorted(enumerate(named), key=sort_key)]


def _split_reprints(rectified: np.ndarray, ranked: list) -> Optional[Dict[str, Any]]:
    """The print whose collector number OCR reads, when geometry cannot tell same-art reprints apart."""
    if not ranked or ranked[0]["inliers"] < MIN_INLIERS:
        return None
    name = str(ranked[0].get("name") or "").lower()
    group = [ranked[0]] + [
        h for h in ranked[1:6]
        if str(h.get("name") or "").lower() == name and h["inliers"] >= _REPRINT_RATIO * ranked[0]["inliers"]
    ]
    if len(group) < 2:
        return None
    number = run_ocr(rectified).get("number")
    if not number:
        return None
    pick = [h for h in group if _num(h.get("number")) == _num(number)]
    return pick[0] if len(pick) == 1 else None


def _identify_rectified(rectified: np.ndarray) -> Dict[str, Any]:
    """Run identification on a pre-rectified card image (no detect step)."""
    glare = glare_score(rectified)
    blur = blur_score(rectified)
    centering = estimate_centering(rectified)

    index = get_index()
    # Over-fetch: digital-only TCG Pocket entries are dropped before ranking.
    # Ranks 41-60 are not geometrically checked, but their scores still order the name list.
    retrieved = physical_hits(index.search(rectified, k=60)) if index.available() else []
    deep_hits = retrieved[:40]
    clip_hits = deep_hits[:20]
    verified = []
    if clip_hits:
        clip_hits = rerank_clip_hits(rectified, clip_hits, get_catalog_phash_lookup())
        verified = verify_candidates(rectified, clip_hits)
        if not accept_verified(verified) and len(deep_hits) > 20:
            # Binder crops sometimes rank the true card 20-40 in CLIP; geometry still separates it.
            deeper = verify_candidates(rectified, deep_hits[20:])
            verified = sorted(verified + deeper, key=lambda h: h["inliers"], reverse=True)
    reason = "local-feature-verify"
    if not accept_verified(verified):
        # CLIP can miss the true card entirely on real photos; the printed name narrows
        # the catalog to a few prints that geometry can still separate.
        seen = {h.get("id") for h in verified}
        named = [h for h in get_name_index().candidates(read_name_lines(rectified)) if h.get("id") not in seen]
        if named:
            number = run_ocr(rectified).get("number")
            ranked_named = _rank_name_prints(named, number, retrieved)[:_MAX_NAME_PRINTS]
            by_name = verify_candidates(rectified, ranked_named, k=_MAX_NAME_PRINTS)
            verified = sorted(verified + by_name, key=lambda h: h["inliers"], reverse=True)
            if verified and verified[0].get("id") in {h.get("id") for h in by_name}:
                reason = "name-feature-verify"
    chosen = _split_reprints(rectified, verified)
    if chosen is not None:
        verified = [chosen] + [h for h in verified if h is not chosen]
        reason = "verify-ocr-number"
    if chosen is not None or accept_verified(verified):
        top = verified[0]
        return {
            "source": "vellum-ai",
            "identity": {
                "name": top.get("name"),
                "set": top.get("set"),
                "setCode": top.get("setCode"),
                "number": top.get("number"),
                "productId": top.get("id"),
                "game": top.get("game") or "pokemon",
            },
            "finish": _finish_heuristic(rectified),
            "confidence": "high",
            "candidates": [
                {"id": c.get("id"), "name": c.get("name"), "setCode": c.get("setCode"),
                 "number": c.get("number"), "inliers": c["inliers"]}
                for c in verified[:5]
            ],
            "abstain": False,
            "reason": reason,
            "grading": {"centering": centering, "note": "AI centering QA — not a PSA grade"},
            "captureQa": {"glare": glare, "blur": blur},
            "raw": {"inliers": [c["inliers"] for c in verified[:5]]},
        }
    # Quality gates protect only the CLIP/OCR fallback; a strong geometric match
    # above already proves the crop is usable (binder photos often score as blurry).
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

    ocr = run_ocr(rectified)
    finish = _finish_heuristic(rectified)

    fused = fuse_candidates(
        clip_hits,
        ocr=ocr,
        require_ocr=default_require_ocr() and bool(clip_hits),
        margin=default_margin(),
    )

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
                    "captureQa": {"glare": glare, "blur": blur},
                    "raw": {"ocr": ocr, "resolve": "collectr-csv"},
                }
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
                    "captureQa": {"glare": glare, "blur": blur},
                    "raw": {"ocr": ocr},
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
        "captureQa": {"glare": glare, "blur": blur},
        "raw": {"ocr": ocr, "margin": fused.get("margin")},
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
