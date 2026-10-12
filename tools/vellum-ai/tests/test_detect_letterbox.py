"""The shipped detector path letterboxes like training and the extension (detect.js)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai import detect_multi  # noqa: E402


class LetterboxTests(unittest.TestCase):
    def test_pad_and_unpad_round_trip(self):
        img = np.zeros((300, 500, 3), np.uint8)
        square, px, py = detect_multi.pad_to_square(img)
        self.assertEqual(square.shape[:2], (500, 500))
        self.assertEqual((px, py), (0, 100))
        self.assertEqual(detect_multi.unpad_box([10, 110, 60, 200], px, py), [10, 10, 60, 100])

    def test_detector_sees_a_square_image_and_boxes_map_back_clipped(self):
        seen = {}

        def fake(image, path):
            seen["shape"] = image.shape[:2]
            return [{"box": (40.0, 80.0, 220.0, 420.0), "class_id": 0, "class_name": "full_card",
                     "confidence": 0.9, "source": "onnx"}]

        with tempfile.NamedTemporaryFile(suffix=".onnx") as f, \
             patch.dict("os.environ", {"VELLUM_AI_DETECT_ONNX": f.name}), \
             patch.object(detect_multi, "_detect_onnx_multi", side_effect=fake):
            hits = detect_multi.detect_all_cards_with_crops(np.full((300, 500, 3), 90, np.uint8))
        self.assertEqual(seen["shape"], (500, 500))
        self.assertEqual(hits[0]["box"], [40.0, 0.0, 220.0, 300.0])


if __name__ == "__main__":
    unittest.main()
