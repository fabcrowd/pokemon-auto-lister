#!/usr/bin/env python3
"""Write data/card-catalog/set_years.json (setCode → release year) from TCGdex.

Slab labels print the release year; resolving a label against the catalog uses
it to reject same-name/number reprints from other eras.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_catalog import DEFAULT_OUT, fetch_json  # noqa: E402

BASE = "https://api.tcgdex.net/v2/en"
_DATE = re.compile(r"^((?:19|20)\d{2})-")


def year_of(set_detail: Dict[str, Any]) -> Optional[int]:
    match = _DATE.match(str(set_detail.get("releaseDate") or ""))
    return int(match.group(1)) if match else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--sleep", type=float, default=0.1)
    args = parser.parse_args()

    years: Dict[str, int] = {}
    missing = []
    for summary in fetch_json(f"{BASE}/sets"):
        year = year_of(fetch_json(f"{BASE}/sets/{summary['id']}"))
        if year is None:
            missing.append(summary["id"])
        else:
            years[summary["id"]] = year
        time.sleep(args.sleep)
    out = args.out / "set_years.json"
    out.write_text(json.dumps(years, indent=2, sort_keys=True), encoding="utf-8")
    print(f"wrote {len(years)} set years to {out}; no date for {len(missing)}: {missing[:20]}")


if __name__ == "__main__":
    main()
