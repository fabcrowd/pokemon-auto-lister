"""Checkpoint choice never sees the listings the report is scored on."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.variant_train import is_holdout, split_rows  # noqa: E402


class SplitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = [
            {"listing": str(270000000 + n), "file": f"{n}_{photo}.jpg"}
            for n in range(400)
            for photo in range(2)
        ]

    def test_a_listing_is_in_exactly_one_split(self) -> None:
        train, val, holdout = split_rows(self.rows, {})
        listings = [{row["listing"] for row in part} for part in (train, val, holdout)]
        self.assertFalse(listings[0] & listings[1])
        self.assertFalse(listings[0] & listings[2])
        self.assertFalse(listings[1] & listings[2])
        self.assertEqual(len(train) + len(val) + len(holdout), len(self.rows))

    def test_validation_comes_from_training_listings(self) -> None:
        _, val, holdout = split_rows(self.rows, {})
        self.assertTrue(val)
        self.assertTrue(all(not is_holdout(row["listing"]) for row in val))
        self.assertTrue(all(is_holdout(row["listing"]) for row in holdout))

    def test_split_does_not_depend_on_row_order(self) -> None:
        forward = [{row["listing"] for row in part} for part in split_rows(self.rows, {})]
        backward = [{row["listing"] for row in part} for part in split_rows(self.rows[::-1], {})]
        self.assertEqual(forward, backward)


if __name__ == "__main__":
    unittest.main()
