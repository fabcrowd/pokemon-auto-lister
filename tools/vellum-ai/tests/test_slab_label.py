"""Unit tests for grading-slab label parsing and catalog resolution."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.slab_label import parse_label, resolve_label  # noqa: E402

META = [
    {"id": "base4-93", "name": "Squirtle", "set": "Base Set 2", "setCode": "base4", "number": "93"},
    {"id": "lc-95", "name": "Squirtle", "set": "Legendary Collection", "setCode": "lc", "number": "95"},
    {"id": "base1-63", "name": "Squirtle", "set": "Base Set", "setCode": "base1", "number": "63"},
    {"id": "me03-123", "name": "Rosa's Encouragement", "set": "Perfect Order", "setCode": "me03", "number": "123"},
    {"id": "lc-18", "name": "Venusaur", "set": "Legendary Collection", "setCode": "lc", "number": "18"},
    {"id": "base2-18", "name": "Dragonair", "set": "Base Set", "setCode": "base1", "number": "18"},
]


class ParseLabelTests(unittest.TestCase):
    def test_psa_label_with_squashed_ocr_tokens(self):
        p = parse_label(["2023POKEMONCLVEN", "#003", "VENUSAUR", "GEMMT", "10", "84291625"])
        self.assertEqual((p["year"], p["set_code"], p["number"], p["name"], p["grade"]),
                         ("2023", "CLV", "003", "Venusaur", "10"))

    def test_psa_label_with_spaced_tokens(self):
        p = parse_label(["2000 POKEMON GAME", "#93", "SQUIRTLE", "MINT", "BASEII", "9", "56325958"])
        self.assertEqual((p["number"], p["name"], p["grade"], p["set_code"]), ("93", "Squirtle", "9", "BASEII"))

    def test_multiword_name_and_variety_line(self):
        p = parse_label(["2026POKEMONPOREN", "#123", "ROSA'SENCOURAGEMENT", "GEMMT", "SPECIALILLUSTRATIONRARE", "10"])
        self.assertEqual((p["number"], p["set_code"]), ("123", "POR"))
        self.assertEqual(p["name_key"], "rosasencouragement")

    def test_lines_out_of_reading_order(self):
        # RapidOCR sorts by box top; the right-aligned "#123" can sit above the header line.
        p = parse_label(["#123", "2026POKEMONPOREN", "GEMMT", "ROSA'SENCOURAGEMENT", "10",
                         "SPECIALILLUSTRATIONRARE", "164302285", "PA"])
        self.assertEqual((p["number"], p["set_code"], p["name_key"], p["grade"], p["cert"]),
                         ("123", "POR", "rosasencouragement", "10", "164302285"))

    def test_non_label_text_returns_none(self):
        self.assertIsNone(parse_label(["Lot #", "295", "ART PANNEBECKER"]))
        self.assertIsNone(parse_label(["Fire Spin", "100"]))


class ResolveLabelTests(unittest.TestCase):
    def test_label_set_code_picks_the_right_reprint(self):
        p = parse_label(["2000 POKEMON GAME", "#93", "SQUIRTLE", "MINT", "BASEII", "9"])
        self.assertEqual(resolve_label(p, META)["productId"], "base4-93")

    def test_squashed_multiword_name_resolves(self):
        p = parse_label(["2026POKEMONPOREN", "#123", "ROSA'SENCOURAGEMENT", "GEMMT", "10"])
        self.assertEqual(resolve_label(p, META)["productId"], "me03-123")

    def test_garbled_name_still_resolves_by_known_set_and_number(self):
        p = parse_label(["2026POKEMONPOREN", "#123", "ROSASENCOURAGFMENT", "GEMMT", "10"])
        self.assertEqual(resolve_label(p, META)["productId"], "me03-123")

    def test_card_missing_from_catalog_gets_label_id_not_a_same_art_reprint(self):
        p = parse_label(["2023POKEMONCLVEN", "#003", "VENUSAUR", "GEMMT", "10"])
        ident = resolve_label(p, META)
        self.assertEqual(ident["productId"], "label:CLV-003")
        self.assertEqual(ident["name"], "Venusaur")
        self.assertEqual(ident["grade"], "10")
        self.assertEqual(ident["set"], "Trading Card Game Classic")


YEARS = {"base4": 2000, "lc": 2002, "dp3": 2007, "me03": 2026, "base1": 1999}
CHARIZARDS = [
    {"id": "lc-3", "name": "Charizard", "set": "Legendary Collection", "setCode": "lc", "number": "3"},
    {"id": "dp3-3", "name": "Charizard", "set": "Secret Wonders", "setCode": "dp3", "number": "3"},
]


class LabelYearTests(unittest.TestCase):
    def test_reprint_from_another_era_is_not_the_labelled_print(self):
        p = parse_label(["#003", "2023POKEMONCLCEN", "MINT", "CHARIZARD", "9", "84691332"])
        self.assertEqual(resolve_label(p, CHARIZARDS, YEARS)["productId"], "label:CLC-003")

    def test_single_name_number_match_from_wrong_year_is_rejected(self):
        p = parse_label(["2023POKEMONCLCEN", "#003", "CHARIZARD", "9"])
        self.assertEqual(resolve_label(p, CHARIZARDS[:1], YEARS)["productId"], "label:CLC-003")

    def test_adjacent_year_reprint_is_rejected(self):
        meta = [{"id": "swsh10.5-003", "name": "Venusaur", "set": "Pokémon GO", "setCode": "swsh10.5", "number": "003"}]
        p = parse_label(["2023POKEMONCLVEN", "#003", "VENUSAUR", "10"])
        self.assertEqual(resolve_label(p, meta, {"swsh10.5": 2022})["productId"], "label:CLV-003")

    def test_matching_year_still_resolves(self):
        p = parse_label(["2000 POKEMON GAME", "#93", "SQUIRTLE", "MINT", "BASEII", "9"])
        self.assertEqual(resolve_label(p, META, YEARS)["productId"], "base4-93")

    def test_digital_only_prints_never_match_a_slab(self):
        meta = [{"id": "A1-003", "name": "Venusaur", "set": "Genetic Apex", "setCode": "A1", "number": "003"}]
        p = parse_label(["2023POKEMONCLVEN", "#003", "VENUSAUR", "10"])
        self.assertEqual(resolve_label(p, meta)["productId"], "label:CLV-003")

    def test_unknown_code_and_year_mismatch_returns_none(self):
        meta = [{"id": "swsh10.5-003", "name": "Venusaur", "set": "Pokémon GO", "setCode": "swsh10.5", "number": "003"}]
        p = parse_label(["2023POKEMONZZZEN", "#003", "VENUSAUR", "10"])
        self.assertIsNone(resolve_label(p, meta, {"swsh10.5": 2022}))

    def test_classic_code_still_yields_a_label_id(self):
        p = parse_label(["2023POKEMONCLVEN", "#003", "VENUSAUR", "10"])
        self.assertEqual(resolve_label(p, [], {})["productId"], "label:CLV-003")


REAL_META = [
    {"id": "svp-078", "name": "Meowscarada ex", "set": "Scarlet & Violet Black Star Promos", "setCode": "svp", "number": "078"},
    {"id": "si1-4", "name": "Togepi", "set": "Southern Islands", "setCode": "si1", "number": "4"},
    {"id": "xy12-48", "name": "Haunter", "set": "Evolutions", "setCode": "xy12", "number": "48"},
    {"id": "gym2-19", "name": "Koga", "set": "Gym Challenge", "setCode": "gym2", "number": "19"},
    {"id": "sm115-18", "name": "Vaporeon", "set": "Hidden Fates", "setCode": "sm115", "number": "18"},
    {"id": "sm9-18", "name": "Vaporeon", "set": "Team Up", "setCode": "sm9", "number": "18"},
]
REAL_YEARS = {"svp": 2023, "si1": 2001, "xy12": 2016, "gym2": 2000, "sm115": 2019, "sm9": 2019}


class RealLabelTests(unittest.TestCase):
    def resolve(self, lines):
        return resolve_label(parse_label(lines), REAL_META, REAL_YEARS)["productId"]

    def test_promo_label_year_after_promo_set_start(self):
        self.assertEqual(self.resolve(["#078", "2024POKEMONSVPEN", "MINT", "MEOWSCARADAex", "PAFMEOWSCARADAeXPC", "9",
                                       "97155847", "PSA"]), "svp-078")

    def test_holo_and_reverse_foil_suffixes_are_not_part_of_the_name(self):
        self.assertEqual(self.resolve(["#4", "2001POKEMONSO.ISLANDS", "TOGEPI-HOLO", "NM-MT", "PROMO", "8"]), "si1-4")
        self.assertEqual(self.resolve(["#48", "2016POKEMONXY", "HAUNTER-REV.FOIL", "NM-MT", "EVOLUTIONS", "8"]), "xy12-48")

    def test_letter_o_misread_in_year(self):
        self.assertEqual(self.resolve(["200OPOKEMONGYMCHAL", "#19", "MINT", "KOGA-HOLO", "9", "PA", "98402659"]), "gym2-19")

    def test_set_name_line_picks_between_same_year_prints(self):
        self.assertEqual(self.resolve(["#18", "2019POKEMONSUN&MOON", "VAPOREON-HOLO", "GEMMT", "HIDDENFATES", "10"]),
                         "sm115-18")


if __name__ == "__main__":
    unittest.main()
