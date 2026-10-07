"""Unit tests for HP-anchor / trainer name OCR finders (stdlib unittest)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.ocr_names import find_card_name, find_pokemon_name, find_trainer_name  # noqa: E402


class OcrNameTests(unittest.TestCase):
    def test_find_pokemon_above_hp(self) -> None:
        lines = ["BASIC", "Pikachu", "HP 60", "Thunder Shock", "This attack does 30 damage"]
        self.assertEqual(find_pokemon_name(lines), "Pikachu")

    def test_find_pokemon_inline_hp(self) -> None:
        lines = ["Lotad HP 40", "Water Gun"]
        self.assertEqual(find_pokemon_name(lines), "Lotad")

    def test_reject_attack_name_without_hp(self) -> None:
        # No HP line: attack body on next line should reject the attack title
        lines = ["Thunder Shock", "This attack does 30 damage to your opponent"]
        self.assertIsNone(find_pokemon_name(lines))

    def test_find_trainer_above_type(self) -> None:
        lines = ["Professor's Research", "Supporter", "Discard your hand"]
        self.assertEqual(find_trainer_name(lines), "Professor's Research")

    def test_find_card_name_prefers_pokemon(self) -> None:
        lines = ["BASIC", "Charizard", "HP 120"]
        self.assertEqual(find_card_name(lines), "Charizard")

    def test_find_card_name_falls_back_to_trainer(self) -> None:
        lines = ["Boss's Orders (Ghetsis)", "Supporter"]
        self.assertEqual(find_card_name(lines), "Boss's Orders")


if __name__ == "__main__":
    unittest.main()
