"""Multi-card identification pipeline for lot photos.

identify_all_from_bytes(image_bytes)  — detect + identify all cards in one image
identify_lot(lot_folder)              — process every image in a folder and
                                        deduplicate by identity across images
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from .detect_multi import detect_all_cards_with_crops
from .pipeline import identify_rectified_bytes
from .tcg_lookup import resolve_card
from .verify_grid import create_verification_grid

logger = logging.getLogger(__name__)


def pokemontcg_hires_url(set_code: Any, number: Any) -> Optional[str]:
    """Deterministic official-art URL (same rules as src/sniper/officialArt.js)."""
    code = str(set_code or "").strip()
    if not code or number is None or number == "":
        return None
    raw = str(number).split("/")[0].strip().lstrip("0") or "0"
    return f"https://images.pokemontcg.io/{code}/{raw}_hires.png"


def _with_official_art(identity: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Attach imageUrl without a network round-trip when setCode+number exist."""
    if not identity:
        return None
    if identity.get("imageUrl"):
        return identity
    url = pokemontcg_hires_url(identity.get("setCode"), identity.get("number"))
    if not url:
        return identity
    out = dict(identity)
    out["imageUrl"] = url
    return out


def _lot_grid_b64(cards: List[CardResult]) -> Optional[str]:
    """Didier-style official-art PNG (base64). Never raises — grid is optional UX."""
    tiles: List[Dict[str, Any]] = []
    for card in cards:
        if card.abstain or not card.identity:
            continue
        tiles.append({
            "name": card.identity.get("name") or "Unknown",
            "number": card.identity.get("number") or "?",
            "imageUrl": card.identity.get("imageUrl"),
            "set": card.identity.get("set"),
        })
    if not tiles:
        return None
    try:
        png = create_verification_grid(tiles)
        return base64.b64encode(png).decode("ascii")
    except Exception:
        logger.warning("verification grid failed; continuing without grid_png_b64", exc_info=True)
        return None


@dataclass
class CardResult:
    index: int
    box: tuple
    identity: Optional[Dict[str, Any]]
    confidence: str
    abstain: bool
    reason: Optional[str]
    source_image: str = ""
    crop_b64: str = ""

    def identity_key(self) -> Optional[str]:
        """Stable dedup key: name + normalised number."""
        if not self.identity:
            return None
        name = str(self.identity.get("name") or "").strip().lower()
        raw_num = str(self.identity.get("number") or "")
        num = raw_num.split("/")[0].lstrip("0") or "0"
        return f"{name}|{num}"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "box": list(self.box),
            "identity": self.identity,
            "confidence": self.confidence,
            "abstain": self.abstain,
            "reason": self.reason,
            "source_image": self.source_image,
            "imageUrl": (self.identity or {}).get("imageUrl"),
        }


@dataclass
class LotResult:
    lot_id: str
    total_detected: int
    total_identified: int
    cards: List[CardResult] = field(default_factory=list)
    grid_png_b64: Optional[str] = None

    @property
    def identification_rate(self) -> float:
        if self.total_detected == 0:
            return 0.0
        return self.total_identified / self.total_detected

    def as_dict(self) -> Dict[str, Any]:
        return {
            "lot_id": self.lot_id,
            "total_detected": self.total_detected,
            "total_identified": self.total_identified,
            "identification_rate": self.identification_rate,
            "cards": [c.as_dict() for c in self.cards],
            "grid_png_b64": self.grid_png_b64,
        }


def identify_all_from_bytes(
    image_bytes: bytes,
    source_image: str = "",
) -> List[CardResult]:
    """Detect all cards in image_bytes and return an identified CardResult per card."""
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image_bgr is None:
        return []

    hits = detect_all_cards_with_crops(image_bgr)
    results: List[CardResult] = []

    for hit in hits:
        crop_b64 = hit.get("crop_b64", "")
        try:
            crop_bytes = base64.b64decode(crop_b64)
        except Exception:
            results.append(CardResult(
                index=hit["index"],
                box=tuple(hit["box"]),
                identity=None,
                confidence="low",
                abstain=True,
                reason="crop_decode_error",
                source_image=source_image,
                crop_b64=crop_b64,
            ))
            continue

        id_result = identify_rectified_bytes(crop_bytes)
        identity = id_result.get("identity")

        # OCR number → TCG API only when fusion produced no identity
        if identity is None:
            ocr = (id_result.get("raw") or {}).get("ocr") or {}
            num = ocr.get("number")
            if num:
                tcg = resolve_card(num, set_id=ocr.get("setCode"))
                if tcg:
                    identity = {
                        "name": tcg.get("name"),
                        "set": tcg.get("set"),
                        "setCode": tcg.get("setCode"),
                        "number": tcg.get("number"),
                        "productId": tcg.get("id"),
                        "game": "pokemon",
                        "imageUrl": tcg.get("imageUrl")
                        or pokemontcg_hires_url(tcg.get("setCode"), tcg.get("number")),
                    }
                    id_result = {
                        **id_result,
                        "reason": "tcg-api-ocr",
                        "confidence": "medium",
                        "abstain": False,
                    }

        identity = _with_official_art(identity)

        results.append(CardResult(
            index=hit["index"],
            box=tuple(hit["box"]),
            identity=identity,
            confidence=id_result.get("confidence", "low"),
            abstain=bool(id_result.get("abstain", True)),
            reason=id_result.get("reason"),
            source_image=source_image,
            crop_b64=crop_b64,
        ))

    return results


def identify_lot(lot_folder: Path) -> LotResult:
    """Identify all cards across all images in lot_folder.

    Images are processed in sorted order. When the same card identity appears
    in multiple images (thumbnail + HD of the same lot), only the
    highest-confidence result is kept.
    """
    lot_id = lot_folder.name
    image_paths = sorted(
        p for p in lot_folder.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )

    all_results: List[CardResult] = []
    for img_path in image_paths:
        raw = img_path.read_bytes()
        cards = identify_all_from_bytes(raw, source_image=img_path.name)
        all_results.extend(cards)

    # Deduplicate: for each identity key, keep the result with best confidence
    _CONF_RANK = {"high": 3, "medium": 2, "low": 1}
    seen: Dict[str, CardResult] = {}
    unidentified: List[CardResult] = []

    for card in all_results:
        key = card.identity_key()
        if key is None:
            unidentified.append(card)
            continue
        existing = seen.get(key)
        if existing is None:
            seen[key] = card
        else:
            if _CONF_RANK.get(card.confidence, 0) > _CONF_RANK.get(existing.confidence, 0):
                seen[key] = card

    deduped = list(seen.values()) + unidentified
    identified = [c for c in deduped if not c.abstain and c.identity]

    return LotResult(
        lot_id=lot_id,
        total_detected=len(deduped),
        total_identified=len(identified),
        cards=deduped,
        grid_png_b64=_lot_grid_b64(identified),
    )
