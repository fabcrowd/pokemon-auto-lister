"""Card detection: YOLO ONNX when present, contour fallback otherwise.

Multi-class ONNX (full_card / corner_closeup / card_back): prefer full_card for
identity/rectify; expose class so callers never treat a corner as a front.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np

from .rectify import find_card_quad, largest_contour_box, rectify_card, rectify_from_box

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
DEFAULT_ONNX = MODELS_DIR / "card_detect.onnx"

CLASS_FULL_CARD = 0
CLASS_CORNER_CLOSEUP = 1
CLASS_CARD_BACK = 2
CLASS_NAMES = {
    CLASS_FULL_CARD: "full_card",
    CLASS_CORNER_CLOSEUP: "corner_closeup",
    CLASS_CARD_BACK: "card_back",
}


def detect_card_box(image_bgr: np.ndarray, onnx_path: Optional[Path] = None) -> Optional[Tuple[float, float, float, float]]:
    """Return xyxy for the best full_card (or legacy best box), or None."""
    result = detect_card(image_bgr, onnx_path=onnx_path)
    if result is None:
        return largest_contour_box(image_bgr)
    return result["box"]


def detect_card(
    image_bgr: np.ndarray,
    onnx_path: Optional[Path] = None,
    *,
    prefer_full_card: bool = True,
) -> Optional[Dict[str, Any]]:
    """Detect card box + class. Prefer full_card when multi-class weights are present."""
    path = Path(onnx_path or os.environ.get("VELLUM_AI_DETECT_ONNX", DEFAULT_ONNX))
    if path.is_file():
        hit = _detect_onnx(image_bgr, path, prefer_full_card=prefer_full_card)
        if hit is not None:
            return hit
    box = largest_contour_box(image_bgr)
    if box is None:
        return None
    return {
        "box": box,
        "class_id": CLASS_FULL_CARD,
        "class_name": CLASS_NAMES[CLASS_FULL_CARD],
        "confidence": None,
        "source": "contour",
    }


def _detect_onnx(
    image_bgr: np.ndarray,
    onnx_path: Path,
    *,
    prefer_full_card: bool = True,
) -> Optional[Dict[str, Any]]:
    try:
        import onnxruntime as ort  # type: ignore
    except ImportError:
        return None

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    inp = session.get_inputs()[0]
    _, _, height, width = inp.shape
    h0, w0 = image_bgr.shape[:2]
    resized = cv2.resize(image_bgr, (int(width), int(height)))
    blob = resized[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
    blob = np.expand_dims(blob, 0)
    outputs = session.run(None, {inp.name: blob})[0]
    arr = np.squeeze(outputs)
    if arr.ndim != 2:
        return None
    if arr.shape[0] in (5, 6, 7) or (arr.shape[0] < arr.shape[1] and arr.shape[0] <= 84):
        arr = arr.T
    # rows: x,y,w,h,conf[, class scores...]  OR x,y,w,h + class scores (YOLO11)
    if arr.shape[1] < 5:
        return None

    nc = arr.shape[1] - 4
    if nc <= 0:
        return None

    # Ultralytics export: often [cx,cy,w,h, class0, class1, ...] without separate obj conf
    if nc == 1:
        # Single-class: col4 is objectness
        scores = arr[:, 4]
        class_ids = np.zeros(arr.shape[0], dtype=np.int32)
    else:
        class_scores = arr[:, 4:]
        class_ids = np.argmax(class_scores, axis=1).astype(np.int32)
        scores = class_scores.max(axis=1)

    scale_x = w0 / float(width)
    scale_y = h0 / float(height)

    def _row_to_hit(idx: int) -> Dict[str, Any]:
        cx, cy, bw, bh = arr[idx, :4]
        x1 = (cx - bw / 2) * scale_x
        y1 = (cy - bh / 2) * scale_y
        x2 = (cx + bw / 2) * scale_x
        y2 = (cy + bh / 2) * scale_y
        cid = int(class_ids[idx])
        return {
            "box": (float(x1), float(y1), float(x2), float(y2)),
            "class_id": cid,
            "class_name": CLASS_NAMES.get(cid, f"class_{cid}"),
            "confidence": float(scores[idx]),
            "source": "onnx",
        }

    # Prefer full_card only when it is actually confident — otherwise a weak
    # full_card score can steal the label from a clear corner_closeup.
    if prefer_full_card and nc >= 3:
        full_mask = class_ids == CLASS_FULL_CARD
        if full_mask.any():
            full_scores = np.where(full_mask, scores, -1.0)
            best_full = int(np.argmax(full_scores))
            best_any = int(np.argmax(scores))
            if scores[best_full] >= 0.35 and scores[best_full] + 0.05 >= scores[best_any]:
                return _row_to_hit(best_full)

    best = int(np.argmax(scores))
    if scores[best] < 0.12:
        return None
    return _row_to_hit(best)


def detect_and_rectify(image_bgr: np.ndarray) -> Dict[str, Any]:
    """Prefer perspective quad warp; fall back to axis-aligned box.

    If the top ONNX hit is a corner_closeup, still return the box but mark
    ``usable_as_front=False`` so callers do not treat it as identity front.
    """
    path = Path(os.environ.get("VELLUM_AI_DETECT_ONNX", DEFAULT_ONNX))
    if path.is_file():
        # Prefer a full_card box for rectify; fall back to any detection.
        hit = _detect_onnx(image_bgr, path, prefer_full_card=True)
        if hit is not None:
            usable_as_front = (
                hit["class_id"] == CLASS_FULL_CARD
                and (hit.get("confidence") is None or hit["confidence"] >= 0.35)
            )
            return {
                "ok": True,
                "reason": None if usable_as_front else "detected_non_front",
                "box": hit["box"],
                "rectified": rectify_from_box(image_bgr, hit["box"]) if usable_as_front else None,
                "class_id": hit["class_id"],
                "class_name": hit["class_name"],
                "confidence": hit["confidence"],
                "usable_as_front": usable_as_front,
            }

    quad = find_card_quad(image_bgr)
    if quad is None:
        return {
            "ok": False,
            "reason": "no_card_detected",
            "box": None,
            "rectified": None,
            "usable_as_front": False,
        }
    xs, ys = quad[:, 0], quad[:, 1]
    box = (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))
    return {
        "ok": True,
        "reason": None,
        "box": box,
        "rectified": rectify_card(image_bgr, quad),
        "quad": quad.tolist(),
        "class_id": CLASS_FULL_CARD,
        "class_name": CLASS_NAMES[CLASS_FULL_CARD],
        "usable_as_front": True,
    }
