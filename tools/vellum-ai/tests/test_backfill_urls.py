"""pokemontcg.io URL candidates for catalog cards TCGdex has no art for."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "catalog"))

from backfill_coverage import pokemontcg_urls  # noqa: E402

BASE = "https://images.pokemontcg.io"


class PokemonTcgUrlTests(unittest.TestCase):
    def test_half_sets_drop_the_dot_or_use_pt(self):
        self.assertIn(f"{BASE}/sm75/77_hires.png", pokemontcg_urls({"setCode": "sm7.5", "number": "77"}))
        self.assertIn(f"{BASE}/swsh12pt5gg/GG01_hires.png", pokemontcg_urls({"setCode": "swsh12.5gg", "number": "GG01"}))
        self.assertIn(f"{BASE}/sv3pt5/1_hires.png", pokemontcg_urls({"setCode": "sv03.5", "number": "001"}))

    def test_prefixed_numbers_also_try_without_zero_padding(self):
        urls = pokemontcg_urls({"setCode": "swsh4.5sv", "number": "SV001"})
        self.assertIn(f"{BASE}/swsh45sv/SV1_hires.png", urls)
        self.assertIn(f"{BASE}/swsh45sv/SV001_hires.png", urls)

    def test_no_duplicates_and_empty_for_missing_fields(self):
        urls = pokemontcg_urls({"setCode": "svp", "number": "027"})
        self.assertEqual(len(urls), len(set(urls)))
        self.assertIn(f"{BASE}/svp/27_hires.png", urls)
        self.assertEqual(pokemontcg_urls({"setCode": "svp"}), [])


if __name__ == "__main__":
    unittest.main()
