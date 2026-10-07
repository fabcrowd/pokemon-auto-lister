"""Progressive multi-card tests weighted on verified card IDs.

Each painted card carries a unique BGR color bound to a verified identity
(name, number, setCode). After contour detect + crop, a color identifier
must recover that ID. Box IoU alone is not enough — see eval_score weights.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["VELLUM_AI_DETECT_ONNX"] = "/nonexistent/model.onnx"

from vellum_ai.detect_multi import _contour_multi  # noqa: E402
from vellum_ai.eval_score import DEFAULT_GATE, score_scene  # noqa: E402
from vellum_ai.rectify import rectify_from_box  # noqa: E402

CARD_W = 130
CARD_H = 182

# Verified IDs (name + number + set). Colors must stay far apart.
VERIFIED = [
    {"name": "Charizard", "number": "4", "setCode": "base1", "bgr": (40, 70, 200)},
    {"name": "Blastoise", "number": "2", "setCode": "base1", "bgr": (200, 120, 40)},
    {"name": "Venusaur", "number": "15", "setCode": "base1", "bgr": (50, 170, 45)},
    {"name": "Pikachu", "number": "25", "setCode": "base1", "bgr": (20, 210, 230)},
]


def _paint_card(card: Dict) -> np.ndarray:
    img = np.full((CARD_H, CARD_W, 3), card["bgr"], dtype=np.uint8)
    cv2.rectangle(img, (2, 2), (CARD_W - 3, CARD_H - 3), (230, 230, 230), 3)
    return img


def _canvas(placements: Sequence[Tuple[Dict, int, int]], w: int = 900, h: int = 680) -> np.ndarray:
    canvas = np.full((h, w, 3), 230, dtype=np.uint8)
    for card, x, y in placements:
        canvas[y : y + CARD_H, x : x + CARD_W] = _paint_card(card)
    return canvas


def _identify_crop(crop: np.ndarray) -> Dict[str, str] | None:
    """Nearest verified color in the crop interior. Test-only identifier."""
    h, w = crop.shape[:2]
    patch = crop[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4]
    if patch.size == 0:
        return None
    mean = patch.mean(axis=(0, 1))
    best, best_d = None, 1e9
    for card in VERIFIED:
        dist = float(np.linalg.norm(mean - np.asarray(card["bgr"], dtype=np.float64)))
        if dist < best_d:
            best, best_d = card, dist
    if best is None or best_d > 45.0:
        return None
    return {"name": best["name"], "number": best["number"], "setCode": best["setCode"]}


def _detect_and_identify(canvas: np.ndarray) -> List[Dict]:
    hits = _contour_multi(canvas)
    preds = []
    for hit in hits:
        box = hit["box"]
        crop = rectify_from_box(canvas, box)
        ident = _identify_crop(crop) or {}
        preds.append({**ident, "box": box})
    return preds


def _truth(placements: Sequence[Tuple[Dict, int, int]]) -> List[Dict]:
    rows = []
    for card, x, y in placements:
        rows.append(
            {
                "name": card["name"],
                "number": card["number"],
                "setCode": card["setCode"],
                "box": (x, y, x + CARD_W, y + CARD_H),
            }
        )
    return rows


class TestStage1TwoCardIdentity(unittest.TestCase):
    """Stage 1: two spread cards — both verified IDs must be recovered."""

    def test_two_verified_ids(self) -> None:
        placements = [
            (VERIFIED[0], 60, 249),
            (VERIFIED[1], 710, 249),
        ]
        canvas = _canvas(placements)
        result = score_scene(_truth(placements), _detect_and_identify(canvas))
        self.assertGreaterEqual(
            result["score"],
            DEFAULT_GATE,
            f"stage1 identity-weighted score {result}",
        )
        self.assertEqual(result["identity_hits"], 2, result)


class TestStage2ThreeCardIdentity(unittest.TestCase):
    """Stage 2: three spread cards — all three verified IDs."""

    def test_three_verified_ids(self) -> None:
        placements = [
            (VERIFIED[0], 60, 249),
            (VERIFIED[1], 385, 249),
            (VERIFIED[2], 710, 249),
        ]
        canvas = _canvas(placements)
        result = score_scene(_truth(placements), _detect_and_identify(canvas))
        self.assertGreaterEqual(
            result["score"],
            DEFAULT_GATE,
            f"stage2 identity-weighted score {result}",
        )
        self.assertEqual(result["identity_hits"], 3, result)


class TestStage3Grid2x2Identity(unittest.TestCase):
    """Stage 3: tight 2×2 — at least 3 of 4 verified IDs after detect+crop."""

    GAP = 8

    def test_2x2_verified_ids(self) -> None:
        g = self.GAP
        placements = []
        for i, card in enumerate(VERIFIED[:4]):
            col, row = i % 2, i // 2
            x = 50 + col * (CARD_W + g)
            y = 50 + row * (CARD_H + g)
            placements.append((card, x, y))
        canvas_w = 2 * CARD_W + 3 * g + 100
        canvas_h = 2 * CARD_H + 3 * g + 100
        canvas = _canvas(placements, w=canvas_w, h=canvas_h)
        result = score_scene(_truth(placements), _detect_and_identify(canvas))
        self.assertGreaterEqual(
            result["score"],
            DEFAULT_GATE,
            f"stage3 identity-weighted score {result}",
        )
        self.assertGreaterEqual(result["identity_hits"], 3, result)


if __name__ == "__main__":
    unittest.main()
