"""Rotated cards inside a detector box are cropped upright (binder pages shot at an angle)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai import detect_multi  # noqa: E402
from vellum_ai.rectify import find_card_quad  # noqa: E402


def _scene(deg: float):
    """White table, one card (red top band, blue body) rotated by ``deg``; returns image and bbox."""
    img = np.full((700, 700, 3), 235, np.uint8)
    card = np.zeros((420, 300, 3), np.uint8)
    card[:] = (200, 60, 20)
    card[:70] = (20, 20, 220)
    rect = ((350, 350), (300, 420), deg)
    dst = cv2.boxPoints(rect).astype(np.float32)
    src = np.float32([[0, 420], [0, 0], [300, 0], [300, 420]])
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(card, m, (700, 700))
    mask = cv2.warpPerspective(np.full((420, 300), 255, np.uint8), m, (700, 700))
    img[mask > 0] = warped[mask > 0]
    x, y = dst[:, 0], dst[:, 1]
    return img, [float(x.min()), float(y.min()), float(x.max()), float(y.max())]


class UprightCropTests(unittest.TestCase):
    def test_tilted_card_is_rectified_portrait_and_upright(self):
        img, box = _scene(28)
        crop = detect_multi._upright_crop(img, box)
        self.assertIsNotNone(crop)
        h, w = crop.shape[:2]
        self.assertGreater(h, w)
        top = crop[int(h * 0.03):int(h * 0.12), int(w * 0.2):int(w * 0.8)].mean(axis=(0, 1))
        body = crop[int(h * 0.5):int(h * 0.7), int(w * 0.2):int(w * 0.8)].mean(axis=(0, 1))
        self.assertGreater(top[2], 150)   # red band on top
        self.assertGreater(body[0], 150)  # blue body below

    def test_axis_aligned_card_keeps_the_plain_box_crop(self):
        img, box = _scene(0)
        self.assertIsNone(detect_multi._upright_crop(img, box))

    def test_no_fallback_quad_when_nothing_card_shaped(self):
        self.assertIsNone(find_card_quad(np.full((300, 300, 3), 128, np.uint8), fallback=False))


if __name__ == "__main__":
    unittest.main()
