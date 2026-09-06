#!/usr/bin/env python3
"""Evaluate detector mAP / miss rate on a labeled holdout (YOLO val)."""

from __future__ import annotations

import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = HERE.parent / "models"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=HERE / "dataset.yaml")
    parser.add_argument("--weights", type=Path, default=MODELS / "card_detect.onnx")
    parser.add_argument("--min-map50", type=float, default=0.95)
    args = parser.parse_args()

    from ultralytics import YOLO  # type: ignore

    if not args.weights.is_file():
        # fall back to best.pt
        pts = list(MODELS.rglob("best.pt"))
        if not pts:
            raise SystemExit(f"No weights at {args.weights}")
        weights = pts[0]
    else:
        weights = args.weights

    model = YOLO(str(weights))
    metrics = model.val(data=str(args.data))
    map50 = float(metrics.box.map50)
    print(f"mAP@50 = {map50:.4f} (gate >= {args.min_map50})")
    if map50 < args.min_map50:
        raise SystemExit(1)
    print("Detect holdout gate PASSED")


if __name__ == "__main__":
    main()
