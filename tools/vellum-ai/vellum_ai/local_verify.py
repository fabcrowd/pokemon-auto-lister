"""Geometric verification of CLIP candidates with local features (SIFT + RANSAC).

CLIP gets the true card into its top 20 almost always on real listing photos,
but only ~60% at rank 1: reprints and same-species cards look alike globally.
Counting homography inliers between the photo crop and each candidate's
catalog image separates them (dev set: correct ≥ 73 inliers, wrong ≤ 8).
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import cv2
import numpy as np

DEFAULT_IMAGES = Path(
    os.environ.get(
        "VELLUM_AI_CATALOG_DIR",
        Path(__file__).resolve().parents[3] / "data" / "card-catalog",
    )
) / "images"

# TCG Pocket is digital-only (TCGdex ids A1-…, A3b-…, B1-…, P-A-…); it can never be in a photo.
_DIGITAL_ONLY = re.compile(r"^(A\d|B\d|P-A)")
_SIZE = (400, 560)
_RATIO = 0.75
_RANSAC_PX = 8.0
MIN_INLIERS = 40
MIN_LEAD = 10

_sift = cv2.SIFT_create(nfeatures=1500)
_clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
_matcher = cv2.BFMatcher(cv2.NORM_L2)


def is_digital_only(card_id: Any) -> bool:
    return bool(_DIGITAL_ONLY.match(str(card_id or "")))


def physical_hits(hits: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [h for h in hits if not is_digital_only(h.get("id"))]


def _features(image_bgr: np.ndarray):
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    gray = _clahe.apply(cv2.resize(gray, _SIZE, interpolation=cv2.INTER_AREA))
    return _sift.detectAndCompute(gray, None)


@lru_cache(maxsize=4096)
def _catalog_features(images_dir: str, card_id: str):
    # backfill_coverage saves pokemontcg.io fallbacks as .png when TCGdex has no webp.
    image = None
    for ext in (".webp", ".png"):
        path = Path(images_dir) / f"{card_id}{ext}"
        if not path.is_file():
            continue
        image = cv2.imread(str(path))
        if image is not None:
            break
    if image is None:
        return None, None
    return _features(image)


def _inliers(query, card) -> int:
    qk, qd = query
    ck, cd = card
    if qd is None or cd is None or len(qd) < 8 or len(cd) < 8:
        return 0
    pairs = _matcher.knnMatch(qd, cd, k=2)
    good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < _RATIO * n.distance]
    if len(good) < 8:
        return 0
    src = np.float32([qk[m.queryIdx].pt for m in good])
    dst = np.float32([ck[m.trainIdx].pt for m in good])
    _, mask = cv2.findHomography(src, dst, cv2.RANSAC, _RANSAC_PX)
    return int(mask.sum()) if mask is not None else 0


def verify_candidates(
    crop_bgr: np.ndarray,
    hits: Sequence[Dict[str, Any]],
    images_dir: Optional[Path] = None,
    k: int = 20,
) -> List[Dict[str, Any]]:
    """Return the top-``k`` hits with an ``inliers`` count, best first."""
    root = str(images_dir or DEFAULT_IMAGES)
    query = _features(crop_bgr)
    scored = [
        {**h, "inliers": _inliers(query, _catalog_features(root, str(h.get("id"))))}
        for h in list(hits)[:k]
    ]
    return sorted(scored, key=lambda h: (h["inliers"], h.get("score") or 0.0), reverse=True)


def accept_verified(ranked: Sequence[Dict[str, Any]]) -> bool:
    if not ranked:
        return False
    best = ranked[0]["inliers"]
    second = ranked[1]["inliers"] if len(ranked) > 1 else 0
    return best >= MIN_INLIERS and best - second >= MIN_LEAD
