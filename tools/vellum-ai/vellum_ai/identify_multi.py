"""Multi-card identification pipeline for lot photos.

identify_all_from_bytes(image_bytes)  — detect + identify all cards in one image
identify_lot(lot_folder)              — process every image in a folder and
                                        deduplicate by identity across images
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from .detect_multi import detect_all_cards_with_crops
from .pipeline import identify_rectified_bytes
from .tcg_lookup import resolve_card


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
        }


@dataclass
class LotResult:
    lot_id: str
    total_detected: int
    total_identified: int
    cards: List[CardResult] = field(default_factory=list)

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

        # TCG API cross-reference: augment identity when OCR found a number
        # but CLIP/Collectr returned nothing or low confidence
        if not identity and not id_result.get("abstain") is False:
            ocr = id_result.get("raw", {}).get("ocr") or {}
            num = ocr.get("number")
            set_code = ocr.get("setCode")
            if num:
                tcg = resolve_card(num, set_id=set_code)
                if tcg:
                    identity = {
                        "name": tcg.get("name"),
                        "set": tcg.get("set"),
                        "setCode": tcg.get("setCode"),
                        "number": tcg.get("number"),
                        "productId": tcg.get("id"),
                        "game": "pokemon",
                    }
                    id_result["reason"] = "tcg-api-ocr"
                    id_result["confidence"] = "medium"
                    id_result["abstain"] = False

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
    )
