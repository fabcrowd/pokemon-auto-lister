"""identify_all_from_bytes: catalog slab labels replace the visual id; invented ones do not."""

from __future__ import annotations

import base64
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai import identify_multi  # noqa: E402


def _jpeg(w: int, h: int) -> bytes:
    ok, buf = cv2.imencode(".jpg", np.full((h, w, 3), 128, np.uint8))
    assert ok
    return buf.tobytes()


_CROP = base64.b64encode(_jpeg(75, 105)).decode()
LABEL_HIT = {"index": 0, "box": [100, 20, 420, 130], "class_id": 0, "crop_b64": _CROP}
CARD_HIT = {"index": 1, "box": [110, 160, 410, 580], "class_id": 0, "crop_b64": _CROP}
VISUAL = {"identity": {"name": "Venusaur", "set": "Legendary Collection", "setCode": "lc", "number": "18",
                       "productId": "lc-18"}, "confidence": "high", "abstain": False, "reason": "local-feature-verify"}
LABEL_TEXT = ["2023POKEMONCLVEN", "#003", "VENUSAUR", "GEMMT", "10", "84291625"]
META = [{"id": "lc-18", "name": "Venusaur", "set": "Legendary Collection", "setCode": "lc", "number": "18"}]


def _fake_read(image_bgr, box):
    x1, y1, x2, y2 = box
    # Only the region where the label sits (top of the photo) has label text.
    return LABEL_TEXT if y2 <= 160 else ["Solar Beam", "60"]


class SlabLabelIntegrationTests(unittest.TestCase):
    def _run(self, hits):
        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=hits), \
             patch.object(identify_multi, "identify_rectified_bytes", return_value=VISUAL), \
             patch.object(identify_multi, "_read_text", side_effect=_fake_read), \
             patch.object(identify_multi, "_catalog_meta", return_value=META),              patch.object(identify_multi, "_catalog_set_years", return_value={"lc": 2002}):
            return identify_multi.identify_all_from_bytes(_jpeg(520, 640))

    def test_label_hit_is_removed_and_its_text_identifies_the_card_below(self):
        results = self._run([LABEL_HIT, CARD_HIT])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].identity["productId"], "lc-18")
        self.assertEqual(results[0].identity["grade"], "10")
        self.assertEqual(results[0].identity["cert"], "84291625")
        self.assertEqual(results[0].reason, "local-feature-verify")

    def test_label_above_card_is_read_even_when_detector_missed_the_label(self):
        results = self._run([CARD_HIT])
        self.assertEqual(results[0].identity["productId"], "lc-18")
        self.assertEqual(results[0].identity["grade"], "10")

    def test_raw_card_without_label_keeps_visual_identity(self):
        raw_card = {**CARD_HIT, "box": [110, 300, 410, 620]}
        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=[raw_card]), \
             patch.object(identify_multi, "identify_rectified_bytes", return_value=VISUAL), \
             patch.object(identify_multi, "_read_text", return_value=["Solar Beam", "60"]), \
             patch.object(identify_multi, "_catalog_meta", return_value=META),              patch.object(identify_multi, "_catalog_set_years", return_value={"lc": 2002}):
            results = identify_multi.identify_all_from_bytes(_jpeg(520, 640))
        self.assertEqual(results[0].identity["productId"], "lc-18")

    def test_label_year_rejects_same_name_number_reprint_from_another_era(self):
        meta = [{"id": "lc-3", "name": "Venusaur", "set": "Legendary Collection", "setCode": "lc", "number": "3"}]
        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=[CARD_HIT]),              patch.object(identify_multi, "identify_rectified_bytes", return_value=VISUAL),              patch.object(identify_multi, "_read_text", side_effect=_fake_read),              patch.object(identify_multi, "_catalog_meta", return_value=meta),              patch.object(identify_multi, "_catalog_set_years", return_value={"lc": 2002}):
            results = identify_multi.identify_all_from_bytes(_jpeg(520, 640))
        self.assertEqual(results[0].identity["productId"], "lc-18")
        self.assertEqual(results[0].identity["grade"], "10")
        self.assertNotEqual(results[0].reason, "slab-label")

    def test_classic_label_becomes_the_id_when_visual_identification_abstains(self):
        abstain = {"identity": None, "confidence": "low", "abstain": True, "reason": "blur_too_high"}
        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=[CARD_HIT]), \
             patch.object(identify_multi, "identify_rectified_bytes", return_value=abstain), \
             patch.object(identify_multi, "_read_text", side_effect=_fake_read), \
             patch.object(identify_multi, "_catalog_meta", return_value=META), \
             patch.object(identify_multi, "_catalog_set_years", return_value={"lc": 2002}):
            results = identify_multi.identify_all_from_bytes(_jpeg(520, 640))
        self.assertEqual(results[0].identity["productId"], "label:CLV-003")
        self.assertEqual(results[0].reason, "slab-label")
        self.assertFalse(results[0].abstain)

    def test_unknown_label_keeps_verified_identity_and_attaches_grade(self):
        unknown = ["2023POKEMONZZZEN", "#018", "VENUSAUR", "9", "12345678"]

        def read(_image_bgr, box):
            _x1, _y1, _x2, y2 = box
            return unknown if y2 <= 160 else ["Solar Beam", "60"]

        meta = [{"id": "swsh10.5-18", "name": "Venusaur", "set": "Pokémon GO", "setCode": "swsh10.5", "number": "18"}]
        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=[CARD_HIT]), \
             patch.object(identify_multi, "identify_rectified_bytes", return_value=VISUAL), \
             patch.object(identify_multi, "_read_text", side_effect=read), \
             patch.object(identify_multi, "_catalog_meta", return_value=meta), \
             patch.object(identify_multi, "_catalog_set_years", return_value={"swsh10.5": 2022}):
            results = identify_multi.identify_all_from_bytes(_jpeg(520, 640))
        self.assertEqual(results[0].identity["productId"], "lc-18")
        self.assertEqual(results[0].identity["grade"], "9")
        self.assertEqual(results[0].identity["cert"], "12345678")
        self.assertEqual(results[0].reason, "local-feature-verify")

    def test_catalog_label_replaces_a_verified_visual_id(self):
        lines = ["2000 POKEMON GAME", "#93", "SQUIRTLE", "MINT", "BASEII", "9", "56325958"]

        def read(_image_bgr, box):
            return lines if box[3] <= 160 else ["Bubble"]

        meta = [{"id": "base4-93", "name": "Squirtle", "set": "Base Set 2", "setCode": "base4", "number": "93"}]
        visual = {"identity": {"name": "Squirtle", "set": "Base Set", "setCode": "base1", "number": "63",
                               "productId": "base1-63"},
                  "confidence": "high", "abstain": False, "reason": "local-feature-verify"}
        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=[CARD_HIT]), \
             patch.object(identify_multi, "identify_rectified_bytes", return_value=visual), \
             patch.object(identify_multi, "_read_text", side_effect=read), \
             patch.object(identify_multi, "_catalog_meta", return_value=meta), \
             patch.object(identify_multi, "_catalog_set_years", return_value={"base4": 2000, "base1": 1999}):
            results = identify_multi.identify_all_from_bytes(_jpeg(520, 640))
        self.assertEqual(results[0].identity["productId"], "base4-93")
        self.assertEqual(results[0].reason, "slab-label")


    def test_misread_label_number_does_not_override_verified_visual_id(self):
        lines = ["1999 POKEMON GAME", "#16", "VENUSAUR-HOLO", "BASE"]

        def read(_image_bgr, box):
            return lines if box[3] <= 160 else ["Solar Beam"]

        meta = [
            {"id": "base1-15", "name": "Venusaur", "set": "Base Set", "setCode": "base1", "number": "15"},
            {"id": "base1-16", "name": "Zapdos", "set": "Base Set", "setCode": "base1", "number": "16"},
        ]
        visual = {"identity": {"name": "Venusaur", "set": "Base Set", "setCode": "base1", "number": "15",
                               "productId": "base1-15"},
                  "confidence": "high", "abstain": False, "reason": "local-feature-verify"}
        with patch.object(identify_multi, "detect_all_cards_with_crops", return_value=[CARD_HIT]), \
             patch.object(identify_multi, "identify_rectified_bytes", return_value=visual), \
             patch.object(identify_multi, "_read_text", side_effect=read), \
             patch.object(identify_multi, "_catalog_meta", return_value=meta), \
             patch.object(identify_multi, "_catalog_set_years", return_value={"base1": 1999}):
            results = identify_multi.identify_all_from_bytes(_jpeg(520, 640))
        self.assertEqual(results[0].identity["productId"], "base1-15")
        self.assertEqual(results[0].reason, "local-feature-verify")


class CatalogSetYearsTests(unittest.TestCase):
    def test_missing_file_is_not_memoized(self):
        clear = getattr(identify_multi._catalog_set_years, "cache_clear", None)
        if clear is not None:
            clear()
        with tempfile.TemporaryDirectory() as tmp:
            index = Mock()
            index.catalog_dir = Path(tmp)
            with patch.object(identify_multi, "get_index", return_value=index):
                self.assertEqual(identify_multi._catalog_set_years(), {})
                (Path(tmp) / "set_years.json").write_text('{"lc": 2002}', encoding="utf-8")
                self.assertEqual(identify_multi._catalog_set_years(), {"lc": 2002})


if __name__ == "__main__":
    unittest.main()
