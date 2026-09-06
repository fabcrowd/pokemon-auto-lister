"""RRF fusion + accept/abstain gates for VellumAI ID."""

from __future__ import annotations

import os
import re
from typing import Any, Dict, List, Optional, Sequence

NUMBER_RE = re.compile(r"(?<!\d)(\d{1,3})\s*/\s*(\d{1,3})(?!\d)")
# OCR often glues set/lang onto the number: POREW091/088☆ or CRIEN 088/086
NUMBER_GLUED_RE = re.compile(r"(?:POR|CRI|MEG|SV[I]?|TEF|TWM|PAL|OBF)?\s*(?:EN|EW|E|J)?\s*(\d{2,3})\s*/\s*(\d{2,3})", re.I)
NUMBER_LOOSE_RE = re.compile(r"(\d{2,3})\s*/\s*(\d{2,3})")
KNOWN_SET_CODES = {
    "por",
    "cri",
    "meg",
    "svp",
    "svi",
    "sv3",
    "sv4",
    "sv5",
    "sv6",
    "sv7",
    "sv8",
    "tef",
    "twm",
    "pal",
    "obf",
    "par",
    "paf",
}
SET_CODE_RE = re.compile(r"\b([A-Z]{2,5}\d{0,2})\b")


def parse_ocr_text(text: str) -> Dict[str, Optional[str]]:
    """Extract collector number and a plausible set code from OCR text."""
    raw = text or ""
    # Normalize star / odd glyphs that trail collector numbers
    cleaned = (
        raw.replace("☆", " ")
        .replace("★", " ")
        .replace("∗", " ")
        .replace("·", " ")
    )
    number = None
    total = None
    match = (
        NUMBER_RE.search(cleaned)
        or NUMBER_GLUED_RE.search(cleaned.replace(" ", ""))
        or NUMBER_GLUED_RE.search(cleaned)
        or NUMBER_LOOSE_RE.search(cleaned.replace(" ", ""))
        or NUMBER_LOOSE_RE.search(cleaned)
    )
    if match:
        left = match.group(1)
        total = match.group(2)
        number = left if len(left) >= 2 else (left.lstrip("0") or "0")
    set_code = None
    upper = cleaned.upper()
    # Prefer explicit set tokens; allow glued OCR like CRIEN / POREW
    for known in ("por", "cri", "svp", "svi", "tef", "twm", "pal", "obf", "par", "paf", "meg"):
        # Match POR / POREN / POREW091… — digits after set+lang are OK
        if re.search(rf"(?<![A-Z0-9]){known}(?:EN|EW|E|J)?(?![A-Z])", upper, re.I):
            set_code = known
            break
    if not set_code:
        for code in SET_CODE_RE.findall(upper):
            if code in {"HP", "ATK", "WEAK", "RES", "RETREAT", "EN", "EW", "GAME", "MEGA", "ITS"}:
                continue
            low = code.lower()
            if low in KNOWN_SET_CODES:
                set_code = low
                break
            if len(code) >= 3 and low not in {"its", "the", "and", "for"}:
                set_code = low
                break
    return {"number": number, "total": total, "setCode": set_code, "raw": raw}


def rrf_score(ranks: Sequence[Optional[int]], k: int = 60) -> float:
    """Reciprocal rank fusion over parallel ranked lists (1-based ranks)."""
    total = 0.0
    for rank in ranks:
        if rank is None or rank < 1:
            continue
        total += 1.0 / (k + rank)
    return total


def _name_tokens(name: Any) -> set:
    return {t.lower() for t in re.split(r"[\s\-]+", str(name or "")) if len(t) >= 3}


def fuse_candidates(
    clip_ranked: Sequence[Dict[str, Any]],
    ocr: Optional[Dict[str, Optional[str]]] = None,
    require_ocr: bool = False,
    margin: float = 0.02,
) -> Dict[str, Any]:
    """
    Fuse CLIP top-K with OCR hard-filter.

    Each clip item: { id, name, set, setCode, number, score?, finish? }
    """
    ocr = ocr or {}
    ocr_number = ocr.get("number")
    ocr_set = (ocr.get("setCode") or "").lower() or None
    ocr_name_tokens = _name_tokens(ocr.get("name"))

    filtered: List[Dict[str, Any]] = list(clip_ranked)
    if ocr_number:
        hard = [
            c
            for c in clip_ranked
            if _norm_number(c.get("number")) == _norm_number(ocr_number)
            and (not ocr_set or _norm(c.get("setCode")) == _norm(ocr_set) or not c.get("setCode"))
        ]
        if hard:
            filtered = hard

    if require_ocr and not ocr_number:
        return {
            "abstain": True,
            "reason": "ocr_required_missing",
            "identity": None,
            "candidates": list(clip_ranked)[:5],
            "confidence": "low",
        }

    if not filtered:
        return {
            "abstain": True,
            "reason": "no_candidates",
            "identity": None,
            "candidates": [],
            "confidence": "low",
        }

    scored: List[Dict[str, Any]] = []
    for idx, cand in enumerate(filtered):
        clip_rank = idx + 1
        ocr_rank = 1 if ocr_number and _norm_number(cand.get("number")) == _norm_number(ocr_number) else None
        score = rrf_score([clip_rank, ocr_rank])
        if ocr_rank == 1:
            score += 0.05
        # Name signal: boost on overlap, penalise on total mismatch
        if ocr_name_tokens:
            cand_tokens = _name_tokens(cand.get("name"))
            if cand_tokens and ocr_name_tokens & cand_tokens:
                score += 0.10
            elif cand_tokens and not (ocr_name_tokens & cand_tokens):
                score -= 0.05
        scored.append({**cand, "fuseScore": score, "clipRank": clip_rank})

    scored.sort(key=lambda c: c["fuseScore"], reverse=True)
    top = scored[0]
    second = scored[1] if len(scored) > 1 else None
    top_score = float(top["fuseScore"])
    second_score = float(second["fuseScore"]) if second else 0.0
    gap = top_score - second_score

    ocr_agrees = bool(
        ocr_number and _norm_number(top.get("number")) == _norm_number(ocr_number)
    )
    unique_art = second is None or gap >= margin * 3

    accept = (ocr_agrees and gap >= margin) or (not ocr_number and unique_art and gap >= margin)
    if require_ocr:
        accept = ocr_agrees and gap >= margin

    identity = {
        "name": top.get("name"),
        "set": top.get("set"),
        "setCode": top.get("setCode"),
        "number": top.get("number"),
        "productId": top.get("id") or top.get("productId"),
        "game": top.get("game") or "pokemon",
    }

    return {
        "abstain": not accept,
        "reason": None if accept else "low_margin_or_ocr_mismatch",
        "identity": identity if accept else None,
        "finish": top.get("finish"),
        "confidence": "high" if accept else "low",
        "candidates": [
            {
                "setCode": c.get("setCode"),
                "number": c.get("number"),
                "name": c.get("name"),
                "score": c.get("fuseScore"),
            }
            for c in scored[:5]
        ],
        "margin": gap,
        "ocr": ocr,
    }


def default_margin() -> float:
    return float(os.environ.get("VELLUM_AI_ACCEPT_MARGIN", "0.02"))


def default_require_ocr() -> bool:
    return str(os.environ.get("VELLUM_AI_REQUIRE_OCR", "true")).lower() in {"1", "true", "yes", "on"}


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _norm_number(value: Any) -> str:
    text = str(value or "").lower().replace(" ", "")
    text = text.split("/")[0]
    return text.lstrip("0") or "0"
