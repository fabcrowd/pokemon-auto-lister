"""Collect real-photo variant crops, then stop. Training is variant_train.py."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.variant_photos import harvest_local, harvest_search  # noqa: E402


if __name__ == "__main__":
    print("local crops", harvest_local())
    print("search crops", harvest_search())
    print("older stamp crops", harvest_search(
        pages=4,
        queries=("pokemon staff", "staff promo pokemon", "pokemon prerelease", "black star league"),
        days_back="365",
    ))
