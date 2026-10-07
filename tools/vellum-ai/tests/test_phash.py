"""Unit tests for pHash crop / Hamming / CLIP top-K rerank (stdlib unittest)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.phash import (  # noqa: E402
    PHASH_STRONG,
    compute_phash,
    crop_art,
    hamming,
    rerank_clip_hits,
)


def _solid_rgb(w: int, h: int, color: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGB", (w, h), color)


def _patterned(w: int, h: int, seed: int) -> Image.Image:
    """Structured art so pHash differs across seeds (solid colors collide)."""
    img = Image.new("RGB", (w, h))
    pixels = img.load()
    assert pixels is not None
    for y in range(h):
        for x in range(w):
            pixels[x, y] = (
                (x * 7 + seed * 13) % 256,
                (y * 11 + seed * 17) % 256,
                (x * y + seed * 29) % 256,
            )
    return img


def _bgr_from_pil(img: Image.Image) -> np.ndarray:
    rgb = np.asarray(img.convert("RGB"))
    return rgb[:, :, ::-1].copy()


class PhashTests(unittest.TestCase):
    def test_crop_art_bounds(self) -> None:
        img = _solid_rgb(100, 200, (10, 20, 30))
        cropped = crop_art(img)
        # x 4–96%, y 12–52% of 100x200
        self.assertEqual(cropped.size, (92, 80))

    def test_identical_art_hamming_zero(self) -> None:
        img = _patterned(300, 420, seed=1)
        a = compute_phash(img)
        b = compute_phash(img)
        self.assertIsNotNone(a)
        self.assertEqual(a, b)
        self.assertEqual(hamming(a, b), 0)

    def test_different_art_hamming_nonzero(self) -> None:
        a = compute_phash(_patterned(300, 420, seed=1))
        b = compute_phash(_patterned(300, 420, seed=99))
        self.assertIsNotNone(a)
        self.assertIsNotNone(b)
        self.assertGreater(hamming(a, b), 0)

    def test_hamming_missing_is_large(self) -> None:
        self.assertEqual(hamming(None, "abcd"), 999)
        self.assertEqual(hamming("abcd", None), 999)

    def test_rerank_promotes_strong_phash(self) -> None:
        query = _patterned(300, 420, seed=42)
        query_bgr = _bgr_from_pil(query)
        query_hash = compute_phash(query)
        self.assertIsNotNone(query_hash)

        # Higher CLIP score but wrong art vs lower score with strong pHash match
        hits = [
            {"id": "wrong", "name": "Wrong", "score": 0.95},
            {"id": "right", "name": "Right", "score": 0.70},
        ]
        lookup = {
            "wrong": compute_phash(_patterned(300, 420, seed=7)),
            "right": query_hash,
        }
        ranked = rerank_clip_hits(query_bgr, hits, lookup)
        self.assertEqual(ranked[0]["id"], "right")
        self.assertLessEqual(ranked[0]["phashHamming"], PHASH_STRONG)
        self.assertTrue(ranked[0]["phashStrong"])

    def test_rerank_noop_without_catalog_phash(self) -> None:
        query_bgr = _bgr_from_pil(_patterned(300, 420, seed=3))
        hits = [
            {"id": "a", "name": "A", "score": 0.9},
            {"id": "b", "name": "B", "score": 0.8},
        ]
        ranked = rerank_clip_hits(query_bgr, hits, {})
        self.assertEqual([h["id"] for h in ranked], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
