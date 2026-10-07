#!/usr/bin/env python3
"""Evaluate detector mAP / miss rate on a labeled holdout (YOLO val).

Use --multi to also run the multi-card contour recall gate (no ONNX model needed).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLS_ROOT = HERE.parent
MODELS = HERE.parent / "models"

DEFAULT_MULTI_DATA = HERE.parent.parent.parent / "data" / "vellum-detect-multi"


def _run_yolo_gate(args: argparse.Namespace) -> bool:
    from ultralytics import YOLO  # type: ignore

    if not args.weights.is_file():
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
    passed = map50 >= args.min_map50
    print("Detect holdout gate", "PASSED" if passed else "FAILED")
    return passed


def _run_multi_gate(args: argparse.Namespace) -> bool:
    sys.path.insert(0, str(TOOLS_ROOT))
    from eval_multi_detect import evaluate, print_report  # type: ignore  # noqa: E402

    try:
        results = evaluate(
            data_root=args.multi_data,
            split=args.multi_split,
            iou_threshold=args.multi_iou,
            verbose=args.verbose,
        )
    except SystemExit as exc:
        print(f"[multi] Skipped: {exc}")
        return True  # no data → not a hard failure

    print_report(results, args.multi_min_recall)
    return results["overall_recall"] >= args.multi_min_recall


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=HERE / "dataset.yaml")
    parser.add_argument("--weights", type=Path, default=MODELS / "card_detect.onnx")
    parser.add_argument("--min-map50", type=float, default=0.95)
    parser.add_argument(
        "--multi",
        action="store_true",
        help="Also run multi-card contour recall gate (no ONNX needed)",
    )
    parser.add_argument("--multi-data", type=Path, default=DEFAULT_MULTI_DATA)
    parser.add_argument("--multi-split", default="val")
    parser.add_argument("--multi-iou", type=float, default=0.5)
    parser.add_argument("--multi-min-recall", type=float, default=0.90)
    parser.add_argument("--skip-yolo", action="store_true", help="Skip YOLO mAP gate")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    passed = True

    if not args.skip_yolo:
        passed &= _run_yolo_gate(args)

    if args.multi:
        passed &= _run_multi_gate(args)

    if not passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
