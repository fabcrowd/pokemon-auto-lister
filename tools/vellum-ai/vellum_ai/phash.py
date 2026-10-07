"""Perceptual-hash helpers for CLIP top-K rerank.

Ported from qtran1018/TCG (unlicensed; small attributed copy):
  backend/app/services/card_embedder.py — crop_art / compute_phash
  backend/app/api/v1/scan.py — hamming / PHASH_STRONG rerank
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Union

import numpy as np

logger = logging.getLogger(__name__)

# qtran scan.py constants
PHASH_STRONG = 20
SIM_THRESHOLD = 0.65  # informational; fuse margin stays elsewhere
SIM_FLOOR = 0.45

ImageLike = Union["Image.Image", bytes, np.ndarray]


def crop_art(img: "Image.Image") -> "Image.Image":
    """Crop to the card art region (qtran _crop_art).

    Standard cards: art box roughly y=12%-52%, x=4%-96%.
    Full-art: captures the upper subject area.
    """
    w, h = img.size
    return img.crop((int(w * 0.04), int(h * 0.12), int(w * 0.96), int(h * 0.52)))


def _to_pil(src: ImageLike) -> "Image.Image":
    from PIL import Image

    if isinstance(src, Image.Image):
        return src if src.mode == "RGB" else src.convert("RGB")
    if isinstance(src, (bytes, bytearray)):
        import io

        return Image.open(io.BytesIO(src)).convert("RGB")
    if isinstance(src, np.ndarray):
        # Assume BGR OpenCV array
        rgb = src[:, :, ::-1] if src.ndim == 3 and src.shape[2] == 3 else src
        return Image.fromarray(np.ascontiguousarray(rgb)).convert("RGB")
    raise TypeError(f"unsupported image type: {type(src)!r}")


def compute_phash(src: ImageLike) -> Optional[str]:
    """Perceptual hash of the art-region crop. Returns hex string or None."""
    try:
        import imagehash

        img = _to_pil(src)
        return str(imagehash.phash(crop_art(img)))
    except Exception:
        logger.debug("phash computation failed", exc_info=True)
        return None


def hamming(a: Optional[str], b: Optional[str]) -> int:
    """Hamming distance between two hex pHash strings. Missing → 999."""
    if not a or not b:
        return 999
    try:
        import imagehash

        return int(imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b))
    except Exception:
        logger.debug("phash hamming failed for a=%s b=%s", a, b, exc_info=True)
        return 999


def load_phash_map(catalog_dir: Optional[Path] = None) -> Dict[str, str]:
    """Load card-id → phash hex from sidecar phash.json or meta.json rows."""
    import json
    import os

    root = Path(
        catalog_dir
        or os.environ.get(
            "VELLUM_AI_CATALOG_DIR",
            Path(__file__).resolve().parents[3] / "data" / "card-catalog",
        )
    )
    sidecar = root / "phash.json"
    if sidecar.is_file():
        try:
            data = json.loads(sidecar.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {str(k): str(v) for k, v in data.items() if v}
        except Exception:
            logger.warning("failed to read %s", sidecar, exc_info=True)

    meta_path = root / "meta.json"
    if not meta_path.is_file():
        return {}
    try:
        rows = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out: Dict[str, str] = {}
    for row in rows if isinstance(rows, list) else []:
        cid = str(row.get("id") or "")
        ph = row.get("phash")
        if cid and ph:
            out[cid] = str(ph)
    return out


_phash_cache: Optional[Dict[str, str]] = None


def get_catalog_phash_lookup() -> Callable[[str], Optional[str]]:
    """Lazy catalog phash lookup by card id."""
    global _phash_cache

    def lookup(card_id: str) -> Optional[str]:
        global _phash_cache
        if _phash_cache is None:
            _phash_cache = load_phash_map()
        return _phash_cache.get(str(card_id))

    return lookup


def rerank_clip_hits(
    query_bgr: np.ndarray,
    hits: Sequence[Mapping[str, Any]],
    catalog_phash_lookup: Union[Mapping[str, Optional[str]], Callable[[str], Optional[str]]],
) -> List[Dict[str, Any]]:
    """Re-order CLIP hits: strong pHash (≤ PHASH_STRONG) first, then by CLIP score.

    When no catalog phash is available for any hit, returns hits unchanged
    (aside from attaching phash metadata fields).
    """
    if not hits:
        return []

    query_hash = compute_phash(query_bgr)
    lookup_fn: Callable[[str], Optional[str]]
    if callable(catalog_phash_lookup):
        lookup_fn = catalog_phash_lookup  # type: ignore[assignment]
    else:
        mapping = catalog_phash_lookup

        def lookup_fn(card_id: str) -> Optional[str]:
            return mapping.get(str(card_id))  # type: ignore[union-attr]

    scored: List[Dict[str, Any]] = []
    any_catalog = False
    for hit in hits:
        row = dict(hit)
        cid = str(row.get("id") or row.get("productId") or "")
        catalog_hash = lookup_fn(cid) if cid else None
        if catalog_hash:
            any_catalog = True
        dist = hamming(query_hash, catalog_hash)
        strong = dist <= PHASH_STRONG
        row["phashHamming"] = dist
        row["phashStrong"] = strong
        row["queryPhash"] = query_hash
        scored.append(row)

    if not any_catalog or query_hash is None:
        return [dict(h) for h in hits]

    # Sort key mirrors qtran: (0 if phash_strong else 1, -sim)
    scored.sort(
        key=lambda r: (
            0 if r.get("phashStrong") else 1,
            -float(r.get("score") or 0.0),
        )
    )
    return scored
