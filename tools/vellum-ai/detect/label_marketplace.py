#!/usr/bin/env python3
"""Import human-reviewed marketplace annotations for YOLO retraining.

Each photo must have a sibling ``<photo>.json`` sidecar with pixel-space
``boxes`` and ``reviewed: true``. An empty boxes list is a reviewed negative.
Unreviewed model proposals are never training labels.

Usage (from tools/vellum-ai):
    python detect/label_marketplace.py
    python detect/label_marketplace.py --dry-run
    python detect/label_marketplace.py --retrain
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent
sys.path.insert(0, str(HERE.parent))

MARKETPLACE_DIR = REPO_ROOT / "data" / "detect-marketplace"
HARVEST_DIR = REPO_ROOT / "data" / "harvest"
_EXTS = {".jpg", ".jpeg", ".png"}


def _collect_images() -> list[Path]:
    return sorted(
        p for p in MARKETPLACE_DIR.rglob("*") if p.suffix.lower() in _EXTS
    )


def _read_reviewed_sidecar(image_path: Path) -> dict | None:
    sidecar = image_path.with_suffix(".json")
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if data.get("reviewed") is not True or not isinstance(data.get("boxes"), list):
        return None
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would happen without writing files")
    parser.add_argument("--retrain", action="store_true",
                        help="Run retrain.py after labeling (--min-new 1)")
    parser.add_argument("--epochs", type=int, default=30)
    args = parser.parse_args()

    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    images = _collect_images()
    print(f"Marketplace images found: {len(images)}")
    if not images:
        print(f"ERROR: No images in {MARKETPLACE_DIR}")
        return 1

    if not args.dry_run:
        HARVEST_DIR.mkdir(parents=True, exist_ok=True)

    # Find next free frame index in harvest dir
    existing = sorted(HARVEST_DIR.glob("frame_*.jpg")) if HARVEST_DIR.is_dir() else []
    counter = len(existing)

    written = skipped = unreviewed = 0
    source_counts: dict[str, int] = {}

    for img_path in images:
        bgr = cv2.imread(str(img_path))
        if bgr is None:
            skipped += 1
            continue

        annotation = _read_reviewed_sidecar(img_path)
        if annotation is None:
            unreviewed += 1
            skipped += 1
            continue

        boxes = annotation["boxes"]
        source = img_path.parts[img_path.parts.index("detect-marketplace") + 1]  # facebook/hibid
        source_counts[source] = source_counts.get(source, 0) + 1

        frame_stem = f"frame_{counter:06d}"
        dest_jpg = HARVEST_DIR / f"{frame_stem}.jpg"
        dest_json = HARVEST_DIR / f"{frame_stem}.json"

        if args.dry_run:
            print(f"  [dry] {img_path.name} -> {frame_stem} ({len(boxes)} cards, src={source})")
        else:
            # Re-encode as JPEG to normalise format
            ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
            if not ok:
                skipped += 1
                continue
            dest_jpg.write_bytes(buf.tobytes())
            meta = {
                "boxes": boxes,
                "source": source,
                "origin": str(img_path),
                "n_cards": len(boxes),
                "reviewed": True,
            }
            dest_json.write_text(json.dumps(meta), encoding="utf-8")

        counter += 1
        written += 1

    print(f"Imported reviewed: {written}  Unreviewed/missing: {unreviewed}  Unreadable: {skipped - unreviewed}")
    for src, n in sorted(source_counts.items()):
        print(f"  {src}: {n} images")

    if args.dry_run:
        return 0

    if written == 0:
        print("No reviewed harvest frames imported — add reviewed sidecars before retraining.")
        return 1

    if args.retrain:
        import subprocess
        cmd = [
            sys.executable,
            str(HERE / "retrain.py"),
            "--min-new", "1",
            "--epochs", str(args.epochs),
        ]
        print(f"\nRunning retrain: {' '.join(cmd)}")
        rc = subprocess.call(cmd)
        return rc

    print(f"\nNext step: python detect/retrain.py --min-new 1 --epochs 30")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
