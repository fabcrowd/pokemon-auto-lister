#!/usr/bin/env python3
"""Stress-test multi-card detection by repeatedly generating synthetic images
and evaluating recall — no manual intervention needed.

Workflow each round:
  1. Generate `--count` synthetic multi-card images (val split).
  2. Run detect_all_cards_with_crops on every image.
  3. Print a recall table.
  4. Repeat for `--rounds` rounds using a different seed each time.

Exits with code 0 when recall >= `--target-recall` for `--stable-rounds`
consecutive rounds, or with code 1 when `--rounds` exhausted without reaching
the target.

Example:
  python stress_test_multi.py --rounds 10 --count 60 --target-recall 0.90
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
TOOLS_ROOT = HERE.parent
sys.path.insert(0, str(TOOLS_ROOT))
sys.path.insert(0, str(HERE))

from eval_multi_detect import evaluate, print_report  # noqa: E402
from synth_multi_card import generate as synth_generate  # noqa: E402

DEFAULT_DATA = HERE.parent.parent.parent / "data" / "vellum-detect-multi"
DEFAULT_SOURCE_DATA = HERE.parent.parent.parent / "data" / "vellum-detect"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--source-data", type=Path, default=DEFAULT_SOURCE_DATA)
    parser.add_argument("--rounds", type=int, default=8, help="Max evaluation rounds")
    parser.add_argument("--count", type=int, default=60, help="Images per round")
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--min-cards", type=int, default=2)
    parser.add_argument("--max-cards", type=int, default=5)
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    parser.add_argument("--target-recall", type=float, default=0.90)
    parser.add_argument(
        "--stable-rounds",
        type=int,
        default=3,
        help="Consecutive rounds at target needed to declare success",
    )
    parser.add_argument(
        "--catalog-images",
        type=Path,
        default=HERE.parent.parent.parent / "data" / "card-catalog" / "images",
    )
    parser.add_argument("--catalog-art-limit", type=int, default=80)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    print(f"\n{'='*60}")
    print(f"  Multi-card detection stress test")
    print(f"  Rounds: {args.rounds}  |  Images/round: {args.count}")
    print(f"  Target recall: {args.target_recall:.2f}  (stable for {args.stable_rounds} rounds)")
    print(f"{'='*60}\n")

    consecutive_ok = 0
    all_recalls = []

    for rnd in range(args.rounds):
        seed = 1000 + rnd * 7
        t0 = time.time()

        print(f"Round {rnd + 1}/{args.rounds}  (seed={seed})")
        print(f"  Generating {args.count} images ...")
        try:
            n_written = synth_generate(
                data_root=args.data,
                source_data=args.source_data,
                count=args.count,
                seed=seed,
                width=args.width,
                height=args.height,
                min_cards=args.min_cards,
                max_cards=args.max_cards,
                catalog_images=(
                    args.catalog_images if args.catalog_images.is_dir() else None
                ),
                catalog_art_limit=args.catalog_art_limit,
                split="val",
            )
            print(f"  Generated {n_written} images.")
        except SystemExit as exc:
            print(f"  [WARN] Synth generation skipped: {exc}")
            print(f"  (No source crops in {args.source_data} — using existing val set)")

        print(f"  Evaluating ...")
        try:
            results = evaluate(
                data_root=args.data,
                split="val",
                iou_threshold=args.iou_threshold,
                verbose=args.verbose,
            )
        except SystemExit as exc:
            print(f"  [ERROR] Evaluation failed: {exc}")
            break

        recall = results["overall_recall"]
        all_recalls.append(recall)
        elapsed = time.time() - t0

        print_report(results, args.target_recall)
        print(f"  Elapsed: {elapsed:.1f}s")

        if recall >= args.target_recall:
            consecutive_ok += 1
            print(f"  ✓ Recall target met ({consecutive_ok}/{args.stable_rounds} stable rounds)")
        else:
            consecutive_ok = 0
            print(f"  ✗ Recall below target  ({recall:.3f} < {args.target_recall:.2f})")

        if consecutive_ok >= args.stable_rounds:
            print(f"\n{'='*60}")
            print(f"  SUCCESS — recall >= {args.target_recall:.2f} for {args.stable_rounds} consecutive rounds")
            print(f"  Recalls: {[f'{r:.3f}' for r in all_recalls]}")
            print(f"{'='*60}\n")
            sys.exit(0)

    final_recall = all_recalls[-1] if all_recalls else 0.0
    print(f"\n{'='*60}")
    print(f"  DONE — {args.rounds} rounds completed")
    print(f"  Final recall: {final_recall:.3f}  (target: {args.target_recall:.2f})")
    print(f"  Recalls: {[f'{r:.3f}' for r in all_recalls]}")
    print(f"{'='*60}\n")

    if final_recall < args.target_recall:
        sys.exit(1)


if __name__ == "__main__":
    main()
