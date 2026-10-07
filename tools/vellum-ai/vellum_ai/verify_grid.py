"""Official-art verification grid (Didier verify_cards.py math).

Downloads pokemontcg.io / provided imageUrl tiles and pastes them into a
row-major grid for human comparison against lot photos.
"""

from __future__ import annotations

import logging
import math
from io import BytesIO
from typing import Any, Dict, List, Optional, Sequence
from urllib.request import Request, urlopen

from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)

# Didier scripts/verify_cards.py constants
CARD_WIDTH = 250
CARD_HEIGHT = 350
PADDING = 5


def create_placeholder(name: str, card_number: str) -> Image.Image:
    """Create a placeholder tile when official art could not be downloaded."""
    img = Image.new("RGB", (CARD_WIDTH, CARD_HEIGHT), color=(50, 50, 50))
    draw = ImageDraw.Draw(img)
    draw.rectangle(
        [2, 2, CARD_WIDTH - 3, CARD_HEIGHT - 3],
        outline=(100, 100, 100),
        width=2,
    )
    text = f"{name}\n#{card_number}\n\n(Not found)"
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None
    draw.text(
        (CARD_WIDTH // 2, CARD_HEIGHT // 2),
        text,
        fill=(200, 200, 200),
        anchor="mm",
        font=font,
    )
    return img


def download_card_image(image_url: Optional[str], timeout: float = 20.0) -> Optional[Image.Image]:
    """Download and resize an official card image."""
    if not image_url:
        return None
    try:
        req = Request(str(image_url), headers={"User-Agent": "vellum-ai-verify-grid/0.1"})
        with urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        if not data:
            return None
        img = Image.open(BytesIO(data)).convert("RGB")
        return img.resize((CARD_WIDTH, CARD_HEIGHT), Image.Resampling.LANCZOS)
    except Exception as exc:
        logger.debug("download failed for %s: %s", image_url, exc)
        return None


def _layout_for_count(total: int, layout: Optional[List[int]], cols: Optional[int]) -> List[int]:
    if layout:
        if sum(layout) != total:
            remaining = total - sum(layout)
            if remaining > 0:
                layout = list(layout) + [remaining]
        return layout
    use_cols = cols if cols and cols > 0 else 10
    rows = math.ceil(total / use_cols) if total else 1
    out = [use_cols] * (rows - 1)
    remaining = total - (use_cols * (rows - 1))
    if remaining > 0:
        out.append(remaining)
    elif not out:
        out = [0]
    return out


def create_verification_grid(
    cards: Sequence[Dict[str, Any]],
    layout: Optional[List[int]] = None,
    cols: Optional[int] = None,
) -> bytes:
    """Build a PNG verification grid from card dicts.

    Each card: {name, number, imageUrl?, set?}
    """
    total = len(cards)
    if total == 0:
        empty = Image.new("RGB", (CARD_WIDTH + 2 * PADDING, CARD_HEIGHT + 2 * PADDING), (30, 30, 30))
        buf = BytesIO()
        empty.save(buf, format="PNG")
        return buf.getvalue()

    row_layout = _layout_for_count(total, layout, cols)
    max_cols = max(row_layout) if row_layout else 1
    num_rows = len(row_layout)
    grid_width = max_cols * (CARD_WIDTH + PADDING) + PADDING
    grid_height = num_rows * (CARD_HEIGHT + PADDING) + PADDING
    grid_img = Image.new("RGB", (grid_width, grid_height), color=(30, 30, 30))

    card_idx = 0
    for row_idx, row_count in enumerate(row_layout):
        for col_idx in range(row_count):
            if card_idx >= total:
                break
            card = cards[card_idx]
            name = str(card.get("name") or "Unknown")
            number = str(card.get("number") or "?")
            img = download_card_image(card.get("imageUrl"))
            if img is None:
                img = create_placeholder(name, number)
            x = PADDING + col_idx * (CARD_WIDTH + PADDING)
            y = PADDING + row_idx * (CARD_HEIGHT + PADDING)
            grid_img.paste(img, (x, y))
            card_idx += 1

    buf = BytesIO()
    grid_img.save(buf, format="PNG", quality=95)
    return buf.getvalue()
