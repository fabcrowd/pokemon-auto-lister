#!/usr/bin/env python3
"""Bootstrap YOLO card-detect training with synthetic stand photos.

Composites real card crops (and optional flat card art) onto wood-like
backgrounds with random scale, rotation, and mild perspective.
"""

from __future__ import annotations

import argparse
import colorsys
import random
from pathlib import Path
from typing import List, Tuple

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE.parent.parent.parent / "data" / "vellum-detect"
CARD_ASPECT = 63.0 / 88.0  # width / height
CLASS_FULL = 0
CLASS_CORNER = 1
CLASS_BACK = 2


def _yolo_line(xc: float, yc: float, bw: float, bh: float, cls: int = CLASS_FULL) -> str:
    return f"{cls} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}\n"


def _load_catalog_art_crops(catalog_images: Path, limit: int, rng: random.Random) -> List[np.ndarray]:
    """Sample official card art as synthetic faces (for detector diversity)."""
    if not catalog_images.is_dir() or limit <= 0:
        return []
    paths = list(catalog_images.glob("*.webp")) + list(catalog_images.glob("*.png"))
    if not paths:
        return []
    rng.shuffle(paths)
    crops: List[np.ndarray] = []
    for path in paths[: max(limit * 3, limit)]:
        img = cv2.imread(str(path))
        if img is None:
            continue
        h, w = img.shape[:2]
        if h < 80 or w < 60:
            continue
        crops.append(img)
        if len(crops) >= limit:
            break
    return crops


def _load_labeled_crops(data_root: Path) -> List[np.ndarray]:
    """Load full-card crops from existing YOLO labels (train + val), class 0 only."""
    crops: List[np.ndarray] = []
    for split in ("train", "val"):
        img_dir = data_root / "images" / split
        lbl_dir = data_root / "labels" / split
        if not img_dir.is_dir():
            continue
        for img_path in sorted(img_dir.glob("*.jpg")):
            if img_path.name.startswith("synth_"):
                continue
            lbl_path = lbl_dir / f"{img_path.stem}.txt"
            if not lbl_path.is_file():
                continue
            img = cv2.imread(str(img_path))
            if img is None:
                continue
            h, w = img.shape[:2]
            for line in lbl_path.read_text(encoding="utf-8").splitlines():
                parts = line.strip().split()
                if len(parts) != 5:
                    continue
                cls_s, xc, yc, bw, bh = parts
                if int(float(cls_s)) != CLASS_FULL:
                    continue
                xc_f, yc_f, bw_f, bh_f = map(float, (xc, yc, bw, bh))
                x1 = int(max(0, (xc_f - bw_f / 2) * w))
                y1 = int(max(0, (yc_f - bh_f / 2) * h))
                x2 = int(min(w, (xc_f + bw_f / 2) * w))
                y2 = int(min(h, (yc_f + bh_f / 2) * h))
                if x2 - x1 < 40 or y2 - y1 < 40:
                    continue
                crops.append(img[y1:y2, x1:x2].copy())
    return crops


def _wood_background(width: int, height: int, rng: random.Random) -> np.ndarray:
    """Procedural wood-grain-ish background (BGR)."""
    base_h = rng.uniform(0.05, 0.12)
    base_s = rng.uniform(0.35, 0.65)
    base_v = rng.uniform(0.35, 0.65)
    r, g, b = colorsys.hsv_to_rgb(base_h, base_s, base_v)
    canvas = np.zeros((height, width, 3), dtype=np.float32)
    canvas[:, :] = (b * 255, g * 255, r * 255)

    # Horizontal grain bands
    y = np.linspace(0, 1, height, dtype=np.float32)[:, None]
    x = np.linspace(0, 1, width, dtype=np.float32)[None, :]
    grain = (
        12 * np.sin(y * rng.uniform(40, 90) + x * rng.uniform(-3, 3))
        + 8 * np.sin(y * rng.uniform(120, 220) + rng.uniform(0, 6))
        + rng.uniform(-6, 6) * np.random.randn(height, width).astype(np.float32)
    )
    for c in range(3):
        canvas[:, :, c] = np.clip(canvas[:, :, c] + grain, 0, 255)
    return canvas.astype(np.uint8)


def _warp_card(
    card: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    rng: random.Random,
) -> Tuple[np.ndarray, np.ndarray, Tuple[float, float, float, float]]:
    """Place card with rotation + mild perspective; return warped BGR, mask, YOLO xywh."""
    ch, cw = card.shape[:2]
    # Target size on canvas
    target_h = int(canvas_h * rng.uniform(0.55, 0.88))
    target_w = int(target_h * CARD_ASPECT * rng.uniform(0.95, 1.05))
    if target_w > int(canvas_w * 0.92):
        target_w = int(canvas_w * 0.92)
        target_h = int(target_w / CARD_ASPECT)
    resized = cv2.resize(card, (target_w, target_h), interpolation=cv2.INTER_AREA)

    angle = rng.uniform(-18, 18)
    cx, cy = target_w / 2, target_h / 2
    rot = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
    # Mild perspective jitter on destination corners
    jitter = rng.uniform(0.0, 0.04)
    src = np.float32([[0, 0], [target_w, 0], [target_w, target_h], [0, target_h]])
    dst_local = np.float32(
        [
            [jitter * target_w * rng.uniform(-1, 1), jitter * target_h * rng.uniform(-1, 1)],
            [target_w + jitter * target_w * rng.uniform(-1, 1), jitter * target_h * rng.uniform(-1, 1)],
            [target_w + jitter * target_w * rng.uniform(-1, 1), target_h + jitter * target_h * rng.uniform(-1, 1)],
            [jitter * target_w * rng.uniform(-1, 1), target_h + jitter * target_h * rng.uniform(-1, 1)],
        ]
    )
    # Apply rotation to local corners then translate onto canvas
    ones = np.ones((4, 1), dtype=np.float32)
    rot_corners = (rot @ np.hstack([dst_local, ones]).T).T
    min_x, min_y = rot_corners[:, 0].min(), rot_corners[:, 1].min()
    max_x, max_y = rot_corners[:, 0].max(), rot_corners[:, 1].max()
    box_w, box_h = max_x - min_x, max_y - min_y
    margin = 8
    max_tx = max(margin, canvas_w - int(box_w) - margin)
    max_ty = max(margin, canvas_h - int(box_h) - margin)
    tx = rng.randint(margin, max(margin, max_tx))
    ty = rng.randint(margin, max(margin, max_ty))
    canvas_corners = rot_corners.copy()
    canvas_corners[:, 0] = canvas_corners[:, 0] - min_x + tx
    canvas_corners[:, 1] = canvas_corners[:, 1] - min_y + ty

    M = cv2.getPerspectiveTransform(src, canvas_corners.astype(np.float32))
    warped = cv2.warpPerspective(
        resized,
        M,
        (canvas_w, canvas_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    mask = cv2.warpPerspective(
        np.full((target_h, target_w), 255, dtype=np.uint8),
        M,
        (canvas_w, canvas_h),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    # Soften mask edges
    mask = cv2.GaussianBlur(mask, (5, 5), 0)

    xs = canvas_corners[:, 0]
    ys = canvas_corners[:, 1]
    x1 = float(np.clip(xs.min(), 0, canvas_w - 1))
    x2 = float(np.clip(xs.max(), 0, canvas_w - 1))
    y1 = float(np.clip(ys.min(), 0, canvas_h - 1))
    y2 = float(np.clip(ys.max(), 0, canvas_h - 1))
    xc = ((x1 + x2) / 2) / canvas_w
    yc = ((y1 + y2) / 2) / canvas_h
    bw = max((x2 - x1) / canvas_w, 1e-3)
    bh = max((y2 - y1) / canvas_h, 1e-3)
    # Keep YOLO labels inside [0,1] even after perspective overflow
    bw = min(bw, 2 * min(xc, 1 - xc))
    bh = min(bh, 2 * min(yc, 1 - yc))
    return warped, mask, (xc, yc, bw, bh)


def _blend(bg: np.ndarray, warped: np.ndarray, mask: np.ndarray) -> np.ndarray:
    alpha = (mask.astype(np.float32) / 255.0)[:, :, None]
    out = bg.astype(np.float32) * (1 - alpha) + warped.astype(np.float32) * alpha
    # Soft shadow under card
    shadow = cv2.GaussianBlur(mask, (31, 31), 0)
    shadow_a = (shadow.astype(np.float32) / 255.0 * 0.25)[:, :, None]
    out = out * (1 - shadow_a * 0.5)
    return np.clip(out, 0, 255).astype(np.uint8)


def _corner_crop(card: np.ndarray, rng: random.Random) -> Tuple[np.ndarray, Tuple[float, float, float, float]]:
    """Zoom into one corner of a full card — train class corner_closeup."""
    h, w = card.shape[:2]
    # Keep 35–55% of each axis from a chosen corner
    fw = rng.uniform(0.35, 0.55)
    fh = rng.uniform(0.35, 0.55)
    cw, ch = int(w * fw), int(h * fh)
    corner = rng.choice(("tl", "tr", "bl", "br"))
    if corner == "tl":
        x0, y0 = 0, 0
    elif corner == "tr":
        x0, y0 = w - cw, 0
    elif corner == "bl":
        x0, y0 = 0, h - ch
    else:
        x0, y0 = w - cw, h - ch
    crop = card[y0 : y0 + ch, x0 : x0 + cw].copy()
    # Place on dark mat with the crop filling most of the frame (like real macros)
    canvas_h = rng.randint(900, 1200)
    canvas_w = int(canvas_h * rng.uniform(0.7, 0.85))
    mat = np.full((canvas_h, canvas_w, 3), rng.randint(18, 40), dtype=np.uint8)
    # Scale crop to cover 45–85% of frame, biased to one side
    scale = rng.uniform(0.5, 0.9) * min(canvas_w / crop.shape[1], canvas_h / crop.shape[0])
    nw, nh = max(40, int(crop.shape[1] * scale)), max(40, int(crop.shape[0] * scale))
    resized = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA)
    # Pin to a corner of the canvas so the card runs off-frame
    if corner in ("tl", "bl"):
        x = rng.randint(0, max(1, canvas_w // 8))
    else:
        x = canvas_w - nw - rng.randint(0, max(1, canvas_w // 8))
    if corner in ("tl", "tr"):
        y = rng.randint(0, max(1, canvas_h // 8))
    else:
        y = canvas_h - nh - rng.randint(0, max(1, canvas_h // 8))
    x = int(np.clip(x, 0, canvas_w - nw))
    y = int(np.clip(y, 0, canvas_h - nh))
    mat[y : y + nh, x : x + nw] = resized
    xc = (x + nw / 2) / canvas_w
    yc = (y + nh / 2) / canvas_h
    bw = nw / canvas_w
    bh = nh / canvas_h
    return mat, _clamp_xywh(xc, yc, bw, bh)


def _clamp_xywh(xc: float, yc: float, bw: float, bh: float) -> Tuple[float, float, float, float]:
    bw = min(max(bw, 1e-3), 0.999)
    bh = min(max(bh, 1e-3), 0.999)
    xc = min(max(xc, bw / 2), 1 - bw / 2)
    yc = min(max(yc, bh / 2), 1 - bh / 2)
    return xc, yc, bw, bh


def generate(
    data_root: Path,
    count: int,
    seed: int = 42,
    width: int = 768,
    height: int = 1024,
    catalog_images: Path | None = None,
    catalog_art_limit: int = 80,
    corner_ratio: float = 0.45,
) -> int:
    """Write synthetic train images/labels. Returns number written."""
    rng = random.Random(seed)
    np.random.seed(seed)
    crops = _load_labeled_crops(data_root)
    if catalog_images is not None:
        crops.extend(_load_catalog_art_crops(catalog_images, catalog_art_limit, rng))
    if not crops:
        raise SystemExit(f"No labeled card crops found under {data_root}")

    img_dir = data_root / "images" / "train"
    lbl_dir = data_root / "labels" / "train"
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    for old in img_dir.glob("synth_*.jpg"):
        old.unlink(missing_ok=True)
        (lbl_dir / f"{old.stem}.txt").unlink(missing_ok=True)

    written = 0
    for i in range(count):
        card = crops[rng.randrange(len(crops))]
        card_j = card.astype(np.float32)
        card_j *= rng.uniform(0.85, 1.15)
        card_j = np.clip(card_j, 0, 255).astype(np.uint8)
        if rng.random() < 0.3:
            gh, gw = card_j.shape[:2]
            overlay = card_j.copy()
            x0 = rng.randint(0, max(1, gw // 2))
            cv2.rectangle(
                overlay,
                (x0, 0),
                (min(gw, x0 + rng.randint(gw // 8, gw // 3)), gh),
                (255, 255, 255),
                -1,
            )
            card_j = cv2.addWeighted(card_j, 0.82, overlay, 0.18, 0)

        make_corner = rng.random() < corner_ratio
        if make_corner:
            composed, yolo = _corner_crop(card_j, rng)
            cls = CLASS_CORNER
        else:
            bg = _wood_background(width, height, rng)
            warped, mask, yolo = _warp_card(card_j, width, height, rng)
            composed = _blend(bg, warped, mask)
            cls = CLASS_FULL
            if rng.random() < 0.25:
                k = rng.choice((3, 5))
                composed = cv2.GaussianBlur(composed, (k, k), 0)
            if rng.random() < 0.2:
                noise = np.random.randn(*composed.shape).astype(np.float32) * rng.uniform(3, 10)
                composed = np.clip(composed.astype(np.float32) + noise, 0, 255).astype(np.uint8)

        stem = f"synth_{seed}_{i:04d}"
        cv2.imwrite(str(img_dir / f"{stem}.jpg"), composed, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        (lbl_dir / f"{stem}.txt").write_text(_yolo_line(*yolo, cls=cls), encoding="utf-8")
        written += 1
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--count", type=int, default=220)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--catalog-images",
        type=Path,
        default=HERE.parent.parent.parent / "data" / "card-catalog" / "images",
    )
    parser.add_argument("--catalog-art-limit", type=int, default=80)
    parser.add_argument(
        "--corner-ratio",
        type=float,
        default=0.45,
        help="Fraction of synth samples that are corner close-ups (class 1)",
    )
    args = parser.parse_args()
    n = generate(
        args.data,
        args.count,
        seed=args.seed,
        catalog_images=args.catalog_images,
        catalog_art_limit=args.catalog_art_limit,
        corner_ratio=args.corner_ratio,
    )
    print(f"Wrote {n} synthetic train samples under {args.data}")


if __name__ == "__main__":
    main()
