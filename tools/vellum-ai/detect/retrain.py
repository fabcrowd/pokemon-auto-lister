#!/usr/bin/env python3
"""Self-improving retrain loop for card_detect.onnx.

Ingests pseudo-labeled harvest frames, retrains YOLO11n, gates on mAP@50 ≥ 0.95
plus improvement over the current baseline, and promotes the new model if it passes.

Usage (from tools/vellum-ai):
    python detect/retrain.py
    python detect/retrain.py --min-new 100 --epochs 50 --dry-run
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent
MODELS_DIR = HERE.parent / "models"

DEFAULT_HARVEST = REPO_ROOT / "data" / "harvest"
DEFAULT_DATA = REPO_ROOT / "data" / "vellum-detect"
DEFAULT_DATASET_YAML = HERE / "dataset.yaml"
DEFAULT_MODEL = MODELS_DIR / "card_detect.onnx"
_INGESTED_DIR = "_ingested"

CLASS_FULL = 0
# Synthetic val mAP stayed ~0.99 while the shipped model scored F1 0.15 on real
# listing photos, so promotion also requires the reviewed real-photo set.
REAL_F1_GATE = 0.90


def _load_harvest_frames(harvest_dir: Path) -> list[Path]:
    """Return images with an explicitly human-reviewed annotation sidecar."""
    if not harvest_dir.is_dir():
        return []
    frames = []
    for jpg in sorted(harvest_dir.glob("frame_*.jpg")):
        meta = jpg.with_suffix(".json")
        if not meta.exists():
            continue
        try:
            annotation = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if annotation.get("reviewed") is True and isinstance(annotation.get("boxes"), list):
            frames.append(jpg)
    return frames


def _boxes_to_yolo(boxes: list[list[float]], img_w: int, img_h: int) -> list[str]:
    """Convert [x1,y1,x2,y2] pixel boxes to YOLO label lines (class 0)."""
    lines = []
    for x1, y1, x2, y2 in boxes:
        xc = (x1 + x2) / 2 / img_w
        yc = (y1 + y2) / 2 / img_h
        bw = (x2 - x1) / img_w
        bh = (y2 - y1) / img_h
        xc = max(0.0, min(1.0, xc))
        yc = max(0.0, min(1.0, yc))
        bw = max(0.0, min(1.0, bw))
        bh = max(0.0, min(1.0, bh))
        if bw > 0 and bh > 0:
            lines.append(f"{CLASS_FULL} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}")
    return lines


def _ingest_frames_to_dataset(frames: list[Path], data_root: Path, dry_run: bool) -> int:
    """Copy harvest frames + pseudo-labels into data_root/images/train and labels/train."""
    import cv2  # type: ignore

    train_img = data_root / "images" / "train"
    train_lbl = data_root / "labels" / "train"
    if not dry_run:
        train_img.mkdir(parents=True, exist_ok=True)
        train_lbl.mkdir(parents=True, exist_ok=True)

    ingested = 0
    for jpg in frames:
        meta_path = jpg.with_suffix(".json")
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if meta.get("reviewed") is not True or not isinstance(meta.get("boxes"), list):
            continue
        boxes: list[list[float]] = meta.get("boxes", [])

        if not dry_run:
            img = cv2.imread(str(jpg))
            if img is None:
                continue
            h, w = img.shape[:2]
            dest_img = train_img / jpg.name
            shutil.copy2(jpg, dest_img)

            label_lines = _boxes_to_yolo(boxes, w, h)
            lbl_path = train_lbl / jpg.with_suffix(".txt").name
            lbl_path.write_text("\n".join(label_lines) + ("\n" if label_lines else ""), encoding="utf-8")
            ingested += 1
        else:
            ingested += 1

    return ingested


# Lots whose id ends in 0-2 are the held-out HiBid test split; never train on them.
_HOLDOUT_LOT_DIGITS = {0, 1, 2}


def _is_train_lot(lot: str, side: dict) -> bool:
    if side.get("split") not in (None, "train"):
        return False
    return not (lot.isdigit() and int(lot) % 10 in _HOLDOUT_LOT_DIGITS)


def ingest_reviewed_photos(photos_dir: Path, data_root: Path) -> int:
    """Copy reviewed real lot photos (``<lot>/<NN>.jpg`` + sidecar) into the YOLO train split.

    Ignore regions (cut-off cards) are painted letterbox-grey so YOLO does not learn them as background.
    """
    import cv2  # type: ignore

    img_dir, lbl_dir = data_root / "images" / "train", data_root / "labels" / "train"
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)
    ingested = 0
    for sidecar in sorted(photos_dir.glob("*/[0-9][0-9].json")):
        try:
            side = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        lot = sidecar.parent.name
        if side.get("reviewed") is not True or not isinstance(side.get("boxes"), list) or not _is_train_lot(lot, side):
            continue
        img = cv2.imread(str(sidecar.with_suffix(".jpg")))
        if img is None:
            continue
        for x1, y1, x2, y2 in side.get("ignore") or []:
            img[max(0, int(y1)):max(0, int(y2)), max(0, int(x1)):max(0, int(x2))] = 114
        stem = f"hibid_{lot}_{sidecar.stem}"
        cv2.imwrite(str(img_dir / f"{stem}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        h, w = img.shape[:2]
        lines = _boxes_to_yolo(side["boxes"], w, h)
        (lbl_dir / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        ingested += 1
    return ingested


_NEG_VARIANTS = ("half", "quarter", "dark", "tilt")


def augment_negatives(data_root: Path, seed: int = 0) -> int:
    """Write half / quarter / dark / tilted copies of every empty-label train image.

    Tilted-binder training made booster boxes fire as cards; these copies keep sealed
    product a negative at the scales and angles the stress set and listings use.
    """
    import random

    import cv2  # type: ignore

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from synth_binder import _tilt  # noqa: PLC0415

    rng = random.Random(seed)
    img_dir, lbl_dir = data_root / "images" / "train", data_root / "labels" / "train"
    written = 0
    for lbl in sorted(lbl_dir.glob("*.txt")):
        if "__" in lbl.stem or lbl.read_text(encoding="utf-8").strip():
            continue
        if (lbl_dir / f"{lbl.stem}__{_NEG_VARIANTS[0]}.txt").exists():
            continue
        img = cv2.imread(str(img_dir / f"{lbl.stem}.jpg"))
        if img is None:
            continue
        h, w = img.shape[:2]
        variants = {
            "half": cv2.resize(img, (w // 2, h // 2), interpolation=cv2.INTER_AREA),
            "quarter": cv2.resize(img, (max(1, w // 4), max(1, h // 4)), interpolation=cv2.INTER_AREA),
            "dark": cv2.convertScaleAbs(img, alpha=0.45, beta=0),
            "tilt": _tilt(img.copy(), [], rng)[0],
        }
        for name in _NEG_VARIANTS:
            stem = f"{lbl.stem}__{name}"
            cv2.imwrite(str(img_dir / f"{stem}.jpg"), variants[name], [cv2.IMWRITE_JPEG_QUALITY, 92])
            (lbl_dir / f"{stem}.txt").write_text("", encoding="utf-8")
            written += 1
    return written


def _run(cmd: list[str]) -> int:
    print("  $", " ".join(cmd))
    return subprocess.call(cmd)


def _map50_from_results_csv() -> float:
    """Read best mAP@50 from Ultralytics results.csv written during training."""
    results_csv = MODELS_DIR / "card_detect" / "results.csv"
    if not results_csv.exists():
        return 0.0
    try:
        import csv
        with results_csv.open(encoding="utf-8") as f:
            reader = csv.DictReader(f)
            col = next(
                (k for k in (reader.fieldnames or []) if "map50" in k.lower() and "95" not in k.lower()),
                None,
            )
            if col is None:
                return 0.0
            best = 0.0
            for row in reader:
                try:
                    v = float(row[col].strip())
                    if v > best:
                        best = v
                except (ValueError, KeyError):
                    pass
        return best
    except Exception:
        return 0.0


def _current_model_map50(dataset_yaml: Path, model_path: Path) -> float:
    """Run eval_detect.py and parse mAP@50 from stdout. Returns 0.0 on failure."""
    eval_script = HERE / "eval_detect.py"
    if not eval_script.exists() or not model_path.exists():
        return 0.0
    try:
        import subprocess as sp
        result = sp.run(
            [sys.executable, str(eval_script), "--data", str(dataset_yaml), "--weights", str(model_path)],
            capture_output=True,
            text=True,
            timeout=300,
        )
        for line in (result.stdout + result.stderr).splitlines():
            low = line.lower()
            if "map50" in low or "map@50" in low:
                parts = line.split()
                for part in reversed(parts):
                    try:
                        val = float(part)
                        if 0.0 <= val <= 1.0:
                            return val
                    except ValueError:
                        continue
    except Exception:
        pass
    return 0.0


def _passes_real_gate(new_f1: float | None, baseline_f1: float | None) -> bool:
    if new_f1 is None:
        return False
    return new_f1 >= REAL_F1_GATE and new_f1 >= (baseline_f1 or 0.0)


def _real_eval_f1(model_path: Path) -> float | None:
    """F1 on reviewed real photos via eval_real.py; None when unavailable."""
    if not model_path.exists():
        return None
    try:
        result = subprocess.run(
            [sys.executable, str(HERE / "eval_real.py"), "--weights", str(model_path), "--json"],
            capture_output=True,
            text=True,
            timeout=600,
        )
        return float(json.loads(result.stdout.strip().splitlines()[-1])["f1"])
    except Exception:
        return None


def retrain(
    harvest_dir: Path,
    data_root: Path,
    dataset_yaml: Path,
    model_path: Path,
    min_new: int,
    epochs: int,
    imgsz: int,
    dry_run: bool,
) -> bool:
    frames = _load_harvest_frames(harvest_dir)
    print(f"Harvest frames found: {len(frames)}")
    if len(frames) < min_new:
        print(f"Need ≥ {min_new} new frames (have {len(frames)}). Skipping retrain.")
        return False

    # Baseline mAP before retrain
    baseline = _current_model_map50(dataset_yaml, model_path)
    print(f"Baseline mAP@50: {baseline:.4f}")
    baseline_real = _real_eval_f1(model_path)
    print(f"Baseline real-photo F1: {baseline_real}")

    # Archive current model
    archive_path: Path | None = None
    if model_path.exists() and not dry_run:
        ts = int(time.time())
        archive_path = model_path.with_name(f"card_detect_archive_{ts}.onnx")
        shutil.copy2(model_path, archive_path)
        print(f"Archived current model → {archive_path.name}")

    # Ingest harvest frames as pseudo-labeled training data
    ingested = _ingest_frames_to_dataset(frames, data_root, dry_run)
    print(f"Ingested {ingested} frames into {data_root / 'images' / 'train'}")

    if dry_run:
        print("[dry-run] Would run train_detect.py and eval_detect.py now. Stopping.")
        return False

    # Retrain — train_detect.py always writes to models/card_detect.onnx
    rc = _run([
        sys.executable, str(HERE / "train_detect.py"),
        "--data", str(dataset_yaml),
        "--epochs", str(epochs),
        "--imgsz", str(imgsz),
    ])
    if rc != 0:
        print(f"Training failed (exit {rc}).")
        if archive_path:
            shutil.copy2(archive_path, model_path)
            print("Restored previous model from archive.")
        return False

    # Evaluate new model — prefer Ultralytics results.csv (works without eval_detect.py)
    new_map = _map50_from_results_csv()
    if new_map == 0.0:
        new_map = _current_model_map50(dataset_yaml, model_path)
    print(f"New model mAP@50: {new_map:.4f}")

    MAP_GATE = 0.95
    if new_map < MAP_GATE or new_map <= baseline:
        reason = f"mAP@50 {new_map:.4f} < gate {MAP_GATE}" if new_map < MAP_GATE else \
                 f"mAP@50 {new_map:.4f} ≤ baseline {baseline:.4f}"
        print(f"New model did not improve ({reason}). Restoring previous model.")
        if archive_path:
            shutil.copy2(archive_path, model_path)
        return False

    new_real = _real_eval_f1(model_path)
    print(f"New model real-photo F1: {new_real}")
    if not _passes_real_gate(new_real, baseline_real):
        print(f"Real-photo gate failed (need F1 ≥ {REAL_F1_GATE} and ≥ baseline). Restoring previous model.")
        if archive_path:
            shutil.copy2(archive_path, model_path)
        return False

    # Promote: archive ingested harvest frames
    ingested_dir = harvest_dir / _INGESTED_DIR
    ingested_dir.mkdir(exist_ok=True)
    moved = 0
    for jpg in frames:
        for p in (jpg, jpg.with_suffix(".json")):
            if p.exists():
                shutil.move(str(p), ingested_dir / p.name)
                moved += 1
    print(f"Promoted new model (mAP@50 {new_map:.4f}). Moved {moved} harvest files → {ingested_dir.name}/")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--harvest", type=Path, default=DEFAULT_HARVEST)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--dataset-yaml", type=Path, default=DEFAULT_DATASET_YAML)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--min-new", type=int, default=50,
                        help="Minimum new harvest frames required to trigger retrain (default 50)")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would happen without modifying anything")
    args = parser.parse_args()

    ok = retrain(
        harvest_dir=args.harvest,
        data_root=args.data,
        dataset_yaml=args.dataset_yaml,
        model_path=args.model,
        min_new=args.min_new,
        epochs=args.epochs,
        imgsz=args.imgsz,
        dry_run=args.dry_run,
    )
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
