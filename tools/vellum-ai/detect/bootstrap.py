#!/usr/bin/env python3
"""One-shot orchestrator: download art → synthetic data → train YOLO → eval.

Phases
------
  0  Check / install ultralytics
  1  Seed card art (skip if ≥500 images already present)
  2a  synth_bootstrap.py  (single-card synthetic data → images/train)
  2b  Move last ~15% of synth images from train → val split
  3  train_detect.py  → models/card_detect.onnx
  4  eval_detect.py   (mAP@50 ≥ 0.95 gate)

Usage (from tools/vellum-ai):
    python detect/bootstrap.py
    python detect/bootstrap.py --art-pages 4 --synth-count 400 --epochs 30
    python detect/bootstrap.py --skip-art --skip-synth  # jump straight to train
"""

from __future__ import annotations

import argparse
import random
import shutil
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent

CATALOG_IMAGES = REPO_ROOT / "data" / "catalog-images"
DATASET_YAML = HERE / "dataset.yaml"
VELLUM_DETECT = REPO_ROOT / "data" / "vellum-detect"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(cmd: list[str], *, check: bool = True) -> int:
    print("  $", " ".join(str(c) for c in cmd))
    rc = subprocess.call(cmd)
    if check and rc != 0:
        raise SystemExit(f"Command failed (exit {rc}): {cmd[0]}")
    return rc


def _phase(name: str) -> None:
    print(f"\n{'=' * 60}")
    print(f"  {name}")
    print(f"{'=' * 60}")


def _ensure_ultralytics() -> None:
    try:
        import ultralytics  # noqa: F401
        print("  ultralytics already installed.")
    except ImportError:
        print("  Installing ultralytics …")
        _run([sys.executable, "-m", "pip", "install", "ultralytics"])


def _create_val_split(data_root: Path, val_frac: float = 0.15, seed: int = 42) -> int:
    """Move a random fraction of synth images from train/ to val/.

    Only touches files named synth_*.jpg / synth_*.png to avoid moving
    real labeled crops that may already be in the training directory.
    Returns the number of files moved.
    """
    train_img = data_root / "images" / "train"
    val_img = data_root / "images" / "val"
    train_lbl = data_root / "labels" / "train"
    val_lbl = data_root / "labels" / "val"

    if not train_img.is_dir():
        return 0

    synth_imgs = sorted(
        p for p in train_img.iterdir()
        if p.stem.startswith("synth_") and p.suffix in (".jpg", ".png")
    )
    if not synth_imgs:
        print("  No synth_* images found in train/; skipping val split creation.")
        return 0

    rng = random.Random(seed)
    n_val = max(1, int(len(synth_imgs) * val_frac))
    rng.shuffle(synth_imgs)
    to_move = synth_imgs[:n_val]

    val_img.mkdir(parents=True, exist_ok=True)
    val_lbl.mkdir(parents=True, exist_ok=True)

    moved = 0
    for img_path in to_move:
        shutil.move(str(img_path), val_img / img_path.name)
        lbl_src = train_lbl / img_path.with_suffix(".txt").name
        if lbl_src.exists():
            shutil.move(str(lbl_src), val_lbl / lbl_src.name)
        moved += 1

    return moved


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--art-pages", type=int, default=8,
                        help="API pages of card art to download (250 cards/page, default 8)")
    parser.add_argument("--art-delay", type=float, default=0.5,
                        help="Seconds between art API pages (default 0.5)")
    parser.add_argument("--synth-count", type=int, default=600,
                        help="Single-card synthetic images to generate (default 600)")
    parser.add_argument("--catalog-art-limit", type=int, default=200,
                        help="Max catalog art images to sample per synth run (default 200)")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--skip-art", action="store_true", help="Skip Phase 1 (art download)")
    parser.add_argument("--skip-synth", action="store_true", help="Skip Phase 2 (synth generation)")
    parser.add_argument("--skip-train", action="store_true", help="Skip Phase 3 (training)")
    parser.add_argument("--skip-eval", action="store_true", help="Skip Phase 4 (eval gate)")
    args = parser.parse_args()

    # ── Phase 0: ultralytics ────────────────────────────────────────────────
    _phase("Phase 0: Ensure ultralytics")
    _ensure_ultralytics()

    # ── Phase 1: Seed card art ──────────────────────────────────────────────
    _phase("Phase 1: Seed card art")
    if args.skip_art:
        print("  Skipped (--skip-art).")
    else:
        existing = list(CATALOG_IMAGES.glob("*.*")) if CATALOG_IMAGES.exists() else []
        if len(existing) >= 500:
            print(f"  {len(existing)} images already in {CATALOG_IMAGES}; skipping download.")
        else:
            print(f"  {len(existing)} images found; downloading up to {args.art_pages * 250} more …")
            _run([
                sys.executable, str(HERE / "seed_art.py"),
                "--out", str(CATALOG_IMAGES),
                "--pages", str(args.art_pages),
                "--delay", str(args.art_delay),
            ])

    # ── Phase 2: Synthetic data generation ─────────────────────────────────
    _phase("Phase 2: Generate synthetic training data")
    if args.skip_synth:
        print("  Skipped (--skip-synth).")
    else:
        # 2a — single-card synth (writes to images/train)
        print(f"\n  [2a] Generating {args.synth_count} single-card synthetic images …")
        _run([
            sys.executable, str(HERE / "synth_bootstrap.py"),
            "--data", str(VELLUM_DETECT),
            "--count", str(args.synth_count),
            "--catalog-images", str(CATALOG_IMAGES),
            "--catalog-art-limit", str(args.catalog_art_limit),
        ])

        # 2b — create val split from the generated train images
        print("\n  [2b] Creating val split (15% of synth images) …")
        n_moved = _create_val_split(VELLUM_DETECT)
        train_count = len(list((VELLUM_DETECT / "images" / "train").glob("*.*"))) \
            if (VELLUM_DETECT / "images" / "train").exists() else 0
        val_count = len(list((VELLUM_DETECT / "images" / "val").glob("*.*"))) \
            if (VELLUM_DETECT / "images" / "val").exists() else 0
        print(f"  Moved {n_moved} images → val/ (train: {train_count}, val: {val_count})")

    # ── Phase 3: Train ──────────────────────────────────────────────────────
    _phase("Phase 3: Train YOLO11n")
    if args.skip_train:
        print("  Skipped (--skip-train).")
    else:
        _run([
            sys.executable, str(HERE / "train_detect.py"),
            "--data", str(DATASET_YAML),
            "--epochs", str(args.epochs),
            "--imgsz", str(args.imgsz),
        ])

    # ── Phase 4: Eval gate ──────────────────────────────────────────────────
    _phase("Phase 4: Eval gate (mAP@50 ≥ 0.95)")
    if args.skip_eval:
        print("  Skipped (--skip-eval).")
    else:
        rc = _run([
            sys.executable, str(HERE / "eval_detect.py"),
            "--data", str(DATASET_YAML),
        ], check=False)
        if rc != 0:
            print("\n  Eval gate FAILED. Check training data and try again.")
            sys.exit(1)

    print("\n  Bootstrap complete. models/card_detect.onnx is ready.")


if __name__ == "__main__":
    main()
