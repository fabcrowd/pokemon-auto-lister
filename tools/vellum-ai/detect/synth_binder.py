#!/usr/bin/env python3
"""Generate binder-page and tight flat-lay synthetic training images.

The shipped detector was never shown listing-style photos where many cards
fill the frame (9-pocket binder pages, toploaders, dense table spreads), and
it collapsed them into one near-full-frame box. This composites official
catalog art into those layouts, then applies sleeve glare, a whole-photo
perspective tilt and camera noise. One YOLO box (class 0) per visible card.

Usage (from tools/vellum-ai):
    python detect/synth_binder.py --count 600 --split train --seed 501
    python detect/synth_binder.py --count 120 --split val --seed 502
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
    _load_catalog_art_crops,
    _wood_background,
    _yolo_line,
)

REPO_ROOT = HERE.parent.parent.parent
DEFAULT_DATA = REPO_ROOT / "data" / "vellum-detect"
DEFAULT_CATALOG = REPO_ROOT / "data" / "card-catalog" / "images"

_CANVASES = [(720, 960), (960, 720), (800, 800), (768, 1024), (1024, 768), (540, 720)]
_BINDER_GRIDS = [(3, 3)] * 6 + [(4, 3), (3, 4), (2, 2), (2, 3), (3, 2)]
# Drop a box when less than this fraction of the card stays inside the frame.
# At 0.4 the model learned to box thin slivers along real photo edges.
_MIN_VISIBLE = 0.6


def _background(w: int, h: int, rng: random.Random) -> np.ndarray:
    kind = rng.random()
    if kind < 0.4:
        return _wood_background(w, h, rng)
    base = np.array([rng.randint(10, 230) for _ in range(3)], dtype=np.float32)
    canvas = np.ones((h, w, 3), dtype=np.float32) * base
    if kind < 0.7:  # fabric / carpet texture
        canvas += np.random.randn(h, w, 1).astype(np.float32) * rng.uniform(6, 20)
    else:  # smooth vertical gradient
        canvas *= np.linspace(rng.uniform(0.6, 1.0), rng.uniform(0.8, 1.2), h, dtype=np.float32)[:, None, None]
    return np.clip(canvas, 0, 255).astype(np.uint8)


def _rotated_rect(cx: float, cy: float, w: float, h: float, deg: float) -> np.ndarray:
    t = np.deg2rad(deg)
    c, s = np.cos(t), np.sin(t)
    pts = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], dtype=np.float32)
    rot = np.array([[c, -s], [s, c]], dtype=np.float32)
    return pts @ rot.T + np.array([cx, cy], dtype=np.float32)


def _paste(canvas: np.ndarray, img: np.ndarray, quad: np.ndarray, alpha: float = 1.0) -> None:
    h, w = canvas.shape[:2]
    ih, iw = img.shape[:2]
    src = np.float32([[0, 0], [iw, 0], [iw, ih], [0, ih]])
    m = cv2.getPerspectiveTransform(src, quad.astype(np.float32))
    warped = cv2.warpPerspective(img, m, (w, h), flags=cv2.INTER_LINEAR)
    mask = cv2.warpPerspective(np.ones((ih, iw), np.float32), m, (w, h))[:, :, None] * alpha
    canvas[:] = (canvas * (1 - mask) + warped * mask).astype(np.uint8)


def _fill_rect(canvas: np.ndarray, quad: np.ndarray, color, alpha: float) -> None:
    patch = np.full((8, 8, 3), color, dtype=np.uint8)
    _paste(canvas, patch, quad, alpha)


def _card_quads_binder(canvas: np.ndarray, art: List[np.ndarray], rng: random.Random) -> List[np.ndarray]:
    h, w = canvas.shape[:2]
    rows, cols = rng.choice(_BINDER_GRIDS)
    # Real pockets are card-shaped, so size the page from the grid, not the canvas.
    margin = rng.uniform(0.0, 0.1)
    pocket_aspect = CARD_ASPECT * rng.uniform(1.0, 1.08)
    ph = min(h * (1 - 2 * margin) / rows, w * (1 - 2 * margin) / cols / pocket_aspect)
    pw = ph * pocket_aspect
    mx, my = (w - pw * cols) / 2, (h - ph * rows) / 2
    pad = rng.uniform(0.02, 0.06) * min(w, h)
    page = np.float32([[mx - pad, my - pad], [w - mx + pad, my - pad], [w - mx + pad, h - my + pad], [mx - pad, h - my + pad]])
    dark = rng.random() < 0.5
    page_color = [rng.randint(15, 60)] * 3 if dark else [rng.randint(190, 240)] * 3
    _fill_rect(canvas, page, page_color, rng.uniform(0.75, 1.0))

    toploaders = rng.random() < 0.35
    quads = []
    for r in range(rows):
        for c in range(cols):
            px, py = mx + c * pw, my + r * ph
            pocket = np.float32([[px + 2, py + 2], [px + pw - 2, py + 2], [px + pw - 2, py + ph - 2], [px + 2, py + ph - 2]])
            seam = [min(255, v + rng.randint(20, 50)) for v in page_color]
            cv2.polylines(canvas, [pocket.astype(np.int32)], True, seam, max(1, int(min(pw, ph) * 0.012)))
            if rng.random() < 0.07:
                continue  # empty pocket
            fill = rng.uniform(0.74, 0.92) if toploaders else rng.uniform(0.84, 0.96)
            ch = min(ph * fill, pw * fill / CARD_ASPECT)
            cw = ch * CARD_ASPECT
            cx = px + pw / 2 + rng.uniform(-0.04, 0.04) * pw
            cy = py + ph / 2 + rng.uniform(-0.04, 0.04) * ph
            deg = rng.uniform(-2.5, 2.5)
            if toploaders:
                tl = _rotated_rect(cx, cy, cw * 1.12, ch * 1.09, deg)
                _fill_rect(canvas, tl, [rng.randint(170, 230)] * 3, rng.uniform(0.25, 0.5))
            quad = _rotated_rect(cx, cy, cw, ch, deg)
            _paste(canvas, art[rng.randrange(len(art))], quad)
            quads.append(quad)
    return quads


def _card_quads_flatlay(canvas: np.ndarray, art: List[np.ndarray], rng: random.Random) -> List[np.ndarray]:
    h, w = canvas.shape[:2]
    rows, cols = rng.randint(2, 5), rng.randint(2, 6)
    cell_w, cell_h = w / (cols + 0.4), h / (rows + 0.4)
    ch = min(cell_h * rng.uniform(0.8, 0.95), cell_w * rng.uniform(0.8, 0.95) / CARD_ASPECT)
    cw = ch * CARD_ASPECT
    ox, oy = (w - cols * cell_w) / 2, (h - rows * cell_h) / 2
    quads = []
    for r in range(rows):
        for c in range(cols):
            if rng.random() < 0.1:
                continue
            cx = ox + (c + 0.5) * cell_w + rng.uniform(-0.06, 0.06) * cell_w
            cy = oy + (r + 0.5) * cell_h + rng.uniform(-0.06, 0.06) * cell_h
            quad = _rotated_rect(cx, cy, cw, ch, rng.uniform(-8, 8))
            _paste(canvas, art[rng.randrange(len(art))], quad)
            quads.append(quad)
    return quads


def _card_quads_single(canvas: np.ndarray, art: List[np.ndarray], rng: random.Random) -> List[np.ndarray]:
    """One card filling much of a product-style photo (single listings, slabs, stands)."""
    h, w = canvas.shape[:2]
    ch = h * rng.uniform(0.35, 0.85)
    cw = min(ch * CARD_ASPECT, w * 0.9)
    ch = cw / CARD_ASPECT
    cx = w / 2 + rng.uniform(-0.12, 0.12) * w
    cy = h / 2 + rng.uniform(-0.1, 0.1) * h
    if rng.random() < 0.4:  # stand / easel base under the card
        base = np.float32([[cx - cw * 0.45, cy + ch * 0.42], [cx + cw * 0.45, cy + ch * 0.42],
                           [cx + cw * 0.5, cy + ch * 0.58], [cx - cw * 0.5, cy + ch * 0.58]])
        _fill_rect(canvas, base, [rng.randint(180, 240)] * 3, rng.uniform(0.4, 0.8))
    quad = _rotated_rect(cx, cy, cw, ch, rng.uniform(-6, 6))
    _paste(canvas, art[rng.randrange(len(art))], quad)
    return [quad]


def _glare(canvas: np.ndarray, rng: random.Random) -> None:
    h, w = canvas.shape[:2]
    mask = np.zeros((h, w), np.float32)
    for _ in range(rng.randint(1, 3)):
        p1 = (rng.randint(-w // 4, w), rng.randint(-h // 4, h))
        p2 = (p1[0] + rng.randint(-w, w), p1[1] + rng.randint(-h, h))
        cv2.line(mask, p1, p2, 1.0, rng.randint(max(4, w // 40), max(8, w // 8)))
    k = (max(w, h) // 20) | 1
    mask = cv2.GaussianBlur(mask, (k, k), 0) * rng.uniform(0.15, 0.5)
    canvas[:] = np.clip(canvas * (1 - mask[:, :, None]) + 255 * mask[:, :, None], 0, 255).astype(np.uint8)


def _perspective(canvas: np.ndarray, quads: List[np.ndarray], rng: random.Random):
    h, w = canvas.shape[:2]
    j = rng.uniform(0.0, 0.08)
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = src + np.float32([[rng.uniform(-j, j) * w, rng.uniform(-j, j) * h] for _ in range(4)])
    m = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(canvas, m, (w, h), borderMode=cv2.BORDER_REFLECT)
    moved = [cv2.perspectiveTransform(q.reshape(-1, 1, 2), m).reshape(-1, 2) for q in quads]
    return out, moved


def _tilt(canvas: np.ndarray, quads: List[np.ndarray], rng: random.Random):
    """Binder page shot at an angle: 15-40° in-plane turn plus an oblique view.

    The detector found nothing on such HiBid photos; ±15° training rotation is not enough.
    A constant border avoids BORDER_REFLECT mirroring unlabeled cards into the frame.
    """
    h, w = canvas.shape[:2]
    deg = rng.choice((-1, 1)) * rng.uniform(15, 40)
    rot = np.vstack([cv2.getRotationMatrix2D((w / 2, h / 2), deg, rng.uniform(0.65, 0.85)), [0, 0, 1]])
    j = rng.uniform(0.05, 0.15)
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = src + np.float32([[rng.uniform(-j, j) * w, rng.uniform(-j, j) * h] for _ in range(4)])
    m = cv2.getPerspectiveTransform(src, dst) @ rot
    fill = [rng.randint(150, 245)] * 3
    out = cv2.warpPerspective(canvas, m, (w, h), borderMode=cv2.BORDER_CONSTANT, borderValue=fill)
    moved = [cv2.perspectiveTransform(q.reshape(-1, 1, 2), m).reshape(-1, 2) for q in quads]
    return out, moved


def _rotate90(canvas: np.ndarray, quads: List[np.ndarray], rng: random.Random):
    """Sideways listing photos (missing EXIF orientation) turn every card landscape."""
    h, w = canvas.shape[:2]
    if rng.random() < 0.5:
        out = cv2.rotate(canvas, cv2.ROTATE_90_CLOCKWISE)
        moved = [np.stack([h - 1 - q[:, 1], q[:, 0]], axis=1) for q in quads]
    else:
        out = cv2.rotate(canvas, cv2.ROTATE_90_COUNTERCLOCKWISE)
        moved = [np.stack([q[:, 1], w - 1 - q[:, 0]], axis=1) for q in quads]
    return out, moved


def _downscale(canvas: np.ndarray, quads: List[np.ndarray], rng: random.Random):
    """Listing thumbnails leave each card only a few dozen pixels tall."""
    h, w = canvas.shape[:2]
    f = max(rng.uniform(0.25, 0.5), 160 / min(h, w))
    out = cv2.resize(canvas, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)
    return out, [q * f for q in quads]


def _photometric(canvas: np.ndarray, rng: random.Random) -> np.ndarray:
    img = canvas.astype(np.float32)
    img = img * rng.uniform(0.7, 1.25) + rng.uniform(-25, 25)
    img *= np.array([rng.uniform(0.85, 1.15) for _ in range(3)], dtype=np.float32)
    if rng.random() < 0.3:
        img += np.random.randn(*img.shape).astype(np.float32) * rng.uniform(2, 9)
    img = np.clip(img, 0, 255).astype(np.uint8)
    if rng.random() < 0.3:
        k = rng.choice((3, 5))
        img = cv2.GaussianBlur(img, (k, k), 0)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), rng.randint(40, 95)])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR) if ok else img


def _visible_box(quad: np.ndarray, w: int, h: int):
    x1, y1 = quad.min(axis=0)
    x2, y2 = quad.max(axis=0)
    full = max((x2 - x1) * (y2 - y1), 1e-6)
    cx1, cy1, cx2, cy2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
    if cx2 <= cx1 or cy2 <= cy1 or (cx2 - cx1) * (cy2 - cy1) / full < _MIN_VISIBLE:
        return None
    return cx1, cy1, cx2, cy2


def generate(
    data_root: Path,
    catalog_images: Path,
    count: int,
    seed: int = 0,
    split: str = "train",
    art_limit: int = 400,
    tilt_p: float = 0.0,
) -> int:
    rng = random.Random(seed)
    np.random.seed(seed)
    art = _load_catalog_art_crops(catalog_images, art_limit, rng)
    if not art:
        raise SystemExit(f"No catalog art under {catalog_images}")

    img_dir = data_root / "images" / split
    lbl_dir = data_root / "labels" / split
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    for i in range(count):
        w, h = rng.choice(_CANVASES)
        canvas = _background(w, h, rng)
        mode = rng.random()
        if mode < 0.6:
            quads = _card_quads_binder(canvas, art, rng)
        elif mode < 0.85:
            quads = _card_quads_flatlay(canvas, art, rng)
        else:
            quads = _card_quads_single(canvas, art, rng)
        if rng.random() < 0.7:
            _glare(canvas, rng)
        if mode < 0.85 and rng.random() < tilt_p:
            canvas, quads = _tilt(canvas, quads, rng)
        else:
            canvas, quads = _perspective(canvas, quads, rng)
        if rng.random() < 0.25:
            canvas, quads = _rotate90(canvas, quads, rng)
        if rng.random() < 0.25:
            canvas, quads = _downscale(canvas, quads, rng)
        canvas = _photometric(canvas, rng)
        h, w = canvas.shape[:2]

        lines = []
        for q in quads:
            box = _visible_box(q, w, h)
            if box is None:
                continue
            x1, y1, x2, y2 = box
            lines.append(_yolo_line((x1 + x2) / 2 / w, (y1 + y2) / 2 / h, (x2 - x1) / w, (y2 - y1) / h, CLASS_FULL))

        stem = f"binder_synth_{seed}_{i:04d}"
        cv2.imwrite(str(img_dir / f"{stem}.jpg"), canvas, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
        (lbl_dir / f"{stem}.txt").write_text("".join(lines), encoding="utf-8")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--count", type=int, default=600)
    parser.add_argument("--seed", type=int, default=501)
    parser.add_argument("--split", default="train")
    parser.add_argument("--art-limit", type=int, default=400)
    parser.add_argument("--tilt-p", type=float, default=0.0, help="Share of binder/flat-lay pages shot at an angle")
    args = parser.parse_args()
    n = generate(args.data, args.catalog, args.count, args.seed, args.split, args.art_limit, args.tilt_p)
    print(f"Wrote {n} binder/flat-lay images to {args.data / 'images' / args.split}")


if __name__ == "__main__":
    main()
