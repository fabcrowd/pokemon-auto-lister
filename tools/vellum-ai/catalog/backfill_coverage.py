#!/usr/bin/env python3
"""Backfill missing catalog art + report coverage gaps vs TCGdex EN.

- Empty set shells on TCGdex (jumbo/rc/sp/wp) cannot be filled — API has 0 cards.
- Short trainer-kit / promo counts are TCGdex-incomplete (we already match set detail).
- Failed TCGdex CDN assets: retry via images.pokemontcg.io/{set}/{number}_hires.png
"""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CATALOG = ROOT / "data" / "card-catalog"
EMPTY_SET_SHELLS = ("jumbo", "rc", "sp", "wp")


def _fetch_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "vellum-ai-catalog/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download(url: str, dest: Path, timeout: float = 30) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "vellum-ai-catalog/0.1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        if not data or len(data) < 100:
            return False
        dest.write_bytes(data)
        return True
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return False


def _pokemontcg_url(row: dict) -> Optional[str]:
    set_code = row.get("setCode")
    number = row.get("number")
    if not set_code or not number:
        return None
    # strip leading zeros variants: try as-is first
    num = str(number).lstrip("0") or "0"
    # Pocket / weird ids rarely exist on pokemontcg.io
    if str(set_code).startswith(("P-", "B")) and "-" in str(row.get("id") or ""):
        # still try simple forms
        pass
    return f"https://images.pokemontcg.io/{set_code}/{number}_hires.png"


def backfill_images(catalog: Path, workers: int = 8) -> dict:
    meta_path = catalog / "meta.full.json"
    if not meta_path.is_file():
        meta_path = catalog / "meta.json"
    rows = json.loads(meta_path.read_text(encoding="utf-8"))
    images_dir = catalog / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    missing = []
    for row in rows:
        cid = row.get("id")
        if not cid:
            continue
        dest = images_dir / f"{cid}.webp"
        # also accept png fallbacks saved as .webp or .png
        dest_png = images_dir / f"{cid}.png"
        if (dest.is_file() and dest.stat().st_size > 0) or (
            dest_png.is_file() and dest_png.stat().st_size > 0
        ):
            continue
        if row.get("imageUrl") or _pokemontcg_url(row):
            missing.append(row)

    print(f"Retrying {len(missing)} cards without local art…")

    def one(row: dict) -> tuple[str, str]:
        cid = str(row["id"])
        dest_webp = images_dir / f"{cid}.webp"
        dest_png = images_dir / f"{cid}.png"
        urls = []
        if row.get("imageUrl"):
            urls.append(str(row["imageUrl"]))
            urls.append(str(row["imageUrl"]).replace("/high.webp", ".webp"))
            urls.append(str(row["imageUrl"]).replace("/high.webp", "/high.png"))
        ptcg = _pokemontcg_url(row)
        if ptcg:
            urls.append(ptcg)
            # zero-stripped number variant
            set_code = row.get("setCode")
            number = str(row.get("number") or "").lstrip("0") or "0"
            if set_code:
                urls.append(f"https://images.pokemontcg.io/{set_code}/{number}_hires.png")

        for url in urls:
            if url.endswith(".png") or "pokemontcg.io" in url:
                if _download(url, dest_png):
                    return cid, "ok-png"
            else:
                if _download(url, dest_webp):
                    return cid, "ok-webp"
        return cid, "fail"

    ok = fail = 0
    failed_ids: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(one, row) for row in missing]
        for i, fut in enumerate(as_completed(futs), 1):
            cid, status = fut.result()
            if status.startswith("ok"):
                ok += 1
            else:
                fail += 1
                failed_ids.append(cid)
            if i % 20 == 0 or i == len(futs):
                print(f"  {i}/{len(futs)} ok={ok} fail={fail}")

    report = {
        "retried": len(missing),
        "recovered": ok,
        "still_missing": fail,
        "still_missing_ids": failed_ids,
        "empty_set_shells": list(EMPTY_SET_SHELLS),
        "note": (
            "jumbo/rc/sp/wp are empty shells on TCGdex (0 card objects). "
            "Remaining missing art is mostly TCG Pocket / unpublished CDN assets."
        ),
    }
    (catalog / "coverage-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("retried", "recovered", "still_missing")}, indent=2))
    return report


def audit_empty_sets() -> None:
    sets = _fetch_json("https://api.tcgdex.net/v2/en/sets")
    print("Empty / unfilled set shells:")
    for s in sets:
        sid = s.get("id")
        if sid not in EMPTY_SET_SHELLS:
            continue
        detail = _fetch_json(f"https://api.tcgdex.net/v2/en/sets/{sid}")
        n = len(detail.get("cards") or [])
        print(f"  {sid} ({s.get('name')}): cards={n} listed_total={(s.get('cardCount') or {}).get('total')}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    audit_empty_sets()
    if args.audit_only:
        return
    backfill_images(args.catalog, workers=args.workers)


if __name__ == "__main__":
    main()
