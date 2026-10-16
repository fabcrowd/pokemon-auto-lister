"""Print how many ShopGoodwill hits a query has, and how many titles label."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.variant_labels import variant_labels  # noqa: E402
from vellum_ai.variant_photos import search_listings  # noqa: E402

if __name__ == "__main__":
    query = " ".join(sys.argv[1:]) or "pokemon 1st edition"
    labeled = 0
    total = 0
    for item_id, title in search_listings(query, pages=1):
        total += 1
        labels = variant_labels(title)
        if labels:
            labeled += 1
            print("YES", labels, title[:110])
        elif total <= 8:
            print("no ", title[:110])
    print(f"{labeled} labeled of {total}")
