"""Multi-card detection: find all cards in a single image and return rectified crops.

Strategy:
  1. ONNX (when model present): NMS, then drop full-frame boxes and thin slivers.
  2. Contour pass: card quads the ONNX boxes missed, including card backs.
     A blob about two or four times a neighboring card is split into that grid.
  3. For each hit, perspective-rectify to 750x1050 and encode as JPEG bytes.

Entry point for the server: detect_all_from_bytes(image_bytes) -> list[dict]
"""

from __future__ import annotations

import base64
from functools import lru_cache
import json as _json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from .detect import CLASS_FULL_CARD, CLASS_NAMES, MODELS_DIR, DEFAULT_ONNX
from .rectify import (
    _aspect_ok,
    find_card_quad,
    order_corners,
    rectify_card,
    rectify_from_box,
)

# Harvest state for self-improving loop
_last_harvest_ts: float = 0.0
_HARVEST_COOLDOWN: float = 30.0

# Maximum aspect ratio for partial/clipped cards (half-card portrait → ~2.8)
_PARTIAL_ASPECT_MAX = 3.5
# A partial-card region must be within this many pixels of an image edge
_BOUNDARY_MARGIN = 12

# Minimum confidence to keep an ONNX hit before NMS
_CONF_THRESHOLD = 0.55
# IoU overlap threshold for NMS — cards don't overlap on a table
_NMS_IOU_THRESHOLD = 0.45
# Minimum score for contour-based quads (same scale as _score_quad)
_CONTOUR_MIN_SCORE = 0.0
# A contour quad must cover at least this fraction of image area (at _DETECT_MAX_DIM resolution)
_MIN_AREA_FRAC = 0.004
# Upper bound for a single card. 5% rejected every card in a tight 2–6 grid
# (each card is ~9–13% of that canvas). 35% still drops near-full-frame blobs;
# merged side-by-side pairs are caught by aspect + the landscape AABB filter.
_MAX_AREA_FRAC = 0.35
# Two quads are the "same card" if their IoU exceeds this
_DEDUP_IOU = 0.35
# ONNX sometimes boxes the whole photo (area ~0.95) or a thin strip (ratio 5–7).
# A real card in a multi-card lot stays under half the frame, and sideways
# shots reach a long/short ratio of about 1.6.
_ONNX_MAX_AREA_FRAC = 0.50
_CARD_RATIO_MAX = 2.2
# Fragments of one close-up overlap. Separate cards on a table do not.
_CLUSTER_IOU = 0.12
# Erosion kernel size for blob-split pass (pixels, at _DETECT_MAX_DIM resolution)
_SPLIT_KERNEL = 18
# Resize large images to this max dimension before contour detection so
# area-fraction thresholds remain meaningful regardless of camera resolution.
_DETECT_MAX_DIM = 1280


@lru_cache(maxsize=4)
def _load_onnx_session(onnx_path: str, _modified_ns: int):
    """Reuse inference sessions until the model file is replaced on disk."""
    import onnxruntime as ort  # type: ignore

    return ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])


def _score_quad_multi(pts: np.ndarray, image_area: float) -> float:
    """Score a candidate quad for multi-card detection.

    Unlike _score_quad (rectify.py), this does NOT enforce a per-card minimum
    area fraction — that gate was designed for single-card-per-frame use and
    rejects every card in a multi-card scene.  Area-fraction pre-filtering is
    already done by _MIN_AREA_FRAC before this function is called.
    """
    area = abs(cv2.contourArea(pts))
    if area > image_area * _MAX_AREA_FRAC:
        return -1.0
    # Use minAreaRect so the aspect check is rotation-invariant: a card tilted 45°
    # still measures ~130×182 here, whereas cv2.boundingRect would give ~220×220.
    _, (rw, rh), _ = cv2.minAreaRect(pts)
    if not _aspect_ok(rw, rh):
        return -1.0
    peri = cv2.arcLength(pts, True) + 1e-6
    rectangularity = area / (rw * rh + 1e-6)
    return float(area * rectangularity * (4.0 * np.sqrt(area) / peri))


def _aspect_ok_loose(w: float, h: float) -> bool:
    """Loose aspect check for partially-visible cards.

    A card cropped at the image edge can have any ratio from nearly-square
    (corner peek) up to ~3.5× (narrow strip of a portrait card).
    """
    if w <= 1 or h <= 1:
        return False
    return max(w, h) / min(w, h) <= _PARTIAL_ASPECT_MAX


def _touches_boundary(pts: np.ndarray, img_w: int, img_h: int) -> bool:
    """True if the quad is within _BOUNDARY_MARGIN pixels of any image edge."""
    m = _BOUNDARY_MARGIN
    return (
        pts[:, 0].min() < m
        or pts[:, 1].min() < m
        or pts[:, 0].max() > img_w - m
        or pts[:, 1].max() > img_h - m
    )


def _score_quad_partial(pts: np.ndarray, image_area: float) -> float:
    """Score a clipped card. A quad that covers most of the photo is the frame, not a card."""
    area = abs(cv2.contourArea(pts))
    if area < image_area * _MIN_AREA_FRAC or area > image_area * _MAX_AREA_FRAC:
        return -1.0
    _, (rw, rh), _ = cv2.minAreaRect(pts)
    if not _aspect_ok_loose(rw, rh):
        return -1.0
    peri = cv2.arcLength(pts, True) + 1e-6
    rectangularity = area / (rw * rh + 1e-6)
    return float(area * rectangularity * (4.0 * np.sqrt(area) / peri))


def _contour_partial_edge_candidates(
    edges_list: List[np.ndarray],
    image_area: float,
    img_w: int,
    img_h: int,
) -> List[Tuple[float, np.ndarray]]:
    """Find partial-card regions that touch the image boundary.

    Runs the same contour pipeline as _contour_multi but uses a loose
    aspect ratio (up to 3.5×) and only keeps candidates that are clipped
    by an image edge.  This catches cards that are partially out-of-frame.
    """
    candidates: List[Tuple[float, np.ndarray]] = []
    for edges in edges_list:
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < image_area * _MIN_AREA_FRAC:
                continue
            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
            pts: Optional[np.ndarray] = None
            if len(approx) == 4 and cv2.isContourConvex(approx):
                pts = approx.reshape(4, 2).astype(np.float32)
            else:
                rect = cv2.minAreaRect(contour)
                (_, _), (rw, rh), _ = rect
                if rw >= 1 and rh >= 1 and _aspect_ok_loose(rw, rh):
                    pts = cv2.boxPoints(rect).astype(np.float32)
            if pts is None:
                continue
            if not _touches_boundary(pts, img_w, img_h):
                continue
            score = _score_quad_partial(pts, image_area)
            if score > _CONTOUR_MIN_SCORE:
                candidates.append((score, order_corners(pts)))
    return candidates


def _maybe_harvest(image_bgr: np.ndarray, contour_hits: List[Dict[str, Any]]) -> None:
    """Save a hard-example frame when ONNX missed but contour found cards."""
    global _last_harvest_ts
    harvest_dir_s = os.environ.get("VELLUM_HARVEST_DIR", "")
    if not harvest_dir_s:
        return
    import time as _time
    now = _time.time()
    if now - _last_harvest_ts < _HARVEST_COOLDOWN:
        return
    _last_harvest_ts = now
    harvest_dir = Path(harvest_dir_s)
    try:
        harvest_dir.mkdir(parents=True, exist_ok=True)
        ts_ms = int(now * 1000)
        stem = f"frame_{ts_ms}"
        _, jpeg = cv2.imencode(".jpg", image_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        (harvest_dir / f"{stem}.jpg").write_bytes(jpeg.tobytes())
        meta = {
            "timestamp_ms": ts_ms,
            "source": "contour",
            "boxes": [list(h["box"]) for h in contour_hits],
            "scores": [h.get("confidence") for h in contour_hits],
        }
        (harvest_dir / f"{stem}.json").write_text(_json.dumps(meta, indent=2), encoding="utf-8")
    except Exception:
        pass  # never crash the server over harvest failure


def detect_all_from_bytes(image_bytes: bytes) -> List[Dict[str, Any]]:
    """Decode image bytes and return all detected card crops.

    Each dict:
      index       int         0-based card index
      box         [x1,y1,x2,y2]  pixel coords in original image
      class_id    int
      class_name  str
      confidence  float|None
      source      "onnx"|"contour"
      crop_b64    str         base64-encoded JPEG of the rectified 750x1050 crop
    """
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image_bgr is None:
        return []
    cards = detect_all_cards_with_crops(image_bgr)
    return cards


def _box_area_frac(box, image_w: int, image_h: int) -> float:
    """Box area as a fraction of the image."""
    x1, y1, x2, y2 = box
    return max(0.0, x2 - x1) * max(0.0, y2 - y1) / max(1.0, float(image_w * image_h))


def _box_ratio(box) -> float:
    """Long side divided by short side."""
    x1, y1, x2, y2 = box
    width = max(1e-6, float(x2 - x1))
    height = max(1e-6, float(y2 - y1))
    return max(width, height) / min(width, height)


def _box_cardlike(box, image_w: int, image_h: int) -> bool:
    """True when a box is one card, not a sliver and not the whole photo."""
    frac = _box_area_frac(box, image_w, image_h)
    return _MIN_AREA_FRAC <= frac <= _ONNX_MAX_AREA_FRAC and _box_ratio(box) <= _CARD_RATIO_MAX


def _box_iou(a, b) -> float:
    """Axis-aligned IoU of two xyxy boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    return inter / (area_a + area_b - inter + 1e-6)


def _box_mostly_inside(inner, outer, frac: float = 0.7) -> bool:
    """True when most of `inner` sits inside `outer`."""
    ax1, ay1, ax2, ay2 = inner
    bx1, by1, bx2, by2 = outer
    area_inner = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_outer = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    if area_inner <= 0.0 or area_inner > area_outer:
        return False
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    return (inter_w * inter_h) / area_inner >= frac


def _drop_overlapping_clusters(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remove boxes that overlap another box.

    A corner close-up breaks into overlapping fragments. Those fragments are
    one cluster, and none of them is its own card, so the cluster is dropped.
    """
    count = len(hits)
    parent = list(range(count))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        root_left, root_right = find(left), find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for i in range(count):
        for j in range(i + 1, count):
            if _box_iou(hits[i]["box"], hits[j]["box"]) > _CLUSTER_IOU:
                union(i, j)
    sizes: Dict[int, int] = {}
    for i in range(count):
        root = find(i)
        sizes[root] = sizes.get(root, 0) + 1
    return [hit for i, hit in enumerate(hits) if sizes[find(i)] == 1]


def _split_merged_boxes(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Split a box that is two or four cards fused into one rectangle.

    ShopGoodwill back grids leave the right-hand columns as one blob about
    twice as wide as the cards beside it. The single cards set the size.
    """
    sized = []
    for hit in hits:
        x1, y1, x2, y2 = hit["box"]
        sized.append((float(x2 - x1), float(y2 - y1), hit))
    # The common card size is the tight cluster of smaller boxes. A close-up
    # with a few odd fragments has no such cluster, so it is left alone.
    widths = sorted(width for width, _, _ in sized)
    heights = sorted(height for _, height, _ in sized)
    core_n = max(1, (len(widths) * 2) // 3)
    core_w, core_h = widths[:core_n], heights[:core_n]
    if len(core_w) < 4 or core_w[-1] > core_w[0] * 1.35 or core_h[-1] > core_h[0] * 1.35:
        return list(hits)
    median_w = core_w[len(core_w) // 2]
    median_h = core_h[len(core_h) // 2]
    if median_w < 8 or median_h < 8:
        return list(hits)

    def cells(length: float, median: float) -> int:
        raw = length / median
        count = int(round(raw))
        if count < 2 or count > 3 or abs(raw / count - 1.0) > 0.18:
            return 1
        return count

    split: List[Dict[str, Any]] = []
    for width, height, hit in sized:
        across, down = cells(width, median_w), cells(height, median_h)
        if across == 1 and down == 1:
            split.append(hit)
            continue
        x1, y1, x2, y2 = hit["box"]
        for row in range(down):
            for col in range(across):
                box = (
                    x1 + width * col / across,
                    y1 + height * row / down,
                    x1 + width * (col + 1) / across,
                    y1 + height * (row + 1) / down,
                )
                piece = {key: value for key, value in hit.items() if key != "quad"}
                split.append({**piece, "box": box})
    return split


def _is_consistent_grid(hits: List[Dict[str, Any]]) -> bool:
    """True when every box is about the same card size."""
    if len(hits) < 4:
        return False
    widths = sorted(float(hit["box"][2] - hit["box"][0]) for hit in hits)
    heights = sorted(float(hit["box"][3] - hit["box"][1]) for hit in hits)
    return widths[-1] <= widths[0] * 1.35 and heights[-1] <= heights[0] * 1.35


def _supplement_with_contour(
    onnx_hits: List[Dict[str, Any]],
    contour_hits: List[Dict[str, Any]],
    image_w: int,
    image_h: int,
) -> List[Dict[str, Any]]:
    """Add contour cards the ONNX pass missed.

    A consistent contour grid that found more cards than ONNX wins outright.
    One odd ONNX box must not hide that grid behind an area band.
    """
    if not onnx_hits or (
        _is_consistent_grid(contour_hits) and len(contour_hits) > len(onnx_hits)
    ):
        return list(contour_hits)
    areas = sorted(_box_area_frac(hit["box"], image_w, image_h) for hit in onnx_hits)
    median = areas[len(areas) // 2]
    extra: List[Dict[str, Any]] = []
    for hit in contour_hits:
        box = hit["box"]
        overlaps = any(
            _box_iou(box, kept["box"]) > 0.20
            or _box_mostly_inside(box, kept["box"])
            or _box_mostly_inside(kept["box"], box)
            for kept in onnx_hits
        )
        if overlaps:
            continue
        frac = _box_area_frac(box, image_w, image_h)
        if 0.55 * median <= frac <= 1.8 * median:
            extra.append(hit)
    return list(onnx_hits) + extra


def detect_all_cards_with_crops(image_bgr: np.ndarray) -> List[Dict[str, Any]]:
    path = Path(os.environ.get("VELLUM_AI_DETECT_ONNX", DEFAULT_ONNX))
    image_h, image_w = image_bgr.shape[:2]
    raw_onnx: List[Dict[str, Any]] = []
    if path.is_file():
        raw_onnx = _detect_onnx_letterboxed(image_bgr, path)
    onnx_hits = [
        hit for hit in raw_onnx
        if _box_cardlike(hit["box"], image_w, image_h)
    ]
    frame_rejected = any(
        _box_area_frac(hit["box"], image_w, image_h) > _ONNX_MAX_AREA_FRAC
        for hit in raw_onnx
    )

    contour_hits = [
        hit for hit in _contour_multi(image_bgr)
        if _box_cardlike(hit["box"], image_w, image_h)
    ]
    # Overlap-cluster removal is only for a close-up whose full-frame box was
    # rejected. Adjacent cards on a table can share a little area.
    if frame_rejected:
        contour_hits = _drop_overlapping_clusters(contour_hits)
    contour_hits = _split_merged_boxes(contour_hits)
    hits = _supplement_with_contour(onnx_hits, contour_hits, image_w, image_h)
    if hits and not onnx_hits and path.is_file():
        _maybe_harvest(image_bgr, hits)
    hits = sorted(hits, key=lambda hit: hit["box"][0])

    results = []
    for i, hit in enumerate(hits):
        box = hit["box"]
        quad = hit.get("quad")
        if quad is not None:
            crop = rectify_card(image_bgr, np.asarray(quad, dtype=np.float32))
        else:
            crop = _upright_crop(image_bgr, box)
            if crop is None:
                crop = rectify_from_box(image_bgr, box)
        _, jpeg = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
        crop_b64 = base64.b64encode(jpeg.tobytes()).decode("ascii")
        results.append({
            "index": i,
            "box": list(box),
            "class_id": hit["class_id"],
            "class_name": hit["class_name"],
            "confidence": hit.get("confidence"),
            "source": hit["source"],
            "crop_b64": crop_b64,
        })
    return results


# Cards tilted less than this are cropped fine by their axis-aligned box.
_MIN_TILT_DEG = 8.0
_BOX_PAD = 0.08


def _upright_crop(image_bgr: np.ndarray, box) -> Optional[np.ndarray]:
    """Rectify a visibly rotated card from its own outline instead of the axis-aligned box.

    On binder pages shot at an angle the box crop leaves the card tilted, so name OCR fails and
    geometric verification loses inliers (Fossil binder: Kabuto 129 → 225, LC reprint → correct print).
    """
    H, W = image_bgr.shape[:2]
    x1, y1, x2, y2 = box
    px, py = _BOX_PAD * (x2 - x1), _BOX_PAD * (y2 - y1)
    X1, Y1 = int(max(0, x1 - px)), int(max(0, y1 - py))
    X2, Y2 = int(min(W, x2 + px)), int(min(H, y2 + py))
    region = image_bgr[Y1:Y2, X1:X2]
    if region.size == 0:
        return None
    quad = find_card_quad(region, fallback=False)
    if quad is None:
        return None
    top = quad[1] - quad[0]
    tilt = abs(np.degrees(np.arctan2(top[1], top[0]))) % 90
    if min(tilt, 90 - tilt) < _MIN_TILT_DEG:
        return None
    # A rotated card fills roughly 40-100% of its axis-aligned box; smaller is an inner frame.
    ratio = cv2.contourArea(quad.astype(np.float32)) / max(1.0, (x2 - x1) * (y2 - y1))
    if not 0.35 <= ratio <= 1.1:
        return None
    if np.linalg.norm(quad[1] - quad[0]) > np.linalg.norm(quad[2] - quad[1]):
        # order_corners picked a long side as "top": turn the corner order a quarter so the card is portrait.
        quad = np.roll(quad, -1, axis=0) if quad[0][1] < quad[1][1] else np.roll(quad, 1, axis=0)
    return rectify_card(region, quad.astype(np.float32))


def pad_to_square(img: np.ndarray):
    """Center-pad with gray 114 like ultralytics training and the extension's letterbox (detect.js)."""
    h, w = img.shape[:2]
    side = max(h, w)
    pad_x, pad_y = (side - w) // 2, (side - h) // 2
    square = np.full((side, side, 3), 114, dtype=img.dtype)
    square[pad_y:pad_y + h, pad_x:pad_x + w] = img
    return square, pad_x, pad_y


def unpad_box(box, pad_x: int, pad_y: int) -> list:
    return [box[0] - pad_x, box[1] - pad_y, box[2] - pad_x, box[3] - pad_y]


def _detect_onnx_letterboxed(image_bgr: np.ndarray, onnx_path: Path) -> List[Dict[str, Any]]:
    # Stretching non-square photos missed cards the letterboxed model finds (HiBid F1 0.953 → 0.962).
    h, w = image_bgr.shape[:2]
    square, pad_x, pad_y = pad_to_square(image_bgr)
    hits = []
    for hit in _detect_onnx_multi(square, onnx_path):
        x1, y1, x2, y2 = unpad_box(hit["box"], pad_x, pad_y)
        box = [float(min(max(x1, 0), w)), float(min(max(y1, 0), h)), float(min(max(x2, 0), w)), float(min(max(y2, 0), h))]
        if box[2] > box[0] and box[3] > box[1]:
            hits.append({**hit, "box": box})
    return hits


def _detect_onnx_multi(
    image_bgr: np.ndarray,
    onnx_path: Path,
) -> List[Dict[str, Any]]:
    try:
        resolved_path = Path(onnx_path).resolve()
        modified_ns = resolved_path.stat().st_mtime_ns
        session = _load_onnx_session(str(resolved_path), modified_ns)
    except (ImportError, OSError):
        return []

    inp = session.get_inputs()[0]
    _, _, height, width = inp.shape
    h0, w0 = image_bgr.shape[:2]
    resized = cv2.resize(image_bgr, (int(width), int(height)))
    blob = resized[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
    blob = np.expand_dims(blob, 0)
    outputs = session.run(None, {inp.name: blob})[0]
    arr = np.squeeze(outputs)
    if arr.ndim != 2:
        return []
    if arr.shape[0] in (5, 6, 7) or (arr.shape[0] < arr.shape[1] and arr.shape[0] <= 84):
        arr = arr.T
    if arr.shape[1] < 5:
        return []

    nc = arr.shape[1] - 4
    if nc <= 0:
        return []

    if nc == 1:
        scores = arr[:, 4]
        class_ids = np.zeros(arr.shape[0], dtype=np.int32)
    else:
        class_scores = arr[:, 4:]
        class_ids = np.argmax(class_scores, axis=1).astype(np.int32)
        scores = class_scores.max(axis=1)

    scale_x = w0 / float(width)
    scale_y = h0 / float(height)

    # Keep only full_card detections above threshold
    mask = (scores >= _CONF_THRESHOLD) & (class_ids == CLASS_FULL_CARD)
    indices = np.where(mask)[0]
    if len(indices) == 0:
        # Relax: accept any class above threshold
        mask = scores >= _CONF_THRESHOLD
        indices = np.where(mask)[0]
    if len(indices) == 0:
        return []

    # Build [x, y, w, h] boxes in pixel space for NMS (cv2 wants top-left w h)
    nms_boxes = []
    nms_scores = []
    for idx in indices:
        cx, cy, bw, bh = arr[idx, :4]
        x1 = (cx - bw / 2) * scale_x
        y1 = (cy - bh / 2) * scale_y
        pw = bw * scale_x
        ph = bh * scale_y
        nms_boxes.append([float(x1), float(y1), float(pw), float(ph)])
        nms_scores.append(float(scores[idx]))

    kept = cv2.dnn.NMSBoxes(nms_boxes, nms_scores, _CONF_THRESHOLD, _NMS_IOU_THRESHOLD)
    if len(kept) == 0:
        return []

    # cv2.dnn.NMSBoxes returns shape (N,) or (N,1) depending on OpenCV version
    kept_flat = np.array(kept).flatten()

    results = []
    for k in kept_flat:
        orig_idx = int(indices[int(k)])
        cx, cy, bw, bh = arr[orig_idx, :4]
        x1 = (cx - bw / 2) * scale_x
        y1 = (cy - bh / 2) * scale_y
        x2 = (cx + bw / 2) * scale_x
        y2 = (cy + bh / 2) * scale_y
        cid = int(class_ids[orig_idx])
        results.append({
            "box": (float(x1), float(y1), float(x2), float(y2)),
            "class_id": cid,
            "class_name": CLASS_NAMES.get(cid, f"class_{cid}"),
            "confidence": float(scores[orig_idx]),
            "source": "onnx",
        })

    # Sort left-to-right so card indices are stable across calls
    results.sort(key=lambda h: h["box"][0])
    return results


def _contour_multi(image_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """Return all distinct card quads found via contour analysis."""
    # Resize large images so area-fraction thresholds are camera-resolution-agnostic.
    # Boxes are returned in original pixel coordinates.
    h0_orig, w0_orig = image_bgr.shape[:2]
    scale = 1.0
    if max(h0_orig, w0_orig) > _DETECT_MAX_DIM:
        scale = _DETECT_MAX_DIM / max(h0_orig, w0_orig)
        image_bgr = cv2.resize(
            image_bgr,
            (int(w0_orig * scale), int(h0_orig * scale)),
            interpolation=cv2.INTER_AREA,
        )
    h0, w0 = image_bgr.shape[:2]
    image_area = float(h0 * w0)
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (7, 7), 0)

    thr = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 51, 5)
    thr = cv2.bitwise_not(thr)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    closed = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, kernel, iterations=2)

    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    vivid = cv2.bitwise_and(cv2.inRange(sat, 25, 255), cv2.inRange(val, 40, 255))
    vivid = cv2.morphologyEx(vivid, cv2.MORPH_CLOSE, kernel, iterations=2)

    # 5th edge map: global Otsu threshold (catches uniform-color cards)
    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    otsu_inv = cv2.bitwise_not(otsu)
    otsu_closed = cv2.morphologyEx(otsu_inv, cv2.MORPH_CLOSE, kernel, iterations=2)

    # 6th edge map: white-border detector — Pokemon cards have bright white borders.
    # Threshold on near-white pixels (high V, low S), morphologically close to fill
    # card interiors and produce solid card-shaped blobs.
    white_border = cv2.inRange(hsv, np.array([0, 0, 190]), np.array([180, 60, 255]))
    white_border = cv2.morphologyEx(white_border, cv2.MORPH_CLOSE, kernel, iterations=3)

    edges_list = [
        closed,
        cv2.Canny(blur, 30, 100),
        cv2.Canny(blur, 50, 150),
        vivid,
        otsu_closed,
        white_border,
    ]

    candidates: List[Tuple[float, np.ndarray]] = []

    for edges in edges_list:
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < image_area * _MIN_AREA_FRAC:
                continue
            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
            pts: Optional[np.ndarray] = None
            if len(approx) == 4 and cv2.isContourConvex(approx):
                pts = approx.reshape(4, 2).astype(np.float32)
            else:
                rect = cv2.minAreaRect(contour)
                (_, _), (rw, rh), _ = rect
                if rw >= 1 and rh >= 1 and _aspect_ok(rw, rh):
                    pts = cv2.boxPoints(rect).astype(np.float32)
            if pts is None:
                continue
            score = _score_quad_multi(pts, image_area)
            if score > _CONTOUR_MIN_SCORE:
                candidates.append((score, order_corners(pts)))

    # Erosion-split pass: separate adjacent cards that merged into one blob
    candidates.extend(_erosion_split_candidates(closed, image_area))

    # Partial-edge pass: cards clipped by the image boundary (half-cards, corner peeks)
    candidates.extend(
        _contour_partial_edge_candidates(edges_list, image_area, w0, h0)
    )

    if not candidates:
        return []

    # Sort by score descending and deduplicate overlapping quads
    candidates.sort(key=lambda x: x[0], reverse=True)
    kept: List[np.ndarray] = []
    for _, pts in candidates:
        if any(_quad_iou(pts, k) > _DEDUP_IOU or _mostly_inside(pts, k) for k in kept):
            continue
        kept = [k for k in kept if not _mostly_inside(k, pts)]
        kept.append(pts)

    inv = 1.0 / scale  # scale detection coords back to original image space
    results = []
    for pts in kept:
        xs = pts[:, 0] * inv
        ys = pts[:, 1] * inv
        box = (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))
        results.append({
            "box": box,
            "quad": np.column_stack([xs, ys]).astype(np.float32),
            "class_id": CLASS_FULL_CARD,
            "class_name": CLASS_NAMES[CLASS_FULL_CARD],
            "confidence": None,
            "source": "contour",
        })

    # Reject blobs that are degenerate (clearly not a single card).
    # We check the minAreaRect of the quad so that tilted cards (e.g. 75°) are not
    # wrongly rejected by an AABB-based portrait check.  Contour approximations can
    # be imprecise, so we use a generous upper bound (3.0) rather than the strict
    # card aspect (1.85) — this only drops things that are clearly wrong (thin strips,
    # elongated merged blobs) while accepting all plausible single-card shapes.
    def _is_plausible(r: Dict[str, Any]) -> bool:
        quad = r.get("quad")
        if quad is not None:
            _, (rw, rh), _ = cv2.minAreaRect(quad.astype(np.float32))
            long_side = max(rw, rh)
            short_side = min(rw, rh) + 1e-6
            return long_side / short_side <= 3.0
        # Fallback to AABB when no quad (ONNX path)
        x1, y1, x2, y2 = r["box"]
        w, h = x2 - x1, y2 - y1
        return max(w, h) / (min(w, h) + 1e-6) <= 3.0

    results = [r for r in results if _is_plausible(r)]

    # Sort left-to-right
    results.sort(key=lambda h: h["box"][0])
    return results


def _erosion_split_candidates(
    binary: np.ndarray, image_area: float
) -> List[Tuple[float, np.ndarray]]:
    """Erode the binary mask to separate merged adjacent-card blobs, then dilate
    each fragment back to recover the full card region and score it as a candidate.

    This handles the common failure mode where two side-by-side cards share an
    edge in the adaptive-threshold map and appear as a single large blob.
    """
    k = _SPLIT_KERNEL
    kernel_erode = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    kernel_dilate = cv2.getStructuringElement(cv2.MORPH_RECT, (k + 8, k + 8))
    eroded = cv2.erode(binary, kernel_erode, iterations=1)

    contours, _ = cv2.findContours(eroded, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    results: List[Tuple[float, np.ndarray]] = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * _MIN_AREA_FRAC:
            continue
        # Dilate this fragment back on its own mask to recover the card shape
        frag_mask = np.zeros(binary.shape, dtype=np.uint8)
        cv2.drawContours(frag_mask, [contour], -1, 255, -1)
        recovered = cv2.dilate(frag_mask, kernel_dilate, iterations=1)
        sub_contours, _ = cv2.findContours(
            recovered, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        for sc in sub_contours:
            peri = cv2.arcLength(sc, True)
            if peri < 1:
                continue
            approx = cv2.approxPolyDP(sc, 0.02 * peri, True)
            pts: Optional[np.ndarray] = None
            if len(approx) == 4 and cv2.isContourConvex(approx):
                pts = approx.reshape(4, 2).astype(np.float32)
            else:
                rect = cv2.minAreaRect(sc)
                (_, _), (rw, rh), _ = rect
                if rw >= 1 and rh >= 1 and _aspect_ok(rw, rh):
                    pts = cv2.boxPoints(rect).astype(np.float32)
            if pts is None:
                continue
            score = _score_quad_multi(pts, image_area)
            if score > _CONTOUR_MIN_SCORE:
                results.append((score, order_corners(pts)))
    return results


def _mostly_inside(inner: np.ndarray, outer: np.ndarray, frac: float = 0.7) -> bool:
    """True when the smaller quad sits inside the larger one (an inner edge, not a second card)."""
    ax1, ay1 = float(inner[:, 0].min()), float(inner[:, 1].min())
    ax2, ay2 = float(inner[:, 0].max()), float(inner[:, 1].max())
    bx1, by1 = float(outer[:, 0].min()), float(outer[:, 1].min())
    bx2, by2 = float(outer[:, 0].max()), float(outer[:, 1].max())
    area_inner = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_outer = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    if area_inner <= 0 or area_inner > area_outer:
        return False
    iw = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    ih = max(0.0, min(ay2, by2) - max(ay1, by1))
    return (iw * ih) / area_inner >= frac


def _quad_iou(a: np.ndarray, b: np.ndarray) -> float:
    """Approximate IoU via bounding boxes (fast, good enough for dedup)."""
    ax1, ay1 = a[:, 0].min(), a[:, 1].min()
    ax2, ay2 = a[:, 0].max(), a[:, 1].max()
    bx1, by1 = b[:, 0].min(), b[:, 1].min()
    bx2, by2 = b[:, 0].max(), b[:, 1].max()
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter + 1e-6
    return inter / union
