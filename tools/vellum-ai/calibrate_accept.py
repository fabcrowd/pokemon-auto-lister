#!/usr/bin/env python3
"""
Calibrate VellumAI accept margin on a labeled holdout folder.

Holdout layout:
  data/vellum-holdout/
    <id>.jpg
    labels.json   # { "<id>.jpg": { "setCode": "...", "number": "..." }, ... }

Prints precision@accept and suggests a margin. Gate: precision >= 0.98 before enabling auto-draft.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from vellum_ai.pipeline import identify_image_bytes


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--holdout", type=Path, default=Path("data/vellum-holdout"))
    parser.add_argument("--min-precision", type=float, default=0.98)
    args = parser.parse_args()
    labels_path = args.holdout / "labels.json"
    if not labels_path.is_file():
        raise SystemExit(f"Missing {labels_path}")
    labels = json.loads(labels_path.read_text(encoding="utf-8"))

    accepted = 0
    correct = 0
    total = 0
    for name, truth in labels.items():
        path = args.holdout / name
        if not path.is_file():
            continue
        total += 1
        result = identify_image_bytes(path.read_bytes())
        if result.get("abstain"):
            continue
        accepted += 1
        ident = result.get("identity") or {}
        if str(ident.get("number")) == str(truth.get("number")) and (
            not truth.get("setCode")
            or str(ident.get("setCode")).lower() == str(truth.get("setCode")).lower()
        ):
            correct += 1

    precision = (correct / accepted) if accepted else 0.0
    coverage = (accepted / total) if total else 0.0
    print(f"holdout={total} accepted={accepted} correct={correct}")
    print(f"precision@accept={precision:.4f} coverage={coverage:.4f}")
    if precision < args.min_precision:
        print("GATE FAILED — do not enable VELLUM_AI auto-draft yet")
        raise SystemExit(1)
    print("GATE PASSED")


if __name__ == "__main__":
    main()
