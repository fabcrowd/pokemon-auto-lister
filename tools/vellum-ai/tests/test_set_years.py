"""Set release years used to reject wrong-era reprints when resolving slab labels."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from catalog.set_years import year_of  # noqa: E402


class YearOfTests(unittest.TestCase):
    def test_reads_year_from_release_date(self):
        self.assertEqual(year_of({"id": "lc", "releaseDate": "2002-05-24"}), 2002)

    def test_missing_or_malformed_date_is_none(self):
        self.assertIsNone(year_of({"id": "x"}))
        self.assertIsNone(year_of({"id": "x", "releaseDate": "soon"}))


if __name__ == "__main__":
    unittest.main()
