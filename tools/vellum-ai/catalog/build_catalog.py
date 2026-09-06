#!/usr/bin/env python3
"""Download English Pokemon TCG metadata (+ optional images) into data/card-catalog/."""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = ROOT / "data" / "card-catalog"


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "vellum-ai-catalog/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def from_tcgdex(out_dir: Path, download_images: bool, sleep_s: float) -> list[dict]:
    """Use TCGdex public API for EN cards."""
    base = "https://api.tcgdex.net/v2/en"
    sets = fetch_json(f"{base}/sets")
    rows: list[dict] = []
    images_dir = out_dir / "images"
    if download_images:
        images_dir.mkdir(parents=True, exist_ok=True)

    for s in sets:
        set_id = s.get("id")
        if not set_id:
            continue
        time.sleep(sleep_s)
        try:
            detail = fetch_json(f"{base}/sets/{set_id}")
        except Exception as exc:  # noqa: BLE001
            print(f"skip set {set_id}: {exc}")
            continue
        set_name = detail.get("name") or s.get("name")
        for card in detail.get("cards") or []:
            card_id = card.get("id")
            local_id = card.get("localId") or card.get("number")
            name = card.get("name")
            image_url = None
            if isinstance(card.get("image"), str):
                image_url = f"{card['image']}/high.webp"
            row = {
                "id": card_id,
                "name": name,
                "set": set_name,
                "setCode": set_id,
                "number": str(local_id) if local_id is not None else None,
                "game": "pokemon",
                "imageUrl": image_url,
            }
            rows.append(row)
            if download_images and image_url and card_id:
                dest = images_dir / f"{card_id}.webp"
                if not dest.is_file():
                    try:
                        time.sleep(sleep_s)
                        urllib.request.urlretrieve(image_url, dest)
                        row["imagePath"] = str(dest)
                    except Exception as exc:  # noqa: BLE001
                        print(f"image fail {card_id}: {exc}")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Build VellumAI card catalog metadata")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--download-images", action="store_true")
    parser.add_argument("--sleep", type=float, default=0.05)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    print("Fetching TCGdex EN catalog…")
    rows = from_tcgdex(args.out, args.download_images, args.sleep)
    meta_path = args.out / "meta.json"
    id_map = [str(r.get("id") or i) for i, r in enumerate(rows)]
    meta_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    (args.out / "id_map.json").write_text(json.dumps(id_map), encoding="utf-8")
    print(f"Wrote {len(rows)} cards -> {meta_path}")
    print("NOTE: Card art is TPC IP — keep data/card-catalog/ private; do not redistribute.")


if __name__ == "__main__":
    main()
