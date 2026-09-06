#!/usr/bin/env python3
"""Cache Facebook + HiBid listing photos for multi-card detect eval.

Facebook + HiBid only (Mercari/queue ignored).

Reads:
  - data/sniper/state.json ledgers (worklist/seen/hearted/suspects)
  - detect/marketplace_cases.json
  - HiBid LotSearch (optional, --lotsearch) for live lot thumbnails

Writes JPEGs under data/detect-marketplace/{facebook|hibid}/<itemId>/
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLS_ROOT = HERE.parent
sys.path.insert(0, str(TOOLS_ROOT))

from vellum_ai.marketplace_eval import (  # noqa: E402
    DEFAULT_CACHE,
    DEFAULT_MANIFEST,
    DEFAULT_SNIPER_STATE,
    cases_by_source,
    fetch_hibid_lotsearch_cases,
    harvest_sniper_worklist,
    load_manifest_cases,
    materialize_cases,
    merge_cases,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--sniper-state", type=Path, default=DEFAULT_SNIPER_STATE)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--download", action="store_true", default=True)
    parser.add_argument("--no-download", dest="download", action="store_false")
    parser.add_argument(
        "--lotsearch",
        action="store_true",
        default=True,
        help="Seed HiBid photos from one public LotSearch page",
    )
    parser.add_argument("--no-lotsearch", dest="lotsearch", action="store_false")
    args = parser.parse_args()

    manifest_cases = load_manifest_cases(args.manifest)
    sniper_cases = []
    if args.sniper_state.is_file():
        state = json.loads(args.sniper_state.read_text(encoding="utf-8"))
        sniper_cases = harvest_sniper_worklist(state)
    hibid_live = fetch_hibid_lotsearch_cases() if args.lotsearch else []

    cases = merge_cases(sniper_cases, hibid_live, manifest_cases)
    ready = materialize_cases(cases, args.cache, download=args.download)
    grouped = cases_by_source(ready)

    fb = len(grouped["facebook"])
    hb = len(grouped["hibid"])
    photos = sum(len(c.get("local_paths") or []) for c in ready)
    print(f"Cached {photos} photos from {len(ready)} lots (facebook={fb} hibid={hb})")
    print(f"Cache dir: {args.cache}")
    if fb < 2:
        print("Facebook: need >=2 lots. Run a Facebook sniper cycle, then re-harvest.")
    if hb < 2:
        print("HiBid: need >=2 lots. Re-run with --lotsearch or a HiBid sniper cycle.")
    if fb < 2 or hb < 2:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
