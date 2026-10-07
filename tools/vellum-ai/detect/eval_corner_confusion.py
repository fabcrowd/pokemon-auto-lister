#!/usr/bin/env python3
"""Gate: corners must not be predicted as full_card on a labeled val set."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
DEFAULT_DATA = ROOT / "data" / "vellum-detect"

CLASS_FULL = 0
CLASS_CORNER = 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--split", default="val")
    parser.add_argument("--max-corner-as-front-rate", type=float, default=0.15)
    args = parser.parse_args()

    from vellum_ai.detect import CLASS_FULL_CARD, detect_card

    img_dir = args.data / "images" / args.split
    lbl_dir = args.data / "labels" / args.split
    if not img_dir.is_dir():
        raise SystemExit(f"Missing {img_dir}")

    corner_total = 0
    corner_as_front = 0
    full_total = 0
    full_missed = 0

    for lbl_path in sorted(lbl_dir.glob("*.txt")):
        parts = lbl_path.read_text(encoding="utf-8").strip().split()
        if len(parts) < 5:
            continue
        gt_cls = int(float(parts[0]))
        img_path = img_dir / f"{lbl_path.stem}.jpg"
        if not img_path.is_file():
            continue
        bgr = cv2.imread(str(img_path))
        if bgr is None:
            continue
        hit = detect_card(bgr, prefer_full_card=False)
        pred = hit["class_id"] if hit else None

        if gt_cls == CLASS_CORNER:
            corner_total += 1
            if pred == CLASS_FULL_CARD:
                corner_as_front += 1
                print(f"  FAIL corner→full: {img_path.name} pred={pred} conf={hit and hit.get('confidence')}")
        elif gt_cls == CLASS_FULL:
            full_total += 1
            if pred != CLASS_FULL_CARD:
                full_missed += 1

    rate = (corner_as_front / corner_total) if corner_total else 0.0
    print(
        f"corner_closeup={corner_total} labeled-as-full_card={corner_as_front} "
        f"rate={rate:.3f} (max {args.max_corner_as_front_rate})"
    )
    print(f"full_card={full_total} missed_or_other={full_missed}")
    if corner_total == 0:
        raise SystemExit("No corner_closeup labels in val — bootstrap more corners first")
    if rate > args.max_corner_as_front_rate:
        raise SystemExit(1)
    print("Corner!=front gate PASSED")


if __name__ == "__main__":
    main()
