"""Unit tests for RRF fusion / OCR parse (stdlib unittest)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.fusion import fuse_candidates, parse_ocr_text, rrf_score  # noqa: E402
from vellum_ai.rectify import box_to_corners, order_corners, rectify_from_box  # noqa: E402

import numpy as np  # noqa: E402


class FusionTests(unittest.TestCase):
    def test_parse_ocr_number(self) -> None:
        parsed = parse_ocr_text("Charizard 004/102 SV3")
        self.assertEqual(parsed["number"], "004")
        self.assertEqual(parsed["total"], "102")

    def test_parse_ocr_glued_por(self) -> None:
        parsed = parse_ocr_text("POREW091/088☆")
        self.assertEqual(parsed["number"], "091")
        self.assertEqual(parsed["total"], "088")
        self.assertEqual(parsed["setCode"], "por")

    def test_rrf_prefers_shared_ranks(self) -> None:
        self.assertGreater(rrf_score([1, 1]), rrf_score([1, None]))

    def test_fuse_accepts_ocr_agree_with_margin(self) -> None:
        clip = [
            {"id": "a", "name": "A", "set": "S", "setCode": "sv3", "number": "4"},
            {"id": "b", "name": "B", "set": "S", "setCode": "sv3", "number": "5"},
        ]
        result = fuse_candidates(clip, ocr={"number": "4", "setCode": "sv3"}, require_ocr=True, margin=0.01)
        self.assertFalse(result["abstain"])
        self.assertEqual(result["identity"]["number"], "4")

    def test_fuse_abstains_when_ocr_required_missing(self) -> None:
        clip = [{"id": "a", "name": "A", "set": "S", "setCode": "sv3", "number": "4"}]
        result = fuse_candidates(clip, ocr={}, require_ocr=True, margin=0.01)
        self.assertTrue(result["abstain"])

    def test_rectify_shape(self) -> None:
        img = np.zeros((400, 300, 3), dtype=np.uint8)
        out = rectify_from_box(img, (10, 10, 290, 390), size=(750, 1050))
        self.assertEqual(out.shape, (1050, 750, 3))
        corners = order_corners(box_to_corners((0, 0, 10, 20)))
        self.assertEqual(corners.shape, (4, 2))


if __name__ == "__main__":
    unittest.main()
