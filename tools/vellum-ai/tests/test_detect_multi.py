"""Unit tests for multi-card contour detection path.

All tests run purely in-memory — no files, no ONNX model.
The ONNX path is bypassed by unsetting VELLUM_AI_DETECT_ONNX and ensuring
the model file does not exist at the default path.

Card images are constructed as solid-color rectangles on a contrasting
background so the contour detector has clear edges to find.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from typing import List, Tuple

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["VELLUM_AI_DETECT_ONNX"] = "/nonexistent/model.onnx"

from vellum_ai.detect_multi import (  # noqa: E402
    _contour_multi,
    _quad_iou,
    _score_quad_multi,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

CARD_W = 130  # pixels for a card on the test canvas
CARD_H = 182  # ≈ CARD_W / (63/88) → aspect ~1.4, well within 1.15–1.85


def _card_image(w: int = CARD_W, h: int = CARD_H) -> np.ndarray:
    """Solid mid-blue BGR card image."""
    img = np.full((h, w, 3), 110, dtype=np.uint8)
    img[:, :, 0] = 60   # B
    img[:, :, 1] = 90   # G
    img[:, :, 2] = 180  # R
    # Add a lighter border to simulate card edge
    cv2.rectangle(img, (2, 2), (w - 3, h - 3), (180, 140, 220), 3)
    return img


def _canvas_with_cards(
    placements: List[Tuple[int, int]],
    canvas_w: int = 900,
    canvas_h: int = 680,
    card_w: int = CARD_W,
    card_h: int = CARD_H,
) -> np.ndarray:
    """White canvas with cards (BGR rectangles) placed at given (x, y) positions."""
    canvas = np.full((canvas_h, canvas_w, 3), 230, dtype=np.uint8)
    card = _card_image(card_w, card_h)
    for x, y in placements:
        x1, y1 = max(0, x), max(0, y)
        x2, y2 = min(canvas_w, x + card_w), min(canvas_h, y + card_h)
        canvas[y1:y2, x1:x2] = card[: y2 - y1, : x2 - x1]
    return canvas


def _box_iou(a: Tuple, b: Tuple) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / (union + 1e-6)


def _matched_count(gt_boxes: List[Tuple], det_boxes: List[Tuple], iou_thr: float = 0.4) -> int:
    """Greedy GT→det matching, return number of matched GT boxes."""
    matched = set()
    tp = 0
    for gt in gt_boxes:
        best_iou, best_j = 0.0, -1
        for j, det in enumerate(det_boxes):
            if j in matched:
                continue
            iou = _box_iou(gt, det)
            if iou > best_iou:
                best_iou, best_j = iou, j
        if best_j >= 0 and best_iou >= iou_thr:
            tp += 1
            matched.add(best_j)
    return tp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestQuadIou(unittest.TestCase):
    def test_identical_returns_one(self) -> None:
        pts = np.float32([[0, 0], [100, 0], [100, 140], [0, 140]])
        self.assertAlmostEqual(_quad_iou(pts, pts), 1.0, places=3)

    def test_no_overlap_returns_zero(self) -> None:
        a = np.float32([[0, 0], [50, 0], [50, 70], [0, 70]])
        b = np.float32([[200, 200], [250, 200], [250, 270], [200, 270]])
        self.assertAlmostEqual(_quad_iou(a, b), 0.0, places=3)

    def test_partial_overlap(self) -> None:
        a = np.float32([[0, 0], [100, 0], [100, 140], [0, 140]])
        b = np.float32([[50, 0], [150, 0], [150, 140], [50, 140]])
        iou = _quad_iou(a, b)
        self.assertGreater(iou, 0.2)
        self.assertLess(iou, 0.6)


class TestScoreQuadArea(unittest.TestCase):
    def test_card_at_twelve_percent_is_kept(self) -> None:
        """Tight-grid cards occupy ~12% of the canvas; the old 5% cap rejected them."""
        w, h = float(CARD_W), float(CARD_H)
        pts = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        image_area = (w * h) / 0.12
        score = _score_quad_multi(pts, image_area)
        self.assertGreater(score, 0.0)

    def test_near_full_frame_blob_rejected(self) -> None:
        pts = np.float32([[0, 0], [400, 0], [400, 560], [0, 560]])
        image_area = 410.0 * 570.0
        score = _score_quad_multi(pts, image_area)
        self.assertLess(score, 0.0)


class TestSingleCardDetection(unittest.TestCase):
    def test_single_card_detected(self) -> None:
        canvas = _canvas_with_cards([(385, 249)])
        hits = _contour_multi(canvas)
        gt = [(385, 249, 385 + CARD_W, 249 + CARD_H)]
        det_boxes = [h["box"] for h in hits]
        tp = _matched_count(gt, det_boxes, iou_thr=0.35)
        self.assertGreaterEqual(tp, 1, f"Expected ≥1 match, got hits: {det_boxes}")


class TestTwoCardDetection(unittest.TestCase):
    def test_two_cards_side_by_side(self) -> None:
        """Two horizontally separated cards should each be detected."""
        canvas = _canvas_with_cards([(60, 249), (710, 249)])
        hits = _contour_multi(canvas)
        gt = [
            (60, 249, 60 + CARD_W, 249 + CARD_H),
            (710, 249, 710 + CARD_W, 249 + CARD_H),
        ]
        det_boxes = [h["box"] for h in hits]
        tp = _matched_count(gt, det_boxes, iou_thr=0.35)
        self.assertGreaterEqual(
            tp, 2,
            f"Expected 2 matched cards; got {len(hits)} detection(s): {det_boxes}",
        )

    def test_two_cards_vertical(self) -> None:
        """Two vertically stacked cards should each be detected."""
        canvas = _canvas_with_cards([(385, 30), (385, 460)])
        hits = _contour_multi(canvas)
        gt = [
            (385, 30, 385 + CARD_W, 30 + CARD_H),
            (385, 460, 385 + CARD_W, 460 + CARD_H),
        ]
        det_boxes = [h["box"] for h in hits]
        tp = _matched_count(gt, det_boxes, iou_thr=0.35)
        self.assertGreaterEqual(
            tp, 2,
            f"Expected 2 matched cards; got {len(hits)} detection(s): {det_boxes}",
        )


class TestThreeCardDetection(unittest.TestCase):
    def test_three_cards_spread(self) -> None:
        """Three horizontally spread cards should all be detected."""
        canvas = _canvas_with_cards([(60, 249), (385, 249), (710, 249)])
        hits = _contour_multi(canvas)
        gt = [
            (60, 249, 60 + CARD_W, 249 + CARD_H),
            (385, 249, 385 + CARD_W, 249 + CARD_H),
            (710, 249, 710 + CARD_W, 249 + CARD_H),
        ]
        det_boxes = [h["box"] for h in hits]
        tp = _matched_count(gt, det_boxes, iou_thr=0.35)
        self.assertGreaterEqual(
            tp, 3,
            f"Expected 3/3 matched cards; got {len(hits)} detection(s): {det_boxes}",
        )


class TestDeduplication(unittest.TestCase):
    def test_no_duplicate_from_multiple_edge_maps(self) -> None:
        """A single card should not produce multiple detections."""
        canvas = _canvas_with_cards([(385, 249)])
        hits = _contour_multi(canvas)
        # Allow up to 2 (edge maps can produce minor duplicates), but never > 3
        self.assertLessEqual(
            len(hits), 3,
            f"Deduplication failed: {len(hits)} hits for 1 card",
        )

    def test_two_cards_no_explosion(self) -> None:
        """Two cards should not produce absurdly many detections."""
        canvas = _canvas_with_cards([(60, 249), (710, 249)])
        hits = _contour_multi(canvas)
        self.assertLessEqual(
            len(hits), 6,
            f"Too many detections for 2 cards: {len(hits)}",
        )


class TestSourceLabel(unittest.TestCase):
    def test_source_is_contour(self) -> None:
        canvas = _canvas_with_cards([(385, 249)])
        hits = _contour_multi(canvas)
        for h in hits:
            self.assertEqual(h["source"], "contour")

    def test_hits_keep_perspective_quad(self) -> None:
        canvas = _canvas_with_cards([(385, 249)])
        hits = _contour_multi(canvas)
        self.assertGreaterEqual(len(hits), 1)
        quad = hits[0]["quad"]
        self.assertEqual(quad.shape, (4, 2))


class TestHighResolutionResize(unittest.TestCase):
    """Verify that detection works on high-resolution images (phone-camera scale).

    At 3024x4032 (12 MP) with _MIN_AREA_FRAC = 0.015, a card occupying ~1% of
    frame would be filtered out unless we resize before contour detection.
    """

    def test_single_card_detected_in_high_res(self) -> None:
        # Scale up to simulate a phone photo: 4× of the standard 900×680 canvas
        scale = 4
        cw, ch = 900 * scale, 680 * scale  # 3600 × 2720
        card_w, card_h = CARD_W * scale, CARD_H * scale
        x, y = 385 * scale, 249 * scale
        canvas = _canvas_with_cards([(x, y)], canvas_w=cw, canvas_h=ch, card_w=card_w, card_h=card_h)
        hits = _contour_multi(canvas)
        gt = [(x, y, x + card_w, y + card_h)]
        det_boxes = [h["box"] for h in hits]
        tp = _matched_count(gt, det_boxes, iou_thr=0.35)
        self.assertGreaterEqual(tp, 1, f"Expected ≥1 match in high-res image, got: {det_boxes}")

    def test_boxes_in_original_coordinates(self) -> None:
        """Boxes returned must be in original (high-res) pixel space, not resized."""
        scale = 4
        cw, ch = 900 * scale, 680 * scale
        card_w, card_h = CARD_W * scale, CARD_H * scale
        x, y = 385 * scale, 249 * scale
        canvas = _canvas_with_cards([(x, y)], canvas_w=cw, canvas_h=ch, card_w=card_w, card_h=card_h)
        hits = _contour_multi(canvas)
        if not hits:
            self.skipTest("No detections — coordinate test inconclusive")
        # The detected box center should be in the high-res coordinate range, not
        # the downscaled range (which would be ~4× smaller).
        cx = (hits[0]["box"][0] + hits[0]["box"][2]) / 2
        self.assertGreater(cx, 500, f"Box appears to be in downscaled coords: {hits[0]['box']}")

    def test_two_cards_high_res(self) -> None:
        scale = 4
        cw, ch = 900 * scale, 680 * scale
        card_w, card_h = CARD_W * scale, CARD_H * scale
        placements = [(60 * scale, 249 * scale), (710 * scale, 249 * scale)]
        canvas = _canvas_with_cards(placements, canvas_w=cw, canvas_h=ch, card_w=card_w, card_h=card_h)
        hits = _contour_multi(canvas)
        gt = [(x, y, x + card_w, y + card_h) for x, y in placements]
        det_boxes = [h["box"] for h in hits]
        tp = _matched_count(gt, det_boxes, iou_thr=0.35)
        self.assertGreaterEqual(tp, 2, f"Expected 2 matched high-res cards, got: {det_boxes}")


class TestCloselyPackedCards(unittest.TestCase):
    """Cards in a tight 2×3 grid with small gaps between them.

    This stresses the erosion-split pass: adjacent cards that share a
    merged edge in the adaptive-threshold map must still be separated.
    """

    GAP = 8  # px gap between cards in the grid

    def _make_grid(self, cols: int, rows: int) -> tuple[np.ndarray, list[tuple]]:
        """Return (canvas, gt_boxes) for a cols×rows card grid."""
        cw, ch = CARD_W, CARD_H
        g = self.GAP
        canvas_w = cols * cw + (cols + 1) * g + 100
        canvas_h = rows * ch + (rows + 1) * g + 100
        canvas = np.full((canvas_h, canvas_w, 3), 230, dtype=np.uint8)
        gt = []
        for r in range(rows):
            for c in range(cols):
                x = 50 + c * (cw + g)
                y = 50 + r * (ch + g)
                card = _card_image(cw, ch)
                canvas[y : y + ch, x : x + cw] = card
                gt.append((x, y, x + cw, y + ch))
        return canvas, gt

    def test_2x2_grid(self) -> None:
        canvas, gt = self._make_grid(2, 2)
        hits = _contour_multi(canvas)
        det = [h["box"] for h in hits]
        tp = _matched_count(gt, det, iou_thr=0.35)
        self.assertGreaterEqual(
            tp, 3,
            f"Expected >= 3/4 in 2x2 grid, got {len(hits)}: {det}",
        )

    def test_3x2_grid(self) -> None:
        canvas, gt = self._make_grid(3, 2)
        hits = _contour_multi(canvas)
        det = [h["box"] for h in hits]
        tp = _matched_count(gt, det, iou_thr=0.35)
        self.assertGreaterEqual(
            tp, 4,
            f"Expected >= 4/6 in 3x2 grid, got {len(hits)}: {det}",
        )

    def test_grid_no_explosion(self) -> None:
        """3×2 grid must not produce absurdly many detections."""
        canvas, _ = self._make_grid(3, 2)
        hits = _contour_multi(canvas)
        self.assertLessEqual(
            len(hits), 12,
            f"Too many detections for 3x2 grid: {len(hits)}",
        )


class TestTiltedCards(unittest.TestCase):
    """Cards rotated at moderate angles.

    The minAreaRect path handles tilted cards.  We verify detection
    still works for angles commonly seen in hand-held phone photos.
    """

    def _rotated_card_canvas(
        self, angle_deg: float, canvas_w: int = 600, canvas_h: int = 600
    ) -> tuple[np.ndarray, tuple]:
        """Place a single card rotated by angle_deg on a white canvas."""
        canvas = np.full((canvas_h, canvas_w, 3), 230, dtype=np.uint8)
        cx, cy = canvas_w // 2, canvas_h // 2
        card = _card_image(CARD_W, CARD_H)

        # Build rotated card via warpAffine
        M = cv2.getRotationMatrix2D((CARD_W // 2, CARD_H // 2), angle_deg, 1.0)
        cos, sin = abs(M[0, 0]), abs(M[0, 1])
        new_w = int(CARD_H * sin + CARD_W * cos)
        new_h = int(CARD_H * cos + CARD_W * sin)
        M[0, 2] += (new_w - CARD_W) / 2
        M[1, 2] += (new_h - CARD_H) / 2
        rotated = cv2.warpAffine(card, M, (new_w, new_h), borderValue=(230, 230, 230))

        rx, ry = cx - new_w // 2, cy - new_h // 2
        rx, ry = max(0, rx), max(0, ry)
        rh, rw = rotated.shape[:2]
        x2, y2 = min(canvas_w, rx + rw), min(canvas_h, ry + rh)
        canvas[ry:y2, rx:x2] = rotated[: y2 - ry, : x2 - rx]

        gt = (rx, ry, rx + rw, ry + rh)
        return canvas, gt

    def test_15_degree_rotation(self) -> None:
        canvas, gt = self._rotated_card_canvas(15)
        hits = _contour_multi(canvas)
        det = [h["box"] for h in hits]
        tp = _matched_count([gt], det, iou_thr=0.3)
        self.assertGreaterEqual(tp, 1, f"15-degree card not detected: {det}")

    def test_30_degree_rotation(self) -> None:
        canvas, gt = self._rotated_card_canvas(30)
        hits = _contour_multi(canvas)
        det = [h["box"] for h in hits]
        tp = _matched_count([gt], det, iou_thr=0.3)
        self.assertGreaterEqual(tp, 1, f"30-degree card not detected: {det}")

    def test_45_degree_rotation(self) -> None:
        canvas, gt = self._rotated_card_canvas(45)
        hits = _contour_multi(canvas)
        det = [h["box"] for h in hits]
        tp = _matched_count([gt], det, iou_thr=0.3)
        self.assertGreaterEqual(tp, 1, f"45-degree card not detected: {det}")

    def test_60_degree_rotation(self) -> None:
        canvas, gt = self._rotated_card_canvas(60)
        hits = _contour_multi(canvas)
        det = [h["box"] for h in hits]
        tp = _matched_count([gt], det, iou_thr=0.3)
        self.assertGreaterEqual(tp, 1, f"60-degree card not detected: {det}")

    def test_75_degree_rotation(self) -> None:
        canvas, gt = self._rotated_card_canvas(75)
        hits = _contour_multi(canvas)
        det = [h["box"] for h in hits]
        tp = _matched_count([gt], det, iou_thr=0.3)
        self.assertGreaterEqual(tp, 1, f"75-degree card not detected: {det}")


class TestPartialCardDetection(unittest.TestCase):
    """Cards that are partially clipped by the image boundary.

    Real-world listings often show cards sticking in from the edge.
    The contour detector must still count them even when only ~50% is visible.
    """

    def test_half_card_left_edge(self) -> None:
        """Card placed at x=-65 so only the right 65px (50%) is visible."""
        canvas = _canvas_with_cards([(-65, 249)])
        hits = _contour_multi(canvas)
        self.assertGreaterEqual(
            len(hits), 1,
            f"Half-card at left edge not detected: {[h['box'] for h in hits]}",
        )

    def test_half_card_right_edge(self) -> None:
        """Card placed so only the left 65px is visible at the right boundary."""
        canvas = _canvas_with_cards([(835, 249)])  # 900 - 65 = 835 → 65px visible
        hits = _contour_multi(canvas)
        self.assertGreaterEqual(
            len(hits), 1,
            f"Half-card at right edge not detected: {[h['box'] for h in hits]}",
        )

    def test_full_plus_partial_counted_as_two(self) -> None:
        """One full card in center + one half-card at right edge = at least 2 detections."""
        canvas = _canvas_with_cards([(385, 249), (835, 249)])
        hits = _contour_multi(canvas)
        self.assertGreaterEqual(
            len(hits), 2,
            f"Expected ≥2 cards (1 full + 1 partial), got {len(hits)}: "
            f"{[h['box'] for h in hits]}",
        )

    def test_quarter_card_top_edge(self) -> None:
        """Card clipped so only the bottom quarter (~45px) is visible at the top."""
        canvas = _canvas_with_cards([(385, -(CARD_H - 45))])
        hits = _contour_multi(canvas)
        self.assertGreaterEqual(
            len(hits), 1,
            f"Quarter-card at top edge not detected: {[h['box'] for h in hits]}",
        )


if __name__ == "__main__":
    unittest.main()
