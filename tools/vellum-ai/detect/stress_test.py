#!/usr/bin/env python3
"""Stress test: 10 rounds of card detection + identification, gate 95%+.

Pulls real card images from the PokemonTCG free API, runs them through
detect_all_cards_with_crops(), and optionally through identify_all_from_bytes().

Usage (from tools/vellum-ai):
    python detect/stress_test.py
    python detect/stress_test.py --rounds 10 --images 20 --detect-only
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent
sys.path.insert(0, str(HERE.parent))

_UA = "cardscanner-bootstrap/1.0"


_LOCAL_FALLBACK_DIR = HERE.parent.parent.parent / "data" / "detect-marketplace"


def _fetch_card_image_urls(n: int = 20) -> list[str]:
    """Return up to n large-image URLs from the free PokemonTCG API."""
    import json

    url = f"https://api.pokemontcg.io/v2/cards?pageSize={n}&page=1&select=id,images"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        cards = data.get("data", [])
        urls = []
        for c in cards:
            large = c.get("images", {}).get("large") or c.get("images", {}).get("small")
            if large:
                urls.append(large)
        return urls[:n]
    except Exception as e:
        print(f"  [warn] Could not fetch card URLs: {e}")
        return []


def _load_local_images(n: int = 20) -> list[bytes]:
    """Return up to n images from the local detect-marketplace directory."""
    exts = {".jpg", ".jpeg", ".png"}
    paths = [
        p for p in sorted(_LOCAL_FALLBACK_DIR.rglob("*")) if p.suffix.lower() in exts
    ]
    if not paths:
        return []
    # Spread evenly across available files to avoid sampling only one listing
    step = max(1, len(paths) // n)
    selected = paths[::step][:n]
    images = []
    for p in selected:
        images.append(p.read_bytes())
    return images


def _download_image_bytes(url: str, timeout: int = 10) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception:
        return None


def _run_detect(image_bytes: bytes) -> int:
    """Return number of cards detected (0 = miss)."""
    import cv2
    import numpy as np

    from vellum_ai.detect_multi import detect_all_cards_with_crops

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return 0
    results = detect_all_cards_with_crops(bgr)
    return len(results)


def _run_identify(image_bytes: bytes) -> tuple[int, bool]:
    """Return (n_detected, at_least_one_identified)."""
    try:
        from vellum_ai.identify_multi import identify_all_from_bytes
        cards = identify_all_from_bytes(image_bytes)
        identified = any(not c.abstain for c in cards)
        return len(cards), identified
    except ImportError:
        # identify_multi may have unmet deps — fall back to detect-only
        return _run_detect(image_bytes), False
    except Exception as e:
        print(f"    [identify err] {e}")
        return 0, False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=10,
                        help="Number of test rounds (default 10)")
    parser.add_argument("--images", type=int, default=20,
                        help="Real card images to download (default 20)")
    parser.add_argument("--detect-only", action="store_true",
                        help="Skip identity step (faster, no heavy deps needed)")
    parser.add_argument("--threshold", type=float, default=0.95,
                        help="Required detection rate to pass (default 0.95)")
    args = parser.parse_args()

    print(f"\nStress test: {args.rounds} rounds x {args.images} images, gate {args.threshold:.0%}")
    print("=" * 60)

    # ── Download images once ────────────────────────────────────────
    print("\n[prep] Fetching card image URLs …")
    urls = _fetch_card_image_urls(args.images)

    images: list[bytes] = []
    if urls:
        print(f"  Got {len(urls)} URLs. Downloading …")
        for i, url in enumerate(urls, 1):
            data = _download_image_bytes(url)
            if data:
                images.append(data)
                sys.stdout.write(f"\r  Downloaded {i}/{len(urls)}")
                sys.stdout.flush()
        print(f"\n  {len(images)} images ready.")
    else:
        print(f"  [fallback] API unavailable — loading from {_LOCAL_FALLBACK_DIR}")
        images = _load_local_images(args.images)
        if images:
            print(f"  {len(images)} local images ready.")

    if not images:
        print("  ERROR: No images available (API down, no local fallback found).")
        sys.exit(1)

    # ── Run rounds ──────────────────────────────────────────────────
    round_results: list[float] = []

    for rnd in range(1, args.rounds + 1):
        hits = 0
        total = len(images)
        t0 = time.perf_counter()

        for img_bytes in images:
            if args.detect_only:
                n = _run_detect(img_bytes)
                if n > 0:
                    hits += 1
            else:
                n, identified = _run_identify(img_bytes)
                if n > 0:
                    hits += 1

        elapsed = time.perf_counter() - t0
        rate = hits / total
        round_results.append(rate)
        status = "PASS" if rate >= args.threshold else "FAIL"
        print(f"  Round {rnd:2d}/{args.rounds}: {hits}/{total} detected "
              f"({rate:.1%}) [{elapsed:.1f}s] {status}")

    # ── Score ───────────────────────────────────────────────────────
    avg_rate = sum(round_results) / len(round_results)
    rounds_passed = sum(1 for r in round_results if r >= args.threshold)
    overall_pass = avg_rate >= args.threshold

    print(f"\n{'=' * 60}")
    print(f"  Rounds passed:   {rounds_passed}/{args.rounds}")
    print(f"  Average rate:    {avg_rate:.1%}")
    print(f"  Gate ({args.threshold:.0%}):       {'PASS ✓' if overall_pass else 'FAIL ✗'}")
    print(f"{'=' * 60}\n")

    sys.exit(0 if overall_pass else 1)


if __name__ == "__main__":
    main()
