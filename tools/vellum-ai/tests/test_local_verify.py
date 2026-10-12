"""Unit tests for local-feature (SIFT + RANSAC) candidate verification."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.local_verify import (  # noqa: E402
    accept_verified,
    is_digital_only,
    physical_hits,
    verify_candidates,
)


def _texture(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = np.full((560, 400, 3), 255, np.uint8)
    for _ in range(120):
        c = tuple(int(v) for v in rng.integers(0, 255, 3))
        x, y = int(rng.integers(0, 380)), int(rng.integers(0, 540))
        cv2.rectangle(img, (x, y), (x + int(rng.integers(8, 60)), y + int(rng.integers(8, 60))), c, -1)
        cv2.circle(img, (int(rng.integers(0, 400)), int(rng.integers(0, 560))), int(rng.integers(4, 30)), c, 2)
    return img


class LocalVerifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.images = Path(self.tmp.name)
        for i in range(3):
            cv2.imwrite(str(self.images / f"set1-{i}.webp"), _texture(i))
        self.hits = [{"id": f"set1-{i}", "name": f"Card {i}", "score": 0.8} for i in range(3)]

    def tearDown(self):
        self.tmp.cleanup()

    def test_photo_of_a_catalog_card_ranks_that_card_first_and_is_accepted(self):
        src = _texture(2)
        h, w = src.shape[:2]
        quad = np.float32([[18, 30], [w - 10, 12], [w - 25, h - 8], [6, h - 22]])
        warp = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), quad)
        photo = cv2.warpPerspective(src, warp, (w, h), borderValue=(40, 40, 40))
        photo = cv2.GaussianBlur(photo, (3, 3), 0)

        ranked = verify_candidates(photo, self.hits, images_dir=self.images)
        self.assertEqual(ranked[0]["id"], "set1-2")
        self.assertGreater(ranked[0]["inliers"], ranked[1]["inliers"])
        self.assertTrue(accept_verified(ranked))

    def test_unrelated_image_is_not_accepted(self):
        ranked = verify_candidates(_texture(99), self.hits, images_dir=self.images)
        self.assertFalse(accept_verified(ranked))

    def test_missing_catalog_image_scores_zero_instead_of_raising(self):
        ranked = verify_candidates(_texture(2), self.hits + [{"id": "nope-1"}], images_dir=self.images)
        self.assertEqual(next(r for r in ranked if r["id"] == "nope-1")["inliers"], 0)

    def test_missing_catalog_file_is_not_opened(self):
        with patch("vellum_ai.local_verify.cv2.imread", wraps=cv2.imread) as imread:
            verify_candidates(_texture(2), [{"id": "nope-1"}], images_dir=self.images)
        self.assertFalse(imread.called)

    def test_png_only_catalog_art_is_used(self):
        cv2.imwrite(str(self.images / "promo-9.png"), _texture(7))
        ranked = verify_candidates(_texture(7), [{"id": "promo-9"}, {"id": "set1-0"}], images_dir=self.images)
        self.assertEqual(ranked[0]["id"], "promo-9")
        self.assertGreater(ranked[0]["inliers"], 100)

    def test_accept_needs_clear_lead(self):
        self.assertTrue(accept_verified([{"inliers": 120}, {"inliers": 30}]))
        self.assertFalse(accept_verified([{"inliers": 30}, {"inliers": 5}]))
        self.assertFalse(accept_verified([{"inliers": 60}, {"inliers": 55}]))
        self.assertFalse(accept_verified([]))


class DigitalOnlyTests(unittest.TestCase):
    def test_tcg_pocket_ids_are_digital_only(self):
        for cid in ("A1-017", "A3b-001", "B1-045", "P-A-028"):
            self.assertTrue(is_digital_only(cid), cid)
        for cid in ("swsh7-6", "sv03.5-049", "base1-4", "bw3-14", "ex1-106"):
            self.assertFalse(is_digital_only(cid), cid)

    def test_physical_hits_drops_pocket_and_keeps_order(self):
        hits = [{"id": "A1-017"}, {"id": "sv03.5-049"}, {"id": "B1-045"}, {"id": "xy4-2"}]
        self.assertEqual([h["id"] for h in physical_hits(hits)], ["sv03.5-049", "xy4-2"])


if __name__ == "__main__":
    unittest.main()
