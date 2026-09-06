#!/usr/bin/env python3
"""Fine-tune YOLO11n for card detection, then export ONNX."""

from __future__ import annotations

import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = HERE.parent / "models"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=HERE / "dataset.yaml")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--name", default="card_detect")
    args = parser.parse_args()

    from ultralytics import YOLO  # type: ignore

    MODELS.mkdir(parents=True, exist_ok=True)
    model = YOLO(args.model)
    model.train(
        data=str(args.data),
        epochs=args.epochs,
        imgsz=args.imgsz,
        project=str(MODELS),
        name=args.name,
        exist_ok=True,
        degrees=15.0,
        perspective=0.0005,
        shear=2.0,
        mosaic=1.0,
        fliplr=0.5,
    )
    best = MODELS / args.name / "weights" / "best.pt"
    if not best.is_file():
        # ultralytics may nest under runs/
        candidates = list(MODELS.rglob("best.pt"))
        if not candidates:
            raise SystemExit("Training finished but best.pt not found")
        best = candidates[0]
    import shutil

    exported = Path(YOLO(str(best)).export(format="onnx", opset=17, simplify=True))
    dest = MODELS / "card_detect.onnx"
    if exported.resolve() != dest.resolve():
        shutil.copy2(exported, dest)
    print(f"ONNX ready: {dest}")
    print("Gate: run eval_detect.py on stand holdout; require mAP@50 >= 0.95 before production.")


if __name__ == "__main__":
    main()
