"""Pipeline wiring: local-feature verification decides before OCR fusion."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai import pipeline  # noqa: E402
from vellum_ai.name_candidates import NameIndex  # noqa: E402

HITS = [
    {"id": "A3b-001", "name": "Tropius", "set": "Eevee Grove", "setCode": "A3b", "number": "001", "score": 0.86},
    {"id": "swsh7-6", "name": "Tropius", "set": "Evolving Skies", "setCode": "swsh7", "number": "6", "score": 0.86},
    {"id": "bw10-5", "name": "Tropius", "set": "Plasma Blast", "setCode": "bw10", "number": "5", "score": 0.85},
]


class _FakeIndex:
    def __init__(self, hits=None):
        self.hits = hits or HITS

    def available(self):
        return True

    def search(self, image, k=20):
        return list(self.hits)[:k]


def _crop():
    rng = np.random.default_rng(0)
    return rng.integers(60, 200, (1050, 750, 3), dtype=np.uint8)


class PipelineVerifyTests(unittest.TestCase):
    def _run(self, inliers, blur=100.0, hits=None, name_lines=(), names=(), ocr=None, verify_fn=None):
        def fake_verify(crop, hits, images_dir=None, k=20):
            ranked = [{**h, "inliers": inliers.get(h["id"], 0)} for h in hits]
            return sorted(ranked, key=lambda h: h["inliers"], reverse=True)

        with patch.object(pipeline, "get_index", return_value=_FakeIndex(hits)), \
             patch.object(pipeline, "verify_candidates", side_effect=verify_fn or fake_verify) as verify, \
             patch.object(pipeline, "run_ocr", return_value=ocr or {}), \
             patch.object(pipeline, "rerank_clip_hits", side_effect=lambda img, hits, lookup: hits), \
             patch.object(pipeline, "glare_score", return_value=0.0), \
             patch.object(pipeline, "blur_score", return_value=blur),              patch.object(pipeline, "read_name_lines", return_value=list(name_lines)),              patch.object(pipeline, "get_name_index", return_value=NameIndex(list(names))):
            return pipeline._identify_rectified(_crop()), verify

    def test_confident_geometric_match_is_accepted_without_ocr(self):
        result, verify = self._run({"swsh7-6": 180, "bw10-5": 20})
        self.assertFalse(result["abstain"])
        self.assertEqual(result["identity"]["productId"], "swsh7-6")
        self.assertEqual(result["reason"], "local-feature-verify")
        passed_ids = [h["id"] for h in verify.call_args[0][1]]
        self.assertNotIn("A3b-001", passed_ids)

    def test_blurry_crop_with_strong_geometric_match_is_still_accepted(self):
        result, _ = self._run({"swsh7-6": 150, "bw10-5": 12}, blur=5.0)
        self.assertEqual(result["reason"], "local-feature-verify")

    def test_blurry_crop_without_geometric_match_still_abstains_on_blur(self):
        result, _ = self._run({"swsh7-6": 9}, blur=5.0)
        self.assertEqual(result["reason"], "blur_too_high")

    def test_weak_geometric_match_falls_back_to_fusion(self):
        result, _ = self._run({"swsh7-6": 9, "bw10-5": 6})
        self.assertNotEqual(result.get("reason"), "local-feature-verify")

    def test_true_card_ranked_below_top_20_is_found_by_second_pass(self):
        many = [{"id": f"x{i}-{i}", "name": "Filler", "setCode": f"x{i}", "number": str(i), "score": 0.9 - i / 100}
                for i in range(30)]
        result, verify = self._run({"x25-25": 179, "x0-0": 10}, hits=many)
        self.assertEqual(result["identity"]["productId"], "x25-25")
        self.assertEqual(verify.call_count, 2)

    def test_second_pass_skipped_when_top_20_already_accepts(self):
        many = [{"id": f"x{i}-{i}", "name": "Filler", "setCode": f"x{i}", "number": str(i), "score": 0.9}
                for i in range(30)]
        _, verify = self._run({"x3-3": 150}, hits=many)
        self.assertEqual(verify.call_count, 1)

    def test_name_ocr_finds_card_clip_missed(self):
        names = [{"id": "me02-025", "name": "Mamoswine", "set": "Phantasmal Flames", "setCode": "me02", "number": "025"},
                 {"id": "dp6-9", "name": "Mamoswine", "set": "Legends Awakened", "setCode": "dp6", "number": "9"}]
        result, verify = self._run({"me02-025": 160, "dp6-9": 12, "swsh7-6": 9}, blur=5.0,
                                   name_lines=["Mamoswine 180"], names=names)
        self.assertEqual(result["identity"]["productId"], "me02-025")
        self.assertEqual(result["reason"], "name-feature-verify")
        name_pass = [h["id"] for h in verify.call_args_list[-1][0][1]]
        self.assertEqual(sorted(name_pass), ["dp6-9", "me02-025"])

    def test_name_path_skipped_when_clip_candidates_already_verify(self):
        result, verify = self._run({"swsh7-6": 180}, name_lines=["Tropius"], names=[])
        self.assertEqual(result["reason"], "local-feature-verify")
        self.assertEqual(verify.call_count, 1)

    LEAFEONS = [
        {"id": "sv06-011", "name": "Leafeon", "set": "Twilight Masquerade", "setCode": "sv06", "number": "011", "score": 0.9},
        {"id": "sv08.5-005", "name": "Leafeon", "set": "Prismatic Evolutions", "setCode": "sv08.5", "number": "005",
         "score": 0.89},
        {"id": "x-1", "name": "Other", "setCode": "x", "number": "1", "score": 0.5},
    ]

    def test_same_art_reprints_are_split_by_the_printed_number(self):
        result, _ = self._run({"sv06-011": 150, "sv08.5-005": 120, "x-1": 5}, hits=self.LEAFEONS,
                              ocr={"number": "005", "total": "131"})
        self.assertEqual(result["identity"]["productId"], "sv08.5-005")
        self.assertEqual(result["reason"], "verify-ocr-number")

    def test_reprint_tie_without_readable_number_keeps_clear_geometric_winner(self):
        result, _ = self._run({"sv06-011": 150, "sv08.5-005": 120, "x-1": 5}, hits=self.LEAFEONS, ocr={})
        self.assertEqual(result["identity"]["productId"], "sv06-011")

    def test_near_tie_reprints_resolved_by_number(self):
        result, _ = self._run({"sv06-011": 101, "sv08.5-005": 100, "x-1": 5}, hits=self.LEAFEONS,
                              ocr={"number": "5"})
        self.assertEqual(result["identity"]["productId"], "sv08.5-005")

    def test_name_print_past_the_cap_is_ranked_ahead_of_the_cut(self):
        prints = [
            {"id": f"set{i}-{i}", "name": "Pikachu", "set": f"Set {i}", "setCode": f"s{i}", "number": str(i)}
            for i in range(120)
        ]
        prints[100]["id"] = "promo-500"
        prints[100]["number"] = "500"
        result, verify = self._run({"promo-500": 160}, blur=5.0, name_lines=["Pikachu"], names=prints,
                                   ocr={"number": "500"})
        self.assertEqual(result["identity"]["productId"], "promo-500")
        name_pass = [h["id"] for h in verify.call_args_list[-1][0][1]]
        self.assertIn("promo-500", name_pass)
        self.assertLessEqual(len(name_pass), pipeline._MAX_NAME_PRINTS)

    def test_name_rank_orders_by_ocr_number_then_clip_score(self):
        named = [
            {"id": "a", "number": "1"},
            {"id": "b", "number": "2"},
            {"id": "c", "number": "9"},
        ]
        deep = [{"id": "b", "score": 0.2}, {"id": "a", "score": 0.9}]
        ranked = pipeline._rank_name_prints(named, "9", deep)
        self.assertEqual([hit["id"] for hit in ranked], ["c", "a", "b"])

    def test_clip_score_pulls_a_late_name_print_into_the_cap_without_ocr(self):
        prints = [
            {"id": f"set{i}-{i}", "name": "Pikachu", "set": f"Set {i}", "setCode": f"s{i}", "number": str(1000 + i)}
            for i in range(120)
        ]
        prints[100]["id"] = "promo-500"
        clip = [{"id": f"miss-{i}", "name": "Other", "setCode": "x", "number": str(i), "score": 0.1} for i in range(60)]
        clip[50] = {"id": "promo-500", "name": "Pikachu", "setCode": "svp", "number": "500", "score": 0.99}

        def verify(_crop, hits, images_dir=None, k=20):
            found = any(hit.get("id") == "promo-500" for hit in hits) and len(hits) > 20
            ranked = [{**hit, "inliers": 160 if found and hit.get("id") == "promo-500" else 0} for hit in hits]
            return sorted(ranked, key=lambda hit: hit["inliers"], reverse=True)

        result, verify_mock = self._run({}, blur=5.0, hits=clip, name_lines=["Pikachu"], names=prints, ocr={},
                                        verify_fn=verify)
        self.assertEqual(result["identity"]["productId"], "promo-500")
        self.assertIn("promo-500", [hit["id"] for hit in verify_mock.call_args_list[-1][0][1]])


if __name__ == "__main__":
    unittest.main()
