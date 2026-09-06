#!/usr/bin/env python3
"""Bootstrap YOLO labels from a flat inbox of stand / corner / back photos.

Class taxonomy (must match dataset.yaml):
  0 full_card       — entire card face visible (listing / identity front)
  1 corner_closeup  — partial / macro corner (never a front)
  2 card_back       — English Pokémon reverse

Heuristics mirror the Node shotKind signals (edge span, blue field, fill)
so training data teaches the detector the same corner≠front distinction.
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE.parent.parent.parent / "data" / "vellum-detect"
DEFAULT_INBOX = Path.home() / "PokemonCardsInbox"

CLASS_FULL = 0
CLASS_CORNER = 1
CLASS_BACK = 2


def _yolo_line(cls: int, xc: float, yc: float, bw: float, bh: float) -> str:
    return f"{cls} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}\n"


def _clamp_box(xc: float, yc: float, bw: float, bh: float) -> Tuple[float, float, float, float]:
    bw = min(max(bw, 1e-3), 0.999)
    bh = min(max(bh, 1e-3), 0.999)
    xc = min(max(xc, bw / 2), 1 - bw / 2)
    yc = min(max(yc, bh / 2), 1 - bh / 2)
    return xc, yc, bw, bh


def estimate_card_bbox_xywh(image_bgr: np.ndarray) -> Tuple[float, float, float, float]:
    """Return YOLO-normalized xc yc w h for the main non-background region."""
    h, w = image_bgr.shape[:2]
    small = cv2.resize(image_bgr, (160, 210), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    # Adaptive: darkest 15% as mat-ish background
    thr = float(np.percentile(gray, 15)) + 18.0
    thr = min(max(thr, 35.0), 90.0)
    mask = (gray >= thr).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.5, 0.5, 0.7, 0.85
    contour = max(contours, key=cv2.contourArea)
    x, y, bw, bh = cv2.boundingRect(contour)
    # Map back to original normalized coords
    sx, sy = w / small.shape[1], h / small.shape[0]
    x1, y1 = x * sx, y * sy
    x2, y2 = (x + bw) * sx, (y + bh) * sy
    # Pad slightly
    pad_x, pad_y = 0.02 * w, 0.02 * h
    x1 = max(0, x1 - pad_x)
    y1 = max(0, y1 - pad_y)
    x2 = min(w, x2 + pad_x)
    y2 = min(h, y2 + pad_y)
    xc = ((x1 + x2) / 2) / w
    yc = ((y1 + y2) / 2) / h
    return _clamp_box(xc, yc, (x2 - x1) / w, (y2 - y1) / h)


def classify_shot_role(image_bgr: np.ndarray) -> Tuple[int, dict]:
    """Heuristic role label aligned with src/photos/shotKind.js."""
    h, w = image_bgr.shape[:2]
    sample = cv2.resize(image_bgr, (120, 160), interpolation=cv2.INTER_AREA)
    sh, sw = sample.shape[:2]
    rgb = cv2.cvtColor(sample, cv2.COLOR_BGR2RGB).astype(np.float32)
    gray = cv2.cvtColor(sample, cv2.COLOR_BGR2GRAY).astype(np.float32)

    blue = (
        (rgb[:, :, 2] > rgb[:, :, 0] + 15)
        & (rgb[:, :, 2] > rgb[:, :, 1] + 10)
        & (rgb[:, :, 2] > 60)
    )
    blue_frac = float(blue.mean())

    y0, y1 = int(sh * 0.15), int(sh * 0.85)
    x0, x1 = int(sw * 0.15), int(sw * 0.85)
    col = np.zeros(sw, dtype=np.float32)
    row = np.zeros(sh, dtype=np.float32)
    for x in range(1, sw - 1):
        col[x] = float(np.mean(np.abs(gray[y0:y1, x] - gray[y0:y1, x - 1])))
    for y in range(1, sh - 1):
        row[y] = float(np.mean(np.abs(gray[y, x0:x1] - gray[y - 1, x0:x1])))

    def _smooth(arr: np.ndarray, radius: int = 2) -> np.ndarray:
        out = np.zeros_like(arr)
        for i in range(len(arr)):
            lo, hi = max(0, i - radius), min(len(arr), i + radius + 1)
            out[i] = arr[lo:hi].mean()
        return out

    col_s, row_s = _smooth(col), _smooth(row)
    left = col_s[3 : int(sw * 0.45)]
    right = col_s[int(sw * 0.55) : sw - 3]
    top = row_s[3 : int(sh * 0.45)]
    bot = row_s[int(sh * 0.55) : sh - 3]
    i_l = int(np.argmax(left)) + 3
    i_r = int(np.argmax(right)) + int(sw * 0.55)
    i_t = int(np.argmax(top)) + 3
    i_b = int(np.argmax(bot)) + int(sh * 0.55)
    width_frac = (i_r - i_l) / sw
    height_frac = (i_b - i_t) / sh
    card_aspect = width_frac / max(height_frac, 1e-3)

    p10 = float(np.percentile(gray, 10))
    dark_thresh = min(70.0, max(40.0, p10 + 18.0))
    nondark = gray >= dark_thresh
    edge = 6
    edge_mask = np.zeros_like(gray, dtype=bool)
    edge_mask[:edge, :] = True
    edge_mask[-edge:, :] = True
    edge_mask[:, :edge] = True
    edge_mask[:, -edge:] = True
    edge_card_ratio = float(nondark[edge_mask].mean()) if edge_mask.any() else 1.0
    ys, xs = np.where(nondark)
    if len(xs) == 0:
        offset = 0.5
        inset = False
        coverage = 0.0
    else:
        cx, cy = float(xs.mean()) / sw, float(ys.mean()) / sh
        offset = float(np.hypot(cx - 0.5, cy - 0.5))
        inset = int(xs.min()) > 4 and int(ys.min()) > 4 and int(xs.max()) < sw - 5 and int(ys.max()) < sh - 5
        coverage = float(nondark.mean())

    looks_blue_back = blue_frac > 0.12 and width_frac >= 0.4
    looks_mat_front = (
        inset and 0.35 <= coverage <= 0.82 and offset < 0.12 and width_frac >= 0.55 and blue_frac < 0.12
    )
    card_aspect_ok = 0.55 <= card_aspect <= 1.05
    looks_rect_front = (
        not looks_blue_back
        and width_frac >= 0.55
        and height_frac >= 0.55
        and card_aspect_ok
        and offset < 0.14
    )
    looks_stand_front = (
        not looks_blue_back
        and 0.58 <= width_frac <= 0.88
        and 0 < height_frac < 0.52
        and offset < 0.1
    )

    meta = {
        "blue_frac": blue_frac,
        "width_frac": width_frac,
        "height_frac": height_frac,
        "edge_card_ratio": edge_card_ratio,
        "offset": offset,
        "coverage": coverage,
    }

    if looks_blue_back:
        return CLASS_BACK, meta
    if looks_mat_front or looks_rect_front or looks_stand_front:
        return CLASS_FULL, meta
    return CLASS_CORNER, meta


def _list_images(inbox: Path) -> List[Path]:
    exts = {".jpg", ".jpeg", ".png", ".webp"}
    files = [p for p in inbox.iterdir() if p.is_file() and p.suffix.lower() in exts]
    files.sort(key=lambda p: p.name.lower())
    return files


def bootstrap(
    inbox: Path,
    data_root: Path,
    val_ratio: float = 0.2,
    seed: int = 42,
    limit: Optional[int] = None,
    clear: bool = True,
) -> dict:
    """Copy inbox images into train/val with YOLO labels. Returns counts."""
    rng = random.Random(seed)
    images = _list_images(inbox)
    if limit is not None:
        images = images[:limit]
    if not images:
        raise SystemExit(f"No images in inbox: {inbox}")

    for split in ("train", "val"):
        (data_root / "images" / split).mkdir(parents=True, exist_ok=True)
        (data_root / "labels" / split).mkdir(parents=True, exist_ok=True)
        if clear:
            for p in (data_root / "images" / split).glob("*"):
                if p.name.startswith("synth_"):
                    continue
                p.unlink(missing_ok=True)
            for p in (data_root / "labels" / split).glob("*"):
                if p.name.startswith("synth_"):
                    continue
                p.unlink(missing_ok=True)

    counts = {CLASS_FULL: 0, CLASS_CORNER: 0, CLASS_BACK: 0, "train": 0, "val": 0}
    for img_path in images:
        bgr = cv2.imread(str(img_path))
        if bgr is None:
            continue
        cls, _meta = classify_shot_role(bgr)
        xc, yc, bw, bh = estimate_card_bbox_xywh(bgr)
        # Corners that nearly fill the frame: keep a large box but force class 1.
        if cls == CLASS_CORNER and bw * bh > 0.85:
            # Still label the visible region; class teaches role.
            pass

        split = "val" if rng.random() < val_ratio else "train"
        stem = f"inbox_{img_path.stem}"
        dest_img = data_root / "images" / split / f"{stem}.jpg"
        dest_lbl = data_root / "labels" / split / f"{stem}.txt"
        # Normalize to jpg
        cv2.imwrite(str(dest_img), bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
        dest_lbl.write_text(_yolo_line(cls, xc, yc, bw, bh), encoding="utf-8")
        counts[cls] += 1
        counts[split] += 1

    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inbox", type=Path, default=DEFAULT_INBOX)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--val-ratio", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--keep-existing", action="store_true")
    args = parser.parse_args()

    counts = bootstrap(
        args.inbox,
        args.data,
        val_ratio=args.val_ratio,
        seed=args.seed,
        limit=args.limit,
        clear=not args.keep_existing,
    )
    print(
        "Bootstrap complete:",
        f"full_card={counts[CLASS_FULL]}",
        f"corner_closeup={counts[CLASS_CORNER]}",
        f"card_back={counts[CLASS_BACK]}",
        f"train={counts['train']}",
        f"val={counts['val']}",
        f"-> {args.data}",
    )
    if counts[CLASS_CORNER] < 10 or counts[CLASS_FULL] < 5:
        print(
            "WARNING: class counts are low — label more stand + corner photos before trusting the model."
        )


if __name__ == "__main__":
    main()
