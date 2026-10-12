"""Binder pages are sorted by set: identified neighbours narrow the search for unresolved cards."""

from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai import identify_multi  # noqa: E402

_OK, _BUF = cv2.imencode(".jpg", np.full((105, 75, 3), 128, np.uint8))
CROP = base64.b64encode(_BUF.tobytes()).decode()
META = [
    {"id": "base3-53", "name": "Psyduck", "set": "Fossil", "setCode": "base3", "number": "53"},
    {"id": "base3-48", "name": "Grimer", "set": "Fossil", "setCode": "base3", "number": "48"},
    {"id": "base3-55", "name": "Slowpoke", "set": "Fossil", "setCode": "base3", "number": "55"},
    {"id": "lc-93", "name": "Slowpoke", "set": "Legendary Collection", "setCode": "lc", "number": "93"},
]


def _ident(pid):
    m = next(r for r in META if r["id"] == pid)
    return {"identity": {"name": m["name"], "set": m["set"], "setCode": m["setCode"], "number": m["number"],
                         "productId": pid}, "confidence": "high", "abstain": False, "reason": "local-feature-verify"}


ABSTAIN = {"identity": None, "confidence": "low", "abstain": True, "reason": "blur_too_high"}


class SetContextTests(unittest.TestCase):
    def _run(self, visual, inliers):
        hits = [{"index": i, "box": [i * 100, 0, i * 100 + 70, 100], "class_id": 0, "crop_b64": CROP} for i in range(len(visual))]

        def fake_verify(crop, cands, images_dir=None, k=20):
            ranked = [{**c, "inliers": inliers.get(c["id"], 0)} for c in cands]
            return sorted(ranked, key=lambda h: h["inliers"], reverse=True)

        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=hits), \
             patch.object(identify_multi, "identify_rectified_bytes", side_effect=visual), \
             patch.object(identify_multi, "_read_text", return_value=[]), \
             patch.object(identify_multi, "_catalog_meta", return_value=META), \
             patch.object(identify_multi, "verify_candidates", side_effect=fake_verify) as verify:
            ok, buf = cv2.imencode(".jpg", np.full((200, 400, 3), 128, np.uint8))
            return identify_multi.identify_all_from_bytes(buf.tobytes()), verify

    def test_unresolved_card_is_verified_against_the_pages_dominant_set(self):
        results, verify = self._run([_ident("base3-53"), _ident("base3-48"), ABSTAIN], {"base3-55": 90, "base3-53": 5})
        self.assertEqual(results[2].identity["productId"], "base3-55")
        self.assertEqual(results[2].reason, "set-context-verify")
        pool = sorted(c["id"] for c in verify.call_args[0][1])
        self.assertEqual(pool, ["base3-48", "base3-53", "base3-55"])

    def test_no_context_from_a_single_identified_card(self):
        results, verify = self._run([_ident("base3-53"), ABSTAIN], {"base3-55": 90})
        self.assertTrue(results[1].abstain)
        verify.assert_not_called()

    def test_weak_match_stays_abstained(self):
        results, _ = self._run([_ident("base3-53"), _ident("base3-48"), ABSTAIN], {"base3-55": 12})
        self.assertTrue(results[2].abstain)

    def test_same_art_reprint_from_another_set_follows_the_page(self):
        results, _ = self._run([_ident("base3-53"), _ident("base3-48"), _ident("lc-93")], {"lc-93": 90, "base3-55": 86})
        self.assertEqual(results[2].identity["productId"], "base3-55")
        self.assertEqual(results[2].reason, "set-context-reprint")

    def test_number_confirmed_reprint_is_kept(self):
        confirmed = {**_ident("lc-93"), "reason": "verify-ocr-number"}
        results, _ = self._run([_ident("base3-53"), _ident("base3-48"), confirmed], {})
        self.assertEqual(results[2].identity["productId"], "lc-93")

    def test_different_art_print_from_another_set_is_kept(self):
        results, _ = self._run([_ident("base3-53"), _ident("base3-48"), _ident("lc-93")], {"lc-93": 120, "base3-55": 15})
        self.assertEqual(results[2].identity["productId"], "lc-93")

    def test_api_ocr_number_confirmed_reprint_is_kept(self):
        confirmed = {**_ident("lc-93"), "reason": "tcg-api-ocr"}
        results, _ = self._run([_ident("base3-53"), _ident("base3-48"), confirmed], {"lc-93": 90, "base3-55": 90})
        self.assertEqual(results[2].identity["productId"], "lc-93")

    def test_undecodable_crop_does_not_break_the_photo(self):
        bad = dict(ABSTAIN)
        hits = [{"index": i, "box": [i * 100, 0, i * 100 + 70, 100], "class_id": 0, "crop_b64": CROP if i < 2 else "@@@"} for i in range(3)]
        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=hits),              patch.object(identify_multi, "identify_rectified_bytes", side_effect=[_ident("base3-53"), _ident("base3-48"), bad]),              patch.object(identify_multi, "_read_text", return_value=[]),              patch.object(identify_multi, "_catalog_meta", return_value=META),              patch.object(identify_multi, "verify_candidates", return_value=[]):
            ok, buf = cv2.imencode(".jpg", np.full((200, 400, 3), 128, np.uint8))
            results = identify_multi.identify_all_from_bytes(buf.tobytes())
        self.assertEqual(len(results), 3)
        self.assertTrue(results[2].abstain)


if __name__ == "__main__":
    unittest.main()
