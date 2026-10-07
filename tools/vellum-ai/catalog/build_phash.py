#!/usr/bin/env python3
"""Build data/card-catalog/phash.json from local images or imageUrl downloads.

Reads meta.json, computes qtran-style art-region pHash for each card, writes
a sidecar map {cardId: hexHash}. Skips rows that already have a phash.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CATALOG = ROOT / "data" / "card-catalog"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.phash import compute_phash  # noqa: E402


def _load_image_bytes(row: dict, images_dir: Path, timeout: float) -> bytes | None:
    card_id = str(row.get("id") or "")
    if not card_id:
        return None
    for ext in (".webp", ".png", ".jpg", ".jpeg"):
        local = images_dir / f"{card_id}{ext}"
        if local.is_file() and local.stat().st_size > 0:
            return local.read_bytes()
    url = row.get("imageUrl")
    if not url:
        return None
    try:
        req = urllib.request.Request(str(url), headers={"User-Agent": "vellum-ai-phash/0.1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        if data:
            images_dir.mkdir(parents=True, exist_ok=True)
            dest = images_dir / f"{card_id}.webp"
            if not dest.is_file():
                dest.write_bytes(data)
            return data
    except Exception:
        return None
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--limit", type=int, default=0, help="Optional cap for smoke runs")
    args = parser.parse_args()

    meta_path = args.catalog / "meta.json"
    if not meta_path.is_file():
        print(f"missing {meta_path}", file=sys.stderr)
        sys.exit(1)

    rows = json.loads(meta_path.read_text(encoding="utf-8"))
    if args.limit > 0:
        rows = rows[: args.limit]

    sidecar_path = args.catalog / "phash.json"
    existing: dict[str, str] = {}
    if sidecar_path.is_file():
        try:
            existing = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    images_dir = args.catalog / "images"
    todo = [r for r in rows if str(r.get("id") or "") and str(r.get("id")) not in existing]
    print(f"catalog={args.catalog} todo={len(todo)} existing={len(existing)}")

    done = 0
    failed = 0

    def work(row: dict) -> tuple[str, str | None]:
        cid = str(row.get("id"))
        data = _load_image_bytes(row, images_dir, args.timeout)
        if not data:
            return cid, None
        return cid, compute_phash(data)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(work, row) for row in todo]
        for fut in as_completed(futures):
            cid, ph = fut.result()
            if ph:
                existing[cid] = ph
                done += 1
            else:
                failed += 1
            if (done + failed) % 100 == 0:
                print(f"  progress done={done} fail={failed}")

    sidecar_path.write_text(json.dumps(existing, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"wrote {sidecar_path} entries={len(existing)} new={done} fail={failed}")


if __name__ == "__main__":
    main()
