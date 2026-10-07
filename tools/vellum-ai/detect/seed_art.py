#!/usr/bin/env python3
"""Download PokemonTCG card art for synthetic training bootstrap.

Fetches images from the free PokemonTCG API (no API key required).
Downloads approximately 250 images per page to data/catalog-images/.

Usage (from tools/vellum-ai):
    python detect/seed_art.py
    python detect/seed_art.py --pages 4 --out ../../data/catalog-images
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent.parent.parent / "data" / "catalog-images"
_API_BASE = "https://api.pokemontcg.io/v2/cards"
_UA = "cardscanner-bootstrap/1.0"


def _fetch_page(page: int, page_size: int = 250) -> list[dict]:
    url = f"{_API_BASE}?pageSize={page_size}&page={page}&select=id,images"
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode()).get("data", [])


def _download(url: str, dest: Path) -> bool:
    if dest.exists():
        return False
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            dest.write_bytes(resp.read())
        return True
    except Exception:
        return False


def seed(out_dir: Path, pages: int, page_size: int = 250, delay: float = 0.5) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for page in range(1, pages + 1):
        print(f"  Page {page}/{pages}...", end=" ", flush=True)
        try:
            cards = _fetch_page(page, page_size)
        except Exception as exc:
            print(f"SKIP ({exc})")
            continue
        if not cards:
            print("empty — done")
            break
        downloaded = 0
        for card in cards:
            card_id = card.get("id", "")
            images = card.get("images") or {}
            img_url = images.get("large") or images.get("small")
            if not img_url or not card_id:
                continue
            ext = img_url.rsplit(".", 1)[-1].split("?")[0].lower()
            if ext not in ("jpg", "jpeg", "png", "webp"):
                ext = "jpg"
            fname = card_id.replace("/", "_") + f".{ext}"
            if _download(img_url, out_dir / fname):
                downloaded += 1
        total += downloaded
        print(f"{len(cards)} cards, {downloaded} new → {total} total")
        if len(cards) < page_size:
            break
        time.sleep(delay)
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_OUT,
        help=f"Output directory (default: {DEFAULT_OUT})",
    )
    parser.add_argument(
        "--pages", type=int, default=8,
        help="API pages to fetch (250 cards/page, default 8 → ~2000 images)",
    )
    parser.add_argument(
        "--delay", type=float, default=0.5,
        help="Seconds between page requests (default 0.5)",
    )
    args = parser.parse_args()

    existing = list(args.out.glob("*.*")) if args.out.exists() else []
    print(f"Seeding card art -> {args.out} ({len(existing)} existing)")
    n = seed(args.out, args.pages, delay=args.delay)
    total = len(list(args.out.glob("*.*")))
    print(f"Done. {n} new images downloaded ({total} total) in {args.out}")


if __name__ == "__main__":
    main()
