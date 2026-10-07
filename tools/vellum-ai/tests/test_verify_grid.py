"""Unit tests for Didier-style official-art verification grid."""

from __future__ import annotations

import sys
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.verify_grid import (  # noqa: E402
    CARD_HEIGHT,
    CARD_WIDTH,
    PADDING,
    create_placeholder,
    create_verification_grid,
)


class VerifyGridTests(unittest.TestCase):
    def test_placeholder_size(self) -> None:
        img = create_placeholder("Pikachu", "25")
        self.assertEqual(img.size, (CARD_WIDTH, CARD_HEIGHT))

    def test_grid_dimensions_default_cols(self) -> None:
        cards = [
            {"name": f"Card{i}", "number": str(i), "imageUrl": None}
            for i in range(3)
        ]
        png = create_verification_grid(cards, cols=2)
        self.assertIsInstance(png, (bytes, bytearray))
        grid = Image.open(BytesIO(png))
        # 2 cols x 2 rows (ceil(3/2))
        self.assertEqual(grid.size[0], 2 * (CARD_WIDTH + PADDING) + PADDING)
        self.assertEqual(grid.size[1], 2 * (CARD_HEIGHT + PADDING) + PADDING)

    def test_grid_uses_downloaded_image(self) -> None:
        fake = Image.new("RGB", (100, 140), (200, 50, 50))
        buf = BytesIO()
        fake.save(buf, format="PNG")
        raw = buf.getvalue()

        with patch("vellum_ai.verify_grid.download_card_image", return_value=Image.open(BytesIO(raw))):
            png = create_verification_grid(
                [{"name": "Pikachu", "number": "25", "imageUrl": "https://example/x.png"}],
                cols=1,
            )
        grid = Image.open(BytesIO(png))
        self.assertEqual(grid.size, (CARD_WIDTH + 2 * PADDING, CARD_HEIGHT + 2 * PADDING))


if __name__ == "__main__":
    unittest.main()
