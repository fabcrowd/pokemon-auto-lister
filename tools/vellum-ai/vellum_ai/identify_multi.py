"""Multi-card identification pipeline for lot photos.

identify_all_from_bytes(image_bytes)  — detect + identify all cards in one image
identify_lot(lot_folder)              — process every image in a folder and
                                        deduplicate by identity across images
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
from collections import Counter
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from .detect_multi import detect_all_cards_with_crops
from .local_verify import accept_verified, is_digital_only, verify_candidates
from .ocr import _ocr_rapid_lines
from .pipeline import identify_rectified_bytes
from .retrieve import get_index
from .slab_label import parse_label, resolve_label
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
    if identity.get("imageUrl") or identity.get("outOfCatalog"):
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


# A PSA label is ~3.4:1; a card on its side is only ~1.4:1, so wider boxes are labels.
_LABEL_ASPECT = 1.4
# Label sits directly above the card window inside the slab, within ~0.45 card heights.
_LABEL_REACH = 0.45
# Strip OCR costs ~0.2 s per card, so only spend it on slab-style photos with few cards.
_MAX_STRIP_READS = 6


def _read_text(image_bgr: np.ndarray, box) -> List[str]:
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    region = image_bgr[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
    if region.size == 0:
        return []
    return _ocr_rapid_lines(region)


def _catalog_meta() -> List[Dict[str, Any]]:
    index = get_index()
    index.load()
    return index.meta


@lru_cache(maxsize=4)
def _read_set_years(path: str, _mtime_ns: int) -> Dict[str, int]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _catalog_set_years() -> Dict[str, int]:
    path = get_index().catalog_dir / "set_years.json"
    if not path.is_file():
        logger.warning("%s missing; slab labels resolve without the year check (run catalog/set_years.py)", path)
        return {}
    return _read_set_years(str(path), path.stat().st_mtime_ns)


def _is_label_shaped(box) -> bool:
    x1, y1, x2, y2 = box
    return (x2 - x1) >= _LABEL_ASPECT * max(1.0, y2 - y1)


def _label_above(card_box, labels: List[tuple]) -> Optional[Dict[str, Any]]:
    x1, y1, x2, y2 = card_box
    reach = _LABEL_REACH * (y2 - y1)
    for (lx1, ly1, lx2, ly2), parsed in labels:
        overlap = min(x2, lx2) - max(x1, lx1)
        if overlap > 0.5 * min(x2 - x1, lx2 - lx1) and y1 - reach <= ly2 <= y1 + 0.1 * (y2 - y1):
            return parsed
    return None


def _split_labels(image_bgr: np.ndarray, hits: List[Dict[str, Any]]):
    cards: List[Dict[str, Any]] = []
    labels: List[tuple] = []
    for hit in hits:
        box = tuple(hit["box"])
        parsed = parse_label(_read_text(image_bgr, box)) if _is_label_shaped(box) else None
        if parsed:
            labels.append((box, parsed))
        else:
            cards.append(hit)
    return cards, labels


def _slab_identity(image_bgr: np.ndarray, card_box, labels: List[tuple], read_strip: bool):
    parsed = _label_above(card_box, labels)
    if parsed is None and read_strip:
        x1, y1, x2, y2 = card_box
        strip = (x1, max(0.0, y1 - _LABEL_REACH * (y2 - y1)), x2, y1)
        parsed = parse_label(_read_text(image_bgr, strip))
    if parsed is None:
        return None
    resolved = resolve_label(parsed, _catalog_meta(), _catalog_set_years())
    if resolved is not None:
        return resolved
    if parsed.get("grade") or parsed.get("cert"):
        return {"grade": parsed.get("grade"), "cert": parsed.get("cert"), "gradingCompany": "PSA", "gradingOnly": True}
    return None


def _merge_slab_identity(identity, id_result, slab):
    """Keep a verified visual id when the label is not a catalog card, and attach its grade."""
    if not slab:
        return identity, id_result
    grading = {key: slab.get(key) for key in ("grade", "cert", "gradingCompany") if slab.get(key) is not None}
    verified = identity is not None and not id_result.get("abstain", True)
    out_of_catalog = bool(
        slab.get("gradingOnly") or slab.get("outOfCatalog") or str(slab.get("productId") or "").startswith("label:")
    )
    if out_of_catalog and verified:
        return {**identity, **grading}, id_result
    if slab.get("gradingOnly") or not slab.get("productId"):
        return identity, id_result
    return slab, {**id_result, "reason": "slab-label", "confidence": "high", "abstain": False}


# Two cards from one set on a photo is enough to call it the page's set.
_MIN_SET_SUPPORT = 2
# Sets above this size (big modern sets, promos) cost too much SIFT per unresolved card.
_MAX_SET_POOL = 260


_NUMBER_CONFIRMED = {"verify-ocr-number", "slab-label", "tcg-api-ocr"}
# Identical art verifies almost equally well against both prints; a different-art print falls far behind.
_REPRINT_INLIER_RATIO = 0.8


def _decode_crop(crop_b64: str) -> Optional[np.ndarray]:
    try:
        raw = base64.b64decode(crop_b64, validate=True)
    except (binascii.Error, ValueError):
        return None
    return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR) if raw else None


def _same_art(crop: np.ndarray, current: dict, page_print: dict) -> bool:
    inliers = {h.get("id"): h.get("inliers", 0) for h in verify_candidates(crop, [current, page_print], k=2)}
    cur, page = inliers.get(current.get("id"), 0), inliers.get(page_print.get("id"), 0)
    return cur > 0 and page >= _REPRINT_INLIER_RATIO * cur


def _identity_of(meta_row: dict) -> Dict[str, Any]:
    return {
        "name": meta_row.get("name"), "set": meta_row.get("set"), "setCode": meta_row.get("setCode"),
        "number": meta_row.get("number"), "productId": meta_row.get("id"), "game": "pokemon",
    }


def _apply_set_context(results: List["CardResult"]) -> None:
    """Re-verify unresolved cards against every print in the photo's dominant set(s).

    Binder pages are usually sorted by set; once neighbours resolve (e.g. three Fossil cards),
    the blurry or rotated ones only need to be matched against that set's ~60 prints.
    """
    counts = Counter(
        (r.identity or {}).get("setCode") for r in results
        if not r.abstain and r.identity and not str(r.identity.get("productId") or "").startswith("label:")
    )
    sets = {code for code, n in counts.items() if code and n >= _MIN_SET_SUPPORT}
    if not sets:
        return
    pool = [m for m in _catalog_meta() if m.get("setCode") in sets and not is_digital_only(m.get("id"))]
    if not pool or len(pool) > _MAX_SET_POOL:
        return
    by_name: Dict[str, List[dict]] = {}
    for m in pool:
        by_name.setdefault(str(m.get("name") or "").lower(), []).append(m)
    by_id: Optional[Dict[str, dict]] = None
    for r in results:
        # Reprints (Fossil → Legendary Collection) share art, so features cannot split them; the page can.
        if r.abstain or not r.identity or r.identity.get("setCode") in sets or r.reason in _NUMBER_CONFIRMED:
            continue
        same = by_name.get(str(r.identity.get("name") or "").lower(), [])
        if len(same) != 1:
            continue
        if by_id is None:
            by_id = {m.get("id"): m for m in _catalog_meta()}
        current = by_id.get(r.identity.get("productId"))
        crop = _decode_crop(r.crop_b64) if r.crop_b64 else None
        if current is None or crop is None or not _same_art(crop, current, same[0]):
            continue
        r.identity = _with_official_art(_identity_of(same[0]))
        r.confidence, r.reason = "medium", "set-context-reprint"
    for r in results:
        if not r.abstain or not r.crop_b64:
            continue
        crop = _decode_crop(r.crop_b64)
        if crop is None:
            continue
        ranked = verify_candidates(crop, pool, k=len(pool))
        if not accept_verified(ranked):
            continue
        r.identity = _with_official_art(_identity_of(ranked[0]))
        r.confidence, r.abstain, r.reason = "medium", False, "set-context-verify"


def identify_all_from_bytes(
    image_bytes: bytes,
    source_image: str = "",
) -> List[CardResult]:
    """Detect all cards in image_bytes and return an identified CardResult per card."""
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image_bgr is None:
        return []

    hits, labels = _split_labels(image_bgr, detect_all_cards_with_crops(image_bgr))
    read_strips = len(hits) <= _MAX_STRIP_READS
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

        slab = _slab_identity(image_bgr, tuple(hit["box"]), labels, read_strips)
        identity, id_result = _merge_slab_identity(identity, id_result, slab)

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

    _apply_set_context(results)
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
