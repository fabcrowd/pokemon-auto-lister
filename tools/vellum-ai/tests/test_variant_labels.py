"""Listing titles that can label a real photograph, and titles that cannot."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.variant_labels import variant_labels  # noqa: E402


class VariantLabelTests(unittest.TestCase):
    def test_first_edition_holo(self):
        labels = variant_labels("1st Edition Jolteon Holo Pokemon Card Jungle Set 4/64")
        self.assertEqual(labels, {"edition": "first", "finish": "holofoil", "stamp": "none"})

    def test_first_edition_shadowless_is_the_first_edition(self):
        labels = variant_labels("1st Edition Shadowless Base Set Gyarados Holo #6/102")
        self.assertEqual(labels["edition"], "first")
        self.assertEqual(labels["finish"], "holofoil")

    def test_shadowless_without_a_stamp(self):
        labels = variant_labels("Pokemon TCG Squirtle Shadowless Vintage Base Set Card 63/102")
        self.assertEqual(labels["edition"], "shadowless")
        self.assertNotIn("finish", labels)

    def test_reverse_holo_is_not_a_first_edition(self):
        labels = variant_labels("Reverse Holo Pikachu Pokemon Card")
        self.assertEqual(labels, {"edition": "standard", "finish": "reverse", "stamp": "none"})

    def test_non_holo_is_read_before_holo(self):
        labels = variant_labels("1st Edition Machamp non-holo Base Set")
        self.assertEqual(labels["edition"], "first")
        self.assertEqual(labels["finish"], "normal")

    def test_unlimited_holo(self):
        labels = variant_labels("Unlimited Base Set Charizard Holo 4/102")
        self.assertEqual(labels, {"edition": "standard", "finish": "holofoil", "stamp": "none"})

    def test_prerelease_staff_and_league_stamps(self):
        self.assertEqual(variant_labels("Prerelease Raichu Pokemon")["stamp"], "prerelease")
        self.assertEqual(variant_labels("Pokemon Staff Charizard Promo")["stamp"], "staff")
        self.assertEqual(variant_labels("Pokemon League stamp Pikachu")["stamp"], "league")

    def test_a_set_stamp_is_its_own_variant(self):
        labels = variant_labels("Pokemon TCG Armaldo Stamped Reverse Holo Rare")
        self.assertEqual(labels["stamp"], "setstamp")
        self.assertEqual(labels["finish"], "reverse")

    def test_an_unstated_edition_is_left_unlabeled(self):
        labels = variant_labels("Pokemon Charizard Holo Base Set 4/102")
        self.assertNotIn("edition", labels)
        self.assertEqual(labels["finish"], "holofoil")

    def test_a_negated_edition_is_not_a_label(self):
        self.assertIsNone(variant_labels("Not 1st Edition Charizard Holo Base Set"))
        self.assertIsNone(variant_labels("Non-Shadowless Base Set Pikachu"))
        self.assertIsNone(variant_labels("Blastoise Holo no 1st edition stamp"))

    def test_1st_needs_edition_after_it(self):
        labels = variant_labels("Pokemon 1st Place Trainer Holo Promo")
        self.assertNotEqual(labels.get("edition"), "first")
        self.assertEqual(variant_labels("1st Ed Jolteon Holo Jungle")["edition"], "first")

    def test_a_1st_edition_stamp_is_not_a_set_stamp(self):
        labels = variant_labels("1st Edition Stamped Machamp Holo Base Set")
        self.assertEqual(labels["edition"], "first")
        self.assertEqual(labels["stamp"], "none")

    def test_fakes_and_reprints_are_not_labels(self):
        for title in ("Custom Charizard Holo Card", "Reprint 1st Edition Charizard",
                      "Orica Shadowless Mewtwo", "Fake Holo Charizard", "Replica Base Set Blastoise Holo"):
            self.assertIsNone(variant_labels(title), title)

    def test_lots_scans_and_unnamed_cards_are_not_labels(self):
        self.assertIsNone(variant_labels("Lot of Vintage 1st Edition Pokemon Cards"))
        self.assertIsNone(variant_labels("Digital scan of Base Set Charizard"))
        self.assertIsNone(variant_labels("Proxy Charizard holo"))
        self.assertIsNone(variant_labels("Squirtle Pokemon Card"))
        self.assertIsNone(variant_labels("4.2 Lbs Pokemon All Holo + Reverse Holo"))
        self.assertIsNone(variant_labels("Japanese 1st Edition Holo Charizard"))
        self.assertIsNone(variant_labels("German Base Set 1st Edition Porygon"))
        self.assertIsNone(variant_labels("Sealed Pokemon Prerelease Deck"))
        self.assertIsNone(variant_labels("Cracked Ice Holo Charizard Non Holo Charmeleon Pokemon"))
        self.assertIsNone(variant_labels("Pokemon Indigo League Season 1 DVD"))
        self.assertIsNone(variant_labels("Pokemon Topps Johto League Octillery Foil"))
