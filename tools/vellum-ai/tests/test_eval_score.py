"""Unit tests for identity-weighted scene scoring."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.eval_score import (  # noqa: E402
    DEFAULT_GATE,
    identities_match,
    normalize_number,
    score_scene,
)


class TestNormalizeNumber(unittest.TestCase):
    def test_strips_total_and_leading_zeros(self) -> None:
        self.assertEqual(normalize_number("004/102"), "4")
        self.assertEqual(normalize_number(4), "4")


class TestIdentitiesMatch(unittest.TestCase):
    def test_name_and_number_match(self) -> None:
        truth = {"name": "Charizard", "number": "4", "setCode": "base1"}
        pred = {"name": "charizard", "number": "004/102", "setCode": "base1"}
        self.assertTrue(identities_match(truth, pred))

    def test_wrong_name_fails(self) -> None:
        truth = {"name": "Charizard", "number": "4"}
        pred = {"name": "Blastoise", "number": "4"}
        self.assertFalse(identities_match(truth, pred))

    def test_set_mismatch_fails_when_both_present(self) -> None:
        truth = {"name": "Pikachu", "number": "25", "setCode": "base1"}
        pred = {"name": "Pikachu", "number": "25", "setCode": "sv3"}
        self.assertFalse(identities_match(truth, pred))


class TestScoreSceneWeights(unittest.TestCase):
    def test_wrong_identity_cannot_pass_on_iou_alone(self) -> None:
        truth = [{"name": "Charizard", "number": "4", "setCode": "base1", "box": (0, 0, 100, 140)}]
        pred = [{"name": "Blastoise", "number": "2", "setCode": "base1", "box": (0, 0, 100, 140)}]
        result = score_scene(truth, pred)
        self.assertEqual(result["identity_hits"], 0)
        self.assertLess(result["score"], 0.50)
        self.assertFalse(result["passes_gate"])
        self.assertLess(result["score"], DEFAULT_GATE)

    def test_correct_identity_passes_with_moderate_iou(self) -> None:
        truth = [{"name": "Charizard", "number": "4", "setCode": "base1", "box": (0, 0, 100, 140)}]
        pred = [{"name": "Charizard", "number": "4", "setCode": "base1", "box": (10, 10, 100, 140)}]
        result = score_scene(truth, pred)
        self.assertEqual(result["identity_hits"], 1)
        self.assertGreaterEqual(result["score"], DEFAULT_GATE)
        self.assertTrue(result["passes_gate"])

    def test_two_of_two_identities(self) -> None:
        truth = [
            {"name": "Charizard", "number": "4", "setCode": "base1", "box": (0, 0, 80, 120)},
            {"name": "Blastoise", "number": "2", "setCode": "base1", "box": (200, 0, 280, 120)},
        ]
        pred = [
            {"name": "Charizard", "number": "4", "setCode": "base1", "box": (0, 0, 80, 120)},
            {"name": "Blastoise", "number": "2", "setCode": "base1", "box": (200, 0, 280, 120)},
        ]
        result = score_scene(truth, pred)
        self.assertEqual(result["identity_recall"], 1.0)
        self.assertTrue(result["passes_gate"])


if __name__ == "__main__":
    unittest.main()
