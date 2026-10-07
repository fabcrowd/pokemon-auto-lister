"""Generate extension icons using Pillow (already in requirements.txt).

Run from tools/chrome-extension/:
  python create_icons.py
"""

import pathlib
from PIL import Image, ImageDraw

SIZES = [16, 48, 128]
OUT   = pathlib.Path(__file__).parent / "icons"
OUT.mkdir(exist_ok=True)


def make_icon(size: int) -> Image.Image:
    img  = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Dark rounded square background
    r = max(2, size // 6)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(26, 30, 40, 255))

    # Pokéball simplified: top half red, bottom half white, divider, center dot
    cx, cy = size // 2, size // 2
    radius = int(size * 0.38)

    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(220, 50, 50, 255))
    draw.rectangle([cx - radius, cy, cx + radius, cy + radius], fill=(240, 240, 240, 255))
    draw.rectangle([cx - radius, cy - 1, cx + radius, cy + 1], fill=(30, 30, 30, 255))

    dot_r = max(2, int(size * 0.10))
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r],
                 fill=(30, 30, 30, 255), outline=(200, 200, 200, 255), width=max(1, size // 24))

    return img


for sz in SIZES:
    icon = make_icon(sz)
    path = OUT / f"icon{sz}.png"
    icon.save(path, "PNG")
    print(f"Created {path}")

print("Done.")
