"""The set-symbol crop and the titles that name it."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from vellum_ai.set_symbol import art_frame_bottom, set_symbol_label, symbol_box  # noqa: E402


class SetSymbolTests(unittest.TestCase):
    def test_wotc_titles_name_the_symbol(self):
        self.assertEqual(set_symbol_label("Jungle Scyther 10/64 Holo"), "jungle")
        self.assertEqual(set_symbol_label("Fossil Zapdos Non Holo 30/62"), "fossil")
        self.assertEqual(set_symbol_label("Team Rocket Dark Arbok 19/82"), "rocket")
        self.assertEqual(set_symbol_label("Shadowless Base Set Gastly 50/102"), "base")
        self.assertEqual(set_symbol_label("Unlimited Base Set Mewtwo 10/102"), "base")

    def test_other_marks_are_not_these_four(self):
        self.assertIsNone(set_symbol_label("Base Set 2 Poliwrath 15/130"))
        self.assertIsNone(set_symbol_label("Gym Heroes Rocket's Snorlax 33/132"))
        self.assertIsNone(set_symbol_label("Black Star Promo Marill 29"))

    def test_the_picture_frame_is_used_and_the_attack_line_is_not(self):
        gray = np.full((1000, 700), 160.0, dtype=np.float32)
        gray[400, 140:560] = 30.0
        gray[700, 140:560] = 0.0
        self.assertLess(abs(art_frame_bottom(gray) - 400), 5)

    def test_crop_covers_the_species_line_on_the_right(self):
        x1, y1, x2, y2 = symbol_box(750, 1050)
        self.assertGreaterEqual(x1, 500)
        self.assertLess(y1, 500)
        self.assertGreater(y2 - y1, 100)
        self.assertGreater(x2, x1)
        self.assertLessEqual(x2, 750)
