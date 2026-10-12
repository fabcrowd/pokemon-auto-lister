"""OCR'd card names → every physical catalog print with that name (CLIP-independent candidates)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.name_candidates import NameIndex  # noqa: E402

META = [
    {"id": "me02-025", "name": "Mamoswine", "setCode": "me02", "number": "025"},
    {"id": "dp6-9", "name": "Mamoswine", "setCode": "dp6", "number": "9"},
    {"id": "base1-43", "name": "Abra", "setCode": "base1", "number": "43"},
    {"id": "base1-32", "name": "Kadabra", "setCode": "base1", "number": "32"},
    {"id": "sv01-001", "name": "Pineco", "setCode": "sv01", "number": "001"},
    {"id": "A1-100", "name": "Mamoswine", "setCode": "A1", "number": "100"},
    {"id": "swsh5-109", "name": "Corviknight V", "setCode": "swsh5", "number": "109"},
    {"id": "sm7.5-77", "name": "Switch Raft", "setCode": "sm7.5", "number": "77"},
]


class NameIndexTests(unittest.TestCase):
    def setUp(self):
        self.index = NameIndex(META)

    def ids(self, lines):
        return sorted(h["id"] for h in self.index.candidates(lines))

    def test_name_with_hp_on_the_same_line_finds_all_physical_prints(self):
        self.assertEqual(self.ids(["Mamoswine 180"]), ["dp6-9", "me02-025"])

    def test_longest_name_wins_over_a_contained_shorter_name(self):
        self.assertEqual(self.ids(["STAGE1 Kadabra 60HP"]), ["base1-32"])

    def test_ocr_typo_still_matches_close_name(self):
        self.assertEqual(self.ids(["Mamoswlne"]), ["dp6-9", "me02-025"])

    def test_multiword_and_suffixed_names(self):
        self.assertEqual(self.ids(["Corviknight V 210"]), ["swsh5-109"])
        self.assertEqual(self.ids(["TRAINER", "Switch Raft", "Item"]), ["sm7.5-77"])

    def test_noise_lines_match_nothing(self):
        self.assertEqual(self.ids(["BASIC", "HP 60", "Weakness", "x2"]), [])
        self.assertEqual(self.ids([]), [])


if __name__ == "__main__":
    unittest.main()
