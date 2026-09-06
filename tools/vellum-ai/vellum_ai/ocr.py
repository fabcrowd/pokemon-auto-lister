"""Bottom-strip OCR for collector numbers."""

from __future__ import annotations

import os
from typing import Any, Dict, List

import cv2
import numpy as np

from .fusion import parse_ocr_text

# Avoid Paddle oneDNN PIR crash on Windows CPU builds.
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")


def _preprocess(strip_bgr: np.ndarray) -> np.ndarray:
    """Upscale + contrast for small collector-number text."""
    h, w = strip_bgr.shape[:2]
    scale = 3 if max(h, w) < 900 else 2
    big = cv2.resize(strip_bgr, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


def _crops(image_bgr: np.ndarray) -> List[np.ndarray]:
    """Multiple bottom / bottom-left crops — IR cards put numbers above copyright."""
    h, w = image_bgr.shape[:2]
    return [
        image_bgr[int(h * 0.86) :, :],
        image_bgr[int(h * 0.78) :, :],
        image_bgr[int(h * 0.78) :, : int(w * 0.62)],
        image_bgr[int(h * 0.88) :, : int(w * 0.55)],
        image_bgr[int(h * 0.70) : int(h * 0.92), : int(w * 0.65)],
    ]


def run_ocr(image_bgr: np.ndarray) -> Dict[str, Any]:
    """
    OCR bottom regions. Prefers RapidOCR (ONNX); falls back to PaddleOCR / Tesseract.
    """
    parts: List[str] = []
    for crop in _crops(image_bgr):
        text = _ocr_text(_preprocess(crop))
        if text:
            parts.append(text)
    combined = " ".join(parts)
    parsed = parse_ocr_text(combined)
    parsed["confidence"] = 0.9 if parsed.get("number") else 0.0
    parsed["raw"] = combined
    return parsed


def _ocr_text(image_bgr: np.ndarray) -> str:
    text = _ocr_rapid(image_bgr)
    if text:
        return text
    text = _ocr_paddle(image_bgr)
    if text:
        return text
    return _ocr_tesseract(image_bgr)


def _ocr_rapid(image_bgr: np.ndarray) -> str:
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore

        if not hasattr(_ocr_rapid, "_engine"):
            _ocr_rapid._engine = RapidOCR()  # type: ignore[attr-defined]
        result, _ = _ocr_rapid._engine(image_bgr)  # type: ignore[attr-defined]
        if not result:
            return ""
        return " ".join(str(line[1]) for line in result)
    except Exception:
        return ""


def _ocr_paddle(image_bgr: np.ndarray) -> str:
    try:
        from paddleocr import PaddleOCR  # type: ignore

        if not hasattr(_ocr_paddle, "_engine"):
            _ocr_paddle._engine = PaddleOCR(lang="en")  # type: ignore[attr-defined]
        engine = _ocr_paddle._engine  # type: ignore[attr-defined]
        if hasattr(engine, "predict"):
            result = engine.predict(image_bgr)
        else:
            result = engine.ocr(image_bgr)
        lines: list[str] = []
        if result and isinstance(result, list):
            for item in result:
                if isinstance(item, dict) and "rec_texts" in item:
                    lines.extend(str(t) for t in item["rec_texts"])
                elif hasattr(item, "get") and item.get("rec_texts"):
                    lines.extend(str(t) for t in item["rec_texts"])
                elif isinstance(item, list):
                    for line in item:
                        if line and len(line) >= 2:
                            lines.append(str(line[1][0] if isinstance(line[1], (list, tuple)) else line[1]))
        return " ".join(lines)
    except Exception:
        return ""


def _ocr_tesseract(image_bgr: np.ndarray) -> str:
    try:
        import pytesseract  # type: ignore

        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        _, thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return pytesseract.image_to_string(thr) or ""
    except Exception:
        return ""
