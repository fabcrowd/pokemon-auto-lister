"""
Generate synthetic Pokémon card fixture images for identification stress tests.

Creates 10 lot directories under data/detect-marketplace/hibid/hibid_card_lot_XX/,
each with one 1200×900 JPEG containing 3 white-bordered synthetic cards on a dark
background. Each card has a large "NNN/NNN" collector number in the bottom strip,
readable by RapidOCR after the pipeline rectifies to 750×1050.
"""
import hashlib
import json
import pathlib
import random
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT_ROOT = REPO_ROOT / "data" / "detect-marketplace" / "hibid"

CARD_W, CARD_H = 240, 336        # ratio 1.40 — within _aspect_ok [1.15, 1.85]
BORDER = 10                       # white border thickness (px)
IMG_W, IMG_H = 1200, 900
BG_COLOR = (25, 20, 20)           # dark background (BGR)

# 10 lots × 3 cards each — real Kanto/Base set numbers that exist in TCG API
LOTS = [
    ("hibid_card_lot_01", [("006", "165"), ("025", "165"), ("094", "165")]),
    ("hibid_card_lot_02", [("130", "165"), ("003", "165"), ("009", "165")]),
    ("hibid_card_lot_03", [("039", "165"), ("045", "165"), ("052", "165")]),
    ("hibid_card_lot_04", [("054", "165"), ("069", "165"), ("074", "165")]),
    ("hibid_card_lot_05", [("079", "165"), ("081", "165"), ("088", "165")]),
    ("hibid_card_lot_06", [("100", "165"), ("104", "165"), ("113", "165")]),
    ("hibid_card_lot_07", [("115", "165"), ("120", "165"), ("121", "165")]),
    ("hibid_card_lot_08", [("122", "165"), ("124", "165"), ("127", "165")]),
    ("hibid_card_lot_09", [("131", "165"), ("132", "165"), ("133", "165")]),
    ("hibid_card_lot_10", [("134", "165"), ("137", "165"), ("143", "165")]),
]

# Pokémon Card 151 (sv3pt5) — 165-card Kanto set, used for cache seeding
_CARD_DATA: dict[str, tuple[str, str]] = {
    "3":   ("Venusaur",    "sv3pt5"),
    "6":   ("Charizard",   "sv3pt5"),
    "9":   ("Blastoise",   "sv3pt5"),
    "25":  ("Pikachu",     "sv3pt5"),
    "39":  ("Jigglypuff",  "sv3pt5"),
    "45":  ("Vileplume",   "sv3pt5"),
    "52":  ("Meowth",      "sv3pt5"),
    "54":  ("Psyduck",     "sv3pt5"),
    "69":  ("Bellsprout",  "sv3pt5"),
    "74":  ("Geodude",     "sv3pt5"),
    "79":  ("Slowpoke",    "sv3pt5"),
    "81":  ("Magnemite",   "sv3pt5"),
    "88":  ("Grimer",      "sv3pt5"),
    "94":  ("Gengar",      "sv3pt5"),
    "100": ("Voltorb",     "sv3pt5"),
    "104": ("Cubone",      "sv3pt5"),
    "113": ("Chansey",     "sv3pt5"),
    "115": ("Kangaskhan",  "sv3pt5"),
    "120": ("Staryu",      "sv3pt5"),
    "121": ("Starmie",     "sv3pt5"),
    "122": ("Mr. Mime",    "sv3pt5"),
    "124": ("Jynx",        "sv3pt5"),
    "127": ("Pinsir",      "sv3pt5"),
    "130": ("Gyarados",    "sv3pt5"),
    "131": ("Lapras",      "sv3pt5"),
    "132": ("Ditto",       "sv3pt5"),
    "133": ("Eevee",       "sv3pt5"),
    "134": ("Vaporeon",    "sv3pt5"),
    "137": ("Porygon",     "sv3pt5"),
    "143": ("Snorlax",     "sv3pt5"),
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
            "set": "Pokémon Card 151",
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


FONT_PATHS = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\DejaVuSans-Bold.ttf",
    r"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    r"/Library/Fonts/Arial Bold.ttf",
]


def _load_font(size: int) -> ImageFont.ImageFont:
    for path in FONT_PATHS:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            pass
    return ImageFont.load_default()


def _make_card_pil(number: str, total: str) -> Image.Image:
    """Return a PIL RGBA card image with white border and collector number."""
    img = Image.new("RGBA", (CARD_W, CARD_H), (255, 255, 255, 255))  # white border
    draw = ImageDraw.Draw(img)

    # Card face — deliberately below max(R,G,B)=249 to avoid the glare gate (V>=250)
    face_color = (220, 215, 185, 255)
    draw.rectangle(
        [BORDER, BORDER, CARD_W - BORDER - 1, CARD_H - BORDER - 1],
        fill=face_color,
    )

    # Pokémon art placeholder — filled dark rectangle in upper 70%
    art_margin = BORDER + 8
    art_bottom = int(CARD_H * 0.68)
    draw.rectangle(
        [art_margin, BORDER + 18, CARD_W - art_margin - 1, art_bottom],
        fill=(60, 90, 140, 255),
    )

    # Collector number — large text at ~90% of card height
    collector_text = f"{number}/{total}"
    font_size = 36
    font = _load_font(font_size)

    # Center the text horizontally, place at 90% of card height
    try:
        bbox = font.getbbox(collector_text)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    except AttributeError:
        tw, th = font.getsize(collector_text)

    tx = (CARD_W - tw) // 2
    ty = int(CARD_H * 0.90) - th // 2

    # White halo for contrast
    for dx, dy in [(-2, -2), (2, -2), (-2, 2), (2, 2), (0, -2), (0, 2), (-2, 0), (2, 0)]:
        draw.text((tx + dx, ty + dy), collector_text, font=font, fill=(255, 255, 255, 255))
    draw.text((tx, ty), collector_text, font=font, fill=(20, 20, 20, 255))

    # "POKEMON" name stub at top
    name_font = _load_font(14)
    name_text = "POKEMON"
    try:
        nbbox = name_font.getbbox(name_text)
        nw = nbbox[2] - nbbox[0]
    except AttributeError:
        nw, _ = name_font.getsize(name_text)
    draw.text(((CARD_W - nw) // 2, BORDER + 4), name_text, font=name_font, fill=(30, 30, 30, 255))

    return img


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
    rng = random.Random(hash(lot_name))

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
