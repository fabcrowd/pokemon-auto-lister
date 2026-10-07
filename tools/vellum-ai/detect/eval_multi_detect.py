#!/usr/bin/env python3
"""Evaluate multi-card recall on a labeled image set.

Loads images from data_root/images/<split>/ and YOLO labels from
data_root/labels/<split>/, runs detect_all_cards_with_crops on each,
matches detected boxes to ground-truth boxes via IoU >= iou_threshold,
and reports per-count-group recall and overall recall.

Exit code 1 if overall recall < --min-recall (default 0.90).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
TOOLS_ROOT = HERE.parent
sys.path.insert(0, str(TOOLS_ROOT))

from vellum_ai.detect_multi import detect_all_cards_with_crops  # noqa: E402


def _box_iou(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = max(0.0, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(0.0, (bx2 - bx1) * (by2 - by1))
    union = area_a + area_b - inter
    return inter / (union + 1e-6)


def _load_gt_boxes(
    lbl_path: Path, img_w: int, img_h: int
) -> List[Tuple[float, float, float, float]]:
    """Read YOLO labels and convert to pixel (x1,y1,x2,y2) boxes."""
    boxes = []
    if not lbl_path.is_file():
        return boxes
    for line in lbl_path.read_text(encoding="utf-8").splitlines():
        parts = line.strip().split()
        if len(parts) != 5:
            continue
        _, xc, yc, bw, bh = (float(p) for p in parts)
        x1 = (xc - bw / 2) * img_w
        y1 = (yc - bh / 2) * img_h
        x2 = (xc + bw / 2) * img_w
        y2 = (yc + bh / 2) * img_h
        boxes.append((x1, y1, x2, y2))
    return boxes


def evaluate(
    data_root: Path,
    split: str = "val",
    iou_threshold: float = 0.5,
    verbose: bool = False,
) -> Dict:
    """Run detection on every image in split, compute recall metrics.

    Returns dict with keys: overall_recall, total_gt, total_tp, total_fn,
    per_count (dict n_cards → {tp, fn, recall}).
    """
    img_dir = data_root / "images" / split
    lbl_dir = data_root / "labels" / split

    if not img_dir.is_dir():
        raise SystemExit(f"Image dir not found: {img_dir}")

    paths = sorted(img_dir.glob("*.jpg")) + sorted(img_dir.glob("*.png"))
    if not paths:
        raise SystemExit(f"No images in {img_dir}")

    total_gt = 0
    total_tp = 0
    per_count: Dict[int, Dict[str, int]] = {}

    for img_path in paths:
        image = cv2.imread(str(img_path))
        if image is None:
            continue
        h, w = image.shape[:2]
        lbl_path = lbl_dir / f"{img_path.stem}.txt"
        gt_boxes = _load_gt_boxes(lbl_path, w, h)
        n_gt = len(gt_boxes)
        if n_gt == 0:
            continue

        detections = detect_all_cards_with_crops(image)
        det_boxes = [tuple(d["box"]) for d in detections]

        # Greedy match GT → det by max IoU
        matched_det = set()
        tp = 0
        for gt in gt_boxes:
            best_iou = 0.0
            best_j = -1
            for j, det in enumerate(det_boxes):
                if j in matched_det:
                    continue
                iou = _box_iou(gt, det)
                if iou > best_iou:
                    best_iou = iou
                    best_j = j
            if best_j >= 0 and best_iou >= iou_threshold:
                tp += 1
                matched_det.add(best_j)

        fn = n_gt - tp
        total_gt += n_gt
        total_tp += tp

        bucket = per_count.setdefault(n_gt, {"tp": 0, "fn": 0})
        bucket["tp"] += tp
        bucket["fn"] += fn

        if verbose:
            recall_img = tp / n_gt if n_gt else 1.0
            status = "OK" if recall_img >= 1.0 else "MISS"
            print(f"  [{status}] {img_path.name}: gt={n_gt} det={len(det_boxes)} tp={tp}")

    overall_recall = total_tp / total_gt if total_gt else 0.0
    per_count_summary = {}
    for n, bucket in sorted(per_count.items()):
        n_total = bucket["tp"] + bucket["fn"]
        per_count_summary[n] = {
            "tp": bucket["tp"],
            "fn": bucket["fn"],
            "recall": bucket["tp"] / n_total if n_total else 0.0,
            "images": n_total // n if n else 0,
        }

    return {
        "overall_recall": overall_recall,
        "total_gt": total_gt,
        "total_tp": total_tp,
        "total_fn": total_gt - total_tp,
        "per_count": per_count_summary,
    }


def print_report(results: Dict, min_recall: float) -> None:
    print(f"\n{'─'*52}")
    print(f"  Multi-card detection recall report")
    print(f"{'─'*52}")
    print(f"  GT boxes : {results['total_gt']}")
    print(f"  TP       : {results['total_tp']}")
    print(f"  FN       : {results['total_fn']}")
    print(f"  Recall   : {results['overall_recall']:.3f}  (gate >= {min_recall:.2f})")
    print(f"{'─'*52}")
    print(f"  {'cards':>5}  {'images':>6}  {'TP':>5}  {'FN':>5}  {'recall':>7}")
    for n, s in results["per_count"].items():
        print(
            f"  {n:>5}  {s['images']:>6}  {s['tp']:>5}  {s['fn']:>5}  {s['recall']:>7.3f}"
        )
    print(f"{'─'*52}")
    status = "PASSED" if results["overall_recall"] >= min_recall else "FAILED"
    print(f"  Gate: {status}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data",
        type=Path,
        default=HERE.parent.parent.parent / "data" / "vellum-detect-multi",
    )
    parser.add_argument("--split", default="val")
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    parser.add_argument("--min-recall", type=float, default=0.90)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    results = evaluate(
        data_root=args.data,
        split=args.split,
        iou_threshold=args.iou_threshold,
        verbose=args.verbose,
    )
    print_report(results, args.min_recall)
    if results["overall_recall"] < args.min_recall:
        sys.exit(1)


if __name__ == "__main__":
    main()
