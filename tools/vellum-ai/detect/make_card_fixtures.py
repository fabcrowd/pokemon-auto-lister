"""
Generate synthetic Pokémon card fixture images for identification stress tests.

Creates 10 lot directories under data/detect-marketplace/hibid/hibid_card_lot_XX/,
each with one 1200×900 JPEG containing 3 real Base Set card images on a dark
background. These fixtures exercise visual identification as well as OCR.
"""
import hashlib
import json
import pathlib
import random
import time

import cv2
import numpy as np
from PIL import Image

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT_ROOT = REPO_ROOT / "data" / "detect-marketplace" / "hibid"

CARD_W, CARD_H = 240, 336        # ratio 1.40 — within _aspect_ok [1.15, 1.85]
IMG_W, IMG_H = 1200, 900
BG_COLOR = (25, 20, 20)           # dark background (BGR)

# 10 lots × 3 cards each — collector numbers from Base Set
LOTS = [
    ("hibid_card_lot_01", [("4", "102"), ("25", "102"), ("9", "102")]),
    ("hibid_card_lot_02", [("15", "102"), ("3", "102"), ("6", "102")]),
    ("hibid_card_lot_03", [("8", "102"), ("11", "102"), ("14", "102")]),
    ("hibid_card_lot_04", [("17", "102"), ("18", "102"), ("19", "102")]),
    ("hibid_card_lot_05", [("20", "102"), ("21", "102"), ("22", "102")]),
    ("hibid_card_lot_06", [("23", "102"), ("24", "102"), ("30", "102")]),
    ("hibid_card_lot_07", [("1", "102"), ("2", "102"), ("5", "102")]),
    ("hibid_card_lot_08", [("7", "102"), ("10", "102"), ("12", "102")]),
    ("hibid_card_lot_09", [("13", "102"), ("16", "102"), ("26", "102")]),
    ("hibid_card_lot_10", [("27", "102"), ("28", "102"), ("29", "102")]),
]

# Base Set card names used to seed the offline number lookup cache.
_CARD_DATA: dict[str, tuple[str, str]] = {
    "1": ("Alakazam", "base1"), "2": ("Blastoise", "base1"),
    "3": ("Chansey", "base1"), "4": ("Charizard", "base1"),
    "5": ("Clefairy", "base1"), "6": ("Gyarados", "base1"),
    "7": ("Hitmonchan", "base1"), "8": ("Machamp", "base1"),
    "9": ("Magneton", "base1"), "10": ("Mewtwo", "base1"),
    "11": ("Nidoking", "base1"), "12": ("Ninetales", "base1"),
    "13": ("Poliwrath", "base1"), "14": ("Raichu", "base1"),
    "15": ("Venusaur", "base1"), "16": ("Zapdos", "base1"),
    "17": ("Beedrill", "base1"), "18": ("Dragonair", "base1"),
    "19": ("Dugtrio", "base1"), "20": ("Electabuzz", "base1"),
    "21": ("Electrode", "base1"), "22": ("Pidgeotto", "base1"),
    "23": ("Arcanine", "base1"), "24": ("Charmeleon", "base1"),
    "25": ("Dewgong", "base1"), "26": ("Dratini", "base1"),
    "27": ("Farfetch'd", "base1"), "28": ("Growlithe", "base1"),
    "29": ("Haunter", "base1"), "30": ("Ivysaur", "base1"),
}

_TCG_CACHE_DIR = REPO_ROOT / "data" / "tcg-cache"


def _tcg_cache_path(bare: str) -> pathlib.Path:
    key = f"num:{bare}|set:|name:"
    slug = hashlib.sha256(key.encode()).hexdigest()[:16]
    return _TCG_CACHE_DIR / f"{slug}.json"


def seed_tcg_cache() -> None:
    """Pre-populate data/tcg-cache/ so identify_lot works without network access."""
    _TCG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    ts = time.time()
    for bare, (name, set_code) in _CARD_DATA.items():
        record = {
            "id": f"{set_code}-{bare}",
            "name": name,
            "number": bare,
            "set": "Base Set",
            "setCode": set_code,
            "imageUrl": None,
            "game": "pokemon",
            "score": 1.0,
        }
        _tcg_cache_path(bare).write_text(
            json.dumps({"ts": ts, "results": [record]}, ensure_ascii=False),
            encoding="utf-8",
        )
    print(f"  Seeded {len(_CARD_DATA)} TCG cache entries in {_TCG_CACHE_DIR}")


def _make_card_pil(number: str, total: str) -> Image.Image:
    """Return real catalog card art at the fixture's display size."""
    source = REPO_ROOT / "data" / "card-catalog" / "images" / f"base1-{int(number)}.webp"
    if not source.is_file():
        raise FileNotFoundError(f"Base Set catalog art required for fixture: {source}")
    return Image.open(source).convert("RGBA").resize((CARD_W, CARD_H))


def _place_card_on_canvas(canvas_bgr: np.ndarray, card_pil: Image.Image,
                           cx: int, cy: int, angle_deg: float) -> None:
    """Rotate card by angle_deg and composite it onto canvas at (cx, cy)."""
    rotated = card_pil.rotate(angle_deg, expand=True, resample=Image.BICUBIC)
    rw, rh = rotated.size

    x0 = cx - rw // 2
    y0 = cy - rh // 2
    x1, y1 = x0 + rw, y0 + rh

    # Clip to canvas bounds
    sx0 = max(0, -x0)
    sy0 = max(0, -y0)
    sx1 = rw - max(0, x1 - canvas_bgr.shape[1])
    sy1 = rh - max(0, y1 - canvas_bgr.shape[0])
    dx0 = max(0, x0)
    dy0 = max(0, y0)

    if sx1 <= sx0 or sy1 <= sy0:
        return

    card_np = np.array(rotated)
    region = card_np[sy0:sy1, sx0:sx1]
    alpha = region[:, :, 3:4] / 255.0
    rgb = region[:, :, :3][:, :, ::-1]  # RGBA→BGR

    canvas_region = canvas_bgr[dy0:dy0 + (sy1 - sy0), dx0:dx0 + (sx1 - sx0)]
    blended = (alpha * rgb + (1 - alpha) * canvas_region).astype(np.uint8)
    canvas_bgr[dy0:dy0 + (sy1 - sy0), dx0:dx0 + (sx1 - sx0)] = blended


def make_lot(lot_name: str, cards: list[tuple[str, str]]) -> pathlib.Path:
    out_dir = OUT_ROOT / lot_name
    out_dir.mkdir(parents=True, exist_ok=True)

    canvas = np.full((IMG_H, IMG_W, 3), BG_COLOR, dtype=np.uint8)

    # Lay 3 cards side by side with slight random rotation
    positions = [
        (int(IMG_W * 0.20), IMG_H // 2),
        (int(IMG_W * 0.50), IMG_H // 2),
        (int(IMG_W * 0.80), IMG_H // 2),
    ]
    seed = int.from_bytes(hashlib.sha256(lot_name.encode()).digest()[:8], "big")
    rng = random.Random(seed)

    for (cx, cy), (number, total) in zip(positions, cards):
        angle = rng.uniform(-4, 4)
        card_img = _make_card_pil(number, total)
        _place_card_on_canvas(canvas, card_img, cx, cy, angle)

    out_path = out_dir / "lot_image.jpg"
    cv2.imwrite(str(out_path), canvas, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return out_path


def main() -> None:
    print(f"Writing fixtures to {OUT_ROOT}")
    seed_tcg_cache()
    for lot_name, cards in LOTS:
        path = make_lot(lot_name, cards)
        numbers = ", ".join(f"{n}/{t}" for n, t in cards)
        print(f"  {lot_name}: {path.name}  [{numbers}]")
    print("Done.")


if __name__ == "__main__":
    main()
