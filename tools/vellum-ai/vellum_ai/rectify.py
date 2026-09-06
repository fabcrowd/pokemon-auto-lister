"""Card crop rectification helpers (perspective warp to canonical aspect)."""

from __future__ import annotations

from typing import Optional, Sequence, Tuple

import cv2
import numpy as np

CANONICAL_SIZE: Tuple[int, int] = (750, 1050)  # width, height ≈ 63×88


def order_corners(pts: np.ndarray) -> np.ndarray:
    """Order four points as TL, TR, BR, BL."""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def box_to_corners(xyxy: Sequence[float]) -> np.ndarray:
    """Axis-aligned box (x1,y1,x2,y2) → four corners."""
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    return np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], dtype=np.float32)


def rectify_card(
    image_bgr: np.ndarray,
    corners: np.ndarray,
    size: Tuple[int, int] = CANONICAL_SIZE,
) -> np.ndarray:
    """Perspective-warp a card to ``size`` (width, height)."""
    src = order_corners(corners)
    w, h = size
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(image_bgr, matrix, (w, h))


def rectify_from_box(
    image_bgr: np.ndarray,
    xyxy: Sequence[float],
    size: Tuple[int, int] = CANONICAL_SIZE,
) -> np.ndarray:
    """Rectify using an axis-aligned detection box."""
    return rectify_card(image_bgr, box_to_corners(xyxy), size=size)


def estimate_centering(rectified_bgr: np.ndarray) -> dict:
    """
    Rough L/R and T/B border ratios from edge ink density (capture QA, not PSA).
    Returns ratios as left/right and top/bottom percentages summing to ~100.
    """
    gray = cv2.cvtColor(rectified_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    # Sample border strips
    strip = max(4, min(w, h) // 40)
    left = float(np.mean(gray[:, :strip]))
    right = float(np.mean(gray[:, w - strip :]))
    top = float(np.mean(gray[:strip, :]))
    bottom = float(np.mean(gray[h - strip :, :]))

    # Darker borders → more border mass; invert so more border → higher weight
    lr_l = 255.0 - left
    lr_r = 255.0 - right
    tb_t = 255.0 - top
    tb_b = 255.0 - bottom
    lr_sum = lr_l + lr_r + 1e-6
    tb_sum = tb_t + tb_b + 1e-6
    left_pct = round(100.0 * lr_l / lr_sum)
    right_pct = 100 - left_pct
    top_pct = round(100.0 * tb_t / tb_sum)
    bottom_pct = 100 - top_pct
    return {
        "left_right": f"{left_pct}/{right_pct}",
        "top_bottom": f"{top_pct}/{bottom_pct}",
        "offsets": {
            "left": left_pct / 100.0,
            "right": right_pct / 100.0,
            "top": top_pct / 100.0,
            "bottom": bottom_pct / 100.0,
        },
    }


def glare_score(rectified_bgr: np.ndarray) -> float:
    """Fraction of near-saturated pixels (0–1). High → reject / re-shoot."""
    hsv = cv2.cvtColor(rectified_bgr, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    return float(np.mean(v >= 250))


def blur_score(rectified_bgr: np.ndarray) -> float:
    """Variance of Laplacian — low values mean blurry."""
    gray = cv2.cvtColor(rectified_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _aspect_ok(w: float, h: float) -> bool:
    if w <= 1 or h <= 1:
        return False
    ratio = max(w, h) / min(w, h)
    # Pokemon card ~1.4; allow tilt/partial
    return 1.15 <= ratio <= 1.85


def _score_quad(pts: np.ndarray, image_area: float) -> float:
    area = abs(cv2.contourArea(pts))
    # Reject near-full-frame blobs (table/wood) — prefer a real card outline.
    if area < image_area * 0.08 or area > image_area * 0.88:
        return -1.0
    x, y, w, h = cv2.boundingRect(pts)
    if not _aspect_ok(w, h):
        return -1.0
    peri = cv2.arcLength(pts, True) + 1e-6
    rectangularity = area / (w * h + 1e-6)
    return float(area * rectangularity * (4.0 * np.sqrt(area) / peri))


def find_card_quad(image_bgr: np.ndarray) -> Optional[np.ndarray]:
    """
    Find a card quadrilateral on busy backgrounds (wood table, glare).
    Returns 4x2 float32 corners, or None.
    """
    h0, w0 = image_bgr.shape[:2]
    image_area = float(h0 * w0)
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (7, 7), 0)

    candidates: list[np.ndarray] = []

    # 1) Adaptive threshold + morphology (works on wood grain)
    thr = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 51, 5)
    thr = cv2.bitwise_not(thr)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    closed = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, kernel, iterations=2)

    # 2) Canny at multiple thresholds
    edges_list = [
        closed,
        cv2.Canny(blur, 30, 100),
        cv2.Canny(blur, 50, 150),
        cv2.Canny(blur, 80, 200),
    ]

    # 3) Saturation mask — cards usually more colorful than brown wood
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    vivid = cv2.bitwise_and(
        cv2.inRange(sat, 25, 255),
        cv2.inRange(val, 40, 255),
    )
    vivid = cv2.morphologyEx(vivid, cv2.MORPH_CLOSE, kernel, iterations=2)
    edges_list.append(vivid)

    best_pts = None
    best_score = -1.0

    for edges in edges_list:
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < image_area * 0.08:
                continue
            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                pts = approx.reshape(4, 2).astype(np.float32)
                score = _score_quad(pts, image_area)
                if score > best_score:
                    best_score = score
                    best_pts = pts
            else:
                # minAreaRect fallback for near-rectangles
                rect = cv2.minAreaRect(contour)
                (cx, cy), (rw, rh), _ang = rect
                if rw < 1 or rh < 1 or not _aspect_ok(rw, rh):
                    continue
                box = cv2.boxPoints(rect).astype(np.float32)
                score = _score_quad(box, image_area)
                if score > best_score:
                    best_score = score
                    best_pts = box

    if best_pts is not None:
        return order_corners(best_pts)

    # Last resort: central crop with card aspect (phone-stand / table shots)
    # Assume card occupies ~55–80% of the shorter dimension, centered.
    short = min(w0, h0)
    card_h = short * 0.78
    card_w = card_h / 1.4
    if card_w > w0 * 0.92:
        card_w = w0 * 0.85
        card_h = card_w * 1.4
    x1 = (w0 - card_w) / 2
    y1 = (h0 - card_h) / 2
    return order_corners(
        np.array(
            [[x1, y1], [x1 + card_w, y1], [x1 + card_w, y1 + card_h], [x1, y1 + card_h]],
            dtype=np.float32,
        )
    )


def largest_contour_box(image_bgr: np.ndarray) -> Optional[Tuple[float, float, float, float]]:
    """Fallback detector: card quad → axis-aligned xyxy."""
    quad = find_card_quad(image_bgr)
    if quad is None:
        return None
    xs = quad[:, 0]
    ys = quad[:, 1]
    return (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))


def rectify_from_image(image_bgr: np.ndarray, size: Tuple[int, int] = CANONICAL_SIZE) -> Optional[np.ndarray]:
    """Detect card corners and perspective-warp to canonical size."""
    quad = find_card_quad(image_bgr)
    if quad is None:
        return None
    return rectify_card(image_bgr, quad, size=size)
