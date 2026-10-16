"""The training picture keeps the stamp and the art-frame edge large enough to see."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image

from vellum_ai.variant_train import IMAGE_H, IMAGE_W, compose  # noqa: E402


class ComposeTests(unittest.TestCase):
    def test_stamp_and_border_stay_in_the_zoom(self) -> None:
        image = Image.new("RGB", (750, 1050), (20, 20, 20))
        for y in range(int(0.30 * 1050), int(0.70 * 1050)):
            for x in range(0, int(0.38 * 750)):
                image.putpixel((x, y), (220, 0, 0))
        for y in range(int(0.15 * 1050), int(0.45 * 1050)):
            for x in range(int(0.68 * 750), 750):
                image.putpixel((x, y), (0, 0, 220))
        out = compose(image)
        self.assertEqual(out.size, (IMAGE_W, IMAGE_H))
        self.assertGreater(out.getpixel((8, 240))[0], 200)
        self.assertGreater(out.getpixel((200, 240))[2], 200)
        self.assertGreater(out.getpixel((8, 100))[0], 100)
