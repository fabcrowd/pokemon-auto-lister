#!/usr/bin/env python3
"""Generate multi-card synthetic images for detector stress testing.

Composites 2–5 cards per frame onto wood-like backgrounds with perspective
warping. Writes YOLO labels (one box per card) to data/vellum-detect-multi/.

Layouts: horizontal, vertical, grid, cascade (fan-spread).
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path
from typing import List, Tuple

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from synth_bootstrap import (  # noqa: E402
    CARD_ASPECT,
    CLASS_FULL,
    _blend,
    _clamp_xywh,
    _load_catalog_art_crops,
    _load_labeled_crops,
    _wood_background,
    _yolo_line,
)

DEFAULT_DATA = HERE.parent.parent.parent / "data" / "vellum-detect-multi"
DEFAULT_SOURCE_DATA = HERE.parent.parent.parent / "data" / "vellum-detect"


def _warp_card_in_region(
    card: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    rx1: int,
    rx2: int,
    ry1: int,
    ry2: int,
    rng: random.Random,
    angle_range: float = 15.0,
) -> Tuple[np.ndarray, np.ndarray, Tuple[float, float, float, float]]:
    """Warp one card image constrained to region [rx1,rx2] × [ry1,ry2].

    Returns (warped_bgr, alpha_mask, yolo_xywh).
    """
    region_w = max(rx2 - rx1, 60)
    region_h = max(ry2 - ry1, 80)

    fill = rng.uniform(0.78, 0.94)
    target_h = int(region_h * fill)
    target_w = int(target_h * CARD_ASPECT * rng.uniform(0.95, 1.05))
    if target_w > int(region_w * 0.95):
        target_w = int(region_w * 0.95)
        target_h = int(target_w / CARD_ASPECT)
    target_w = max(target_w, 30)
    target_h = max(target_h, 40)

    resized = cv2.resize(card, (target_w, target_h), interpolation=cv2.INTER_AREA)

    angle = rng.uniform(-angle_range, angle_range)
    cx, cy = target_w / 2.0, target_h / 2.0
    rot = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)

    jitter = rng.uniform(0.0, 0.035)
    src = np.float32([[0, 0], [target_w, 0], [target_w, target_h], [0, target_h]])
    dst_local = np.float32([
        [jitter * target_w * rng.uniform(-1, 1), jitter * target_h * rng.uniform(-1, 1)],
        [target_w + jitter * target_w * rng.uniform(-1, 1), jitter * target_h * rng.uniform(-1, 1)],
        [target_w + jitter * target_w * rng.uniform(-1, 1), target_h + jitter * target_h * rng.uniform(-1, 1)],
        [jitter * target_w * rng.uniform(-1, 1), target_h + jitter * target_h * rng.uniform(-1, 1)],
    ])

    ones = np.ones((4, 1), dtype=np.float32)
    rot_corners = (rot @ np.hstack([dst_local, ones]).T).T
    min_x = rot_corners[:, 0].min()
    min_y = rot_corners[:, 1].min()
    max_x = rot_corners[:, 0].max()
    max_y = rot_corners[:, 1].max()
    box_w = max_x - min_x
    box_h = max_y - min_y

    margin = 4
    avail_x = max(margin, region_w - int(box_w) - margin)
    avail_y = max(margin, region_h - int(box_h) - margin)
    local_tx = rng.randint(margin, max(margin, avail_x))
    local_ty = rng.randint(margin, max(margin, avail_y))

    canvas_corners = rot_corners.copy()
    canvas_corners[:, 0] = rot_corners[:, 0] - min_x + local_tx + rx1
    canvas_corners[:, 1] = rot_corners[:, 1] - min_y + local_ty + ry1

    M = cv2.getPerspectiveTransform(src, canvas_corners.astype(np.float32))
    warped = cv2.warpPerspective(
        resized, M, (canvas_w, canvas_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    mask = cv2.warpPerspective(
        np.full((target_h, target_w), 255, dtype=np.uint8),
        M, (canvas_w, canvas_h),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    mask = cv2.GaussianBlur(mask, (5, 5), 0)

    xs = np.clip(canvas_corners[:, 0], 0, canvas_w - 1)
    ys = np.clip(canvas_corners[:, 1], 0, canvas_h - 1)
    x1f, x2f = float(xs.min()), float(xs.max())
    y1f, y2f = float(ys.min()), float(ys.max())
    xc = ((x1f + x2f) / 2) / canvas_w
    yc = ((y1f + y2f) / 2) / canvas_h
    bw = max((x2f - x1f) / canvas_w, 1e-3)
    bh = max((y2f - y1f) / canvas_h, 1e-3)
    bw = min(bw, 2 * min(xc, 1 - xc))
    bh = min(bh, 2 * min(yc, 1 - yc))
    return warped, mask, (xc, yc, bw, bh)


def _layout_regions(
    n: int,
    canvas_w: int,
    canvas_h: int,
    layout: str,
    rng: random.Random,
) -> List[Tuple[int, int, int, int]]:
    """Return N placement regions (rx1, rx2, ry1, ry2) — one per card."""
    pad = 14
    w = canvas_w - 2 * pad
    h = canvas_h - 2 * pad

    if layout == "horizontal":
        strip = w // n
        return [
            (pad + i * strip, pad + (i + 1) * strip, pad, canvas_h - pad)
            for i in range(n)
        ]

    if layout == "vertical":
        strip = h // n
        return [
            (pad, canvas_w - pad, pad + i * strip, pad + (i + 1) * strip)
            for i in range(n)
        ]

    if layout == "grid":
        cols = 2 if n <= 4 else 3
        rows = (n + cols - 1) // cols
        cw = w // cols
        ch = h // rows
        return [
            (
                pad + (i % cols) * cw,
                pad + (i % cols + 1) * cw,
                pad + (i // cols) * ch,
                pad + (i // cols + 1) * ch,
            )
            for i in range(n)
        ]

    # cascade: fan-spread with diagonal offset and slight overlap
    card_w = int(canvas_w * 0.42)
    card_h = int(canvas_h * 0.68)
    step_x = max(1, (canvas_w - card_w - 2 * pad) // max(n - 1, 1))
    step_y = max(1, (canvas_h - card_h - 2 * pad) // max(n - 1, 1))
    regions = []
    for i in range(n):
        x1 = min(pad + i * step_x, canvas_w - card_w - pad)
        y1 = min(pad + i * step_y, canvas_h - card_h - pad)
        regions.append((x1, x1 + card_w, y1, y1 + card_h))
    return regions


def generate(
    data_root: Path,
    source_data: Path,
    count: int,
    seed: int = 0,
    width: int = 960,
    height: int = 720,
    min_cards: int = 2,
    max_cards: int = 5,
    catalog_images: Path | None = None,
    catalog_art_limit: int = 80,
    split: str = "train",
) -> int:
    """Write multi-card synthetic images + labels. Returns number written."""
    rng = random.Random(seed)
    np.random.seed(seed)

    crops = _load_labeled_crops(source_data)
    if catalog_images is not None:
        crops.extend(_load_catalog_art_crops(catalog_images, catalog_art_limit, rng))
    if not crops:
        raise SystemExit(f"No labeled card crops found under {source_data}")

    img_dir = data_root / "images" / split
    lbl_dir = data_root / "labels" / split
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    for old in img_dir.glob("multi_synth_*.jpg"):
        old.unlink(missing_ok=True)
        (lbl_dir / f"{old.stem}.txt").unlink(missing_ok=True)

    layouts = ["horizontal", "vertical", "grid", "cascade"]
    written = 0
    for i in range(count):
        n_cards = rng.randint(min_cards, max_cards)
        layout = rng.choice(layouts)
        if n_cards == 2 and layout == "grid":
            layout = rng.choice(["horizontal", "vertical"])

        bg = _wood_background(width, height, rng)
        canvas = bg.copy()
        label_lines: List[str] = []

        regions = _layout_regions(n_cards, width, height, layout, rng)
        for rx1, rx2, ry1, ry2 in regions:
            card = crops[rng.randrange(len(crops))].copy()
            card_f = card.astype(np.float32) * rng.uniform(0.82, 1.18)
            card_aug = np.clip(card_f, 0, 255).astype(np.uint8)

            warped, mask, yolo = _warp_card_in_region(
                card_aug, width, height, rx1, rx2, ry1, ry2, rng
            )
            canvas = _blend(canvas, warped, mask)
            label_lines.append(_yolo_line(*yolo, cls=CLASS_FULL))

        # Frame-level augmentation
        if rng.random() < 0.2:
            k = rng.choice((3, 5))
            canvas = cv2.GaussianBlur(canvas, (k, k), 0)
        if rng.random() < 0.15:
            noise = (np.random.randn(*canvas.shape) * rng.uniform(3, 8)).astype(np.float32)
            canvas = np.clip(canvas.astype(np.float32) + noise, 0, 255).astype(np.uint8)

        stem = f"multi_synth_{seed}_{i:04d}"
        cv2.imwrite(
            str(img_dir / f"{stem}.jpg"),
            canvas,
            [int(cv2.IMWRITE_JPEG_QUALITY), 90],
        )
        (lbl_dir / f"{stem}.txt").write_text("".join(label_lines), encoding="utf-8")
        written += 1

    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--source-data", type=Path, default=DEFAULT_SOURCE_DATA)
    parser.add_argument("--count", type=int, default=120, help="Images to generate")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--min-cards", type=int, default=2)
    parser.add_argument("--max-cards", type=int, default=5)
    parser.add_argument("--split", default="val", choices=["train", "val"])
    parser.add_argument(
        "--catalog-images",
        type=Path,
        default=HERE.parent.parent.parent / "data" / "card-catalog" / "images",
    )
    parser.add_argument("--catalog-art-limit", type=int, default=80)
    args = parser.parse_args()

    n = generate(
        data_root=args.data,
        source_data=args.source_data,
        count=args.count,
        seed=args.seed,
        width=args.width,
        height=args.height,
        min_cards=args.min_cards,
        max_cards=args.max_cards,
        catalog_images=args.catalog_images,
        catalog_art_limit=args.catalog_art_limit,
        split=args.split,
    )
    print(f"Wrote {n} multi-card synthetic images under {args.data}/{args.split}/")


if __name__ == "__main__":
    main()
