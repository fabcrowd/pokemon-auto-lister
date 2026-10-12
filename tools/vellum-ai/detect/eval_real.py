#!/usr/bin/env python3
"""Score the card detector on reviewed real photos (not synthetic val).

Reads every image under --data that has a sibling JSON sidecar with
``reviewed: true`` and pixel ``boxes``. ``boxes: []`` is a negative photo
(sealed product etc.) where any detection is a false positive.

Runs the shipped multi-card ONNX path (vellum_ai.detect_multi) so the score
reflects what the sidecar actually returns.

Usage (from tools/vellum-ai):
    python detect/eval_real.py
    python detect/eval_real.py --weights models/candidate.onnx --verbose
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent
DEFAULT_DATA = REPO_ROOT / "data" / "detect-real-eval"
DEFAULT_WEIGHTS = HERE.parent / "models" / "card_detect.onnx"
_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def in_ignore(box, ignore, min_frac: float = 0.5) -> bool:
    """True when most of ``box`` lies inside an ignore region (e.g. a cut-off card)."""
    area = max((box[2] - box[0]) * (box[3] - box[1]), 1e-6)
    for g in ignore or []:
        ix = max(0.0, min(box[2], g[2]) - max(box[0], g[0]))
        iy = max(0.0, min(box[3], g[3]) - max(box[1], g[1]))
        if ix * iy / area >= min_frac:
            return True
    return False


def match_boxes(preds, truths, iou_thr: float = 0.5, ignore=None) -> tuple[int, int, int]:
    """Greedy one-to-one matching by IoU. Returns (tp, fp, fn).

    Unmatched predictions inside an ``ignore`` region are neither TP nor FP."""
    pairs = sorted(
        ((iou(p, t), pi, ti) for pi, p in enumerate(preds) for ti, t in enumerate(truths)),
        reverse=True,
    )
    used_p: set[int] = set()
    used_t: set[int] = set()
    for score, pi, ti in pairs:
        if score < iou_thr:
            break
        if pi in used_p or ti in used_t:
            continue
        used_p.add(pi)
        used_t.add(ti)
    tp = len(used_t)
    fp = sum(1 for pi, p in enumerate(preds) if pi not in used_p and not in_ignore(p, ignore))
    return tp, fp, len(truths) - tp


def summarize(rows: list[dict]) -> dict:
    tp = sum(r["tp"] for r in rows)
    fp = sum(r["fp"] for r in rows)
    fn = sum(r["fn"] for r in rows)
    negatives = [r for r in rows if r["negative"]]
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "images": len(rows),
        "cards": tp + fn,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "negative_images": len(negatives),
        "negative_images_with_fp": sum(1 for r in negatives if r["fp"] > 0),
    }


def load_reviewed(data_dir: Path) -> list[tuple[Path, list, list]]:
    items = []
    for img in sorted(p for p in data_dir.rglob("*") if p.suffix.lower() in _EXTS):
        try:
            meta = json.loads(img.with_suffix(".json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if meta.get("reviewed") is True and isinstance(meta.get("boxes"), list):
            items.append((img, meta["boxes"], meta.get("ignore") or []))
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--iou", type=float, default=0.5)
    parser.add_argument(
        "--preprocess",
        choices=("stretch", "letterbox"),
        default="stretch",
        help="stretch = Python sidecar (detect_multi); letterbox = WASM extension (detect.js)",
    )
    parser.add_argument("--conf", type=float, default=None,
                        help="Override detect_multi._CONF_THRESHOLD (default: shipped value)")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--json", action="store_true", help="Print summary as JSON")
    args = parser.parse_args()

    import cv2  # type: ignore

    sys.path.insert(0, str(HERE.parent))
    import vellum_ai.detect_multi as detect_multi  # noqa: PLC0415
    from vellum_ai.detect_multi import _detect_onnx_multi, pad_to_square, unpad_box  # noqa: PLC0415

    if args.conf is not None:
        detect_multi._CONF_THRESHOLD = args.conf

    items = load_reviewed(args.data)
    if not items:
        print(f"No reviewed images under {args.data}")
        return 2

    rows = []
    for img_path, truths, ignore in items:
        bgr = cv2.imread(str(img_path))
        if bgr is None:
            continue
        if args.preprocess == "letterbox":
            square, pad_x, pad_y = pad_to_square(bgr)
            preds = [unpad_box(h["box"], pad_x, pad_y) for h in _detect_onnx_multi(square, args.weights)]
        else:
            preds = [list(h["box"]) for h in _detect_onnx_multi(bgr, args.weights)]
        tp, fp, fn = match_boxes(preds, truths, args.iou, ignore)
        rows.append({"tp": tp, "fp": fp, "fn": fn, "negative": not truths})
        if args.verbose:
            rel = img_path.relative_to(args.data)
            print(f"  {rel}: truth={len(truths)} pred={len(preds)} tp={tp} fp={fp} fn={fn}")

    s = summarize(rows)
    if args.json:
        print(json.dumps(s))
    else:
        print(
            f"images={s['images']} cards={s['cards']} tp={s['tp']} fp={s['fp']} fn={s['fn']}\n"
            f"precision={s['precision']:.3f} recall={s['recall']:.3f} f1={s['f1']:.3f}\n"
            f"negative images with any FP: {s['negative_images_with_fp']}/{s['negative_images']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
