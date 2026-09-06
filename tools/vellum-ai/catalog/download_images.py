#!/usr/bin/env python3
"""Download catalog card art from meta.json imageUrl fields (skips existing)."""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CATALOG = ROOT / "data" / "card-catalog"


def _download_one(row: dict, images_dir: Path, timeout: float) -> tuple[str, str]:
    card_id = str(row.get("id") or "")
    url = row.get("imageUrl")
    if not card_id or not url:
        return card_id or "?", "skip"
    dest = images_dir / f"{card_id}.webp"
    if dest.is_file() and dest.stat().st_size > 0:
        return card_id, "exists"
    try:
        req = urllib.request.Request(str(url), headers={"User-Agent": "vellum-ai-catalog/0.1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        if not data:
            return card_id, "empty"
        dest.write_bytes(data)
        return card_id, "ok"
    except Exception as exc:  # noqa: BLE001
        return card_id, f"fail:{exc}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument(
        "--meta",
        type=Path,
        default=None,
        help="Meta JSON path (default: meta.full.json if present, else meta.json)",
    )
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--limit", type=int, default=0, help="Max downloads (0 = all missing)")
    parser.add_argument("--set-code", type=str, default="", help="Only this setCode (e.g. me03)")
    args = parser.parse_args()

    meta_path = args.meta
    if meta_path is None:
        full = args.catalog / "meta.full.json"
        meta_path = full if full.is_file() else args.catalog / "meta.json"
    if not meta_path.is_file():
        raise SystemExit(f"Missing {meta_path}")
    rows = json.loads(meta_path.read_text(encoding="utf-8"))
    print(f"Using meta {meta_path} ({len(rows)} rows)")
    if args.set_code:
        rows = [r for r in rows if str(r.get("setCode") or "") == args.set_code]
    images_dir = args.catalog / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    todo = []
    for row in rows:
        card_id = row.get("id")
        url = row.get("imageUrl")
        if not card_id or not url:
            continue
        dest = images_dir / f"{card_id}.webp"
        if dest.is_file() and dest.stat().st_size > 0:
            continue
        todo.append(row)
        if args.limit and len(todo) >= args.limit:
            break

    print(f"Downloading {len(todo)} images with {args.workers} workers…")
    ok = fail = exists = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(_download_one, row, images_dir, args.timeout) for row in todo]
        for i, fut in enumerate(as_completed(futures), 1):
            _cid, status = fut.result()
            if status == "ok":
                ok += 1
            elif status == "exists":
                exists += 1
            else:
                fail += 1
            if i % 200 == 0 or i == len(futures):
                elapsed = time.time() - t0
                print(f"  {i}/{len(futures)} ok={ok} fail={fail} elapsed={elapsed:.0f}s")
    print(f"Done. ok={ok} fail={fail} exists={exists} dir={images_dir}")


if __name__ == "__main__":
    main()
