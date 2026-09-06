"""Identity-weighted scoring for multi-card detect + identify.

Box IoU is a means. The product is a verified card ID (name + number, and
set/setCode when both sides have one). A perfect box with the wrong card
cannot pass the default gate.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

IDENTITY_WEIGHT = 0.70
IOU_WEIGHT = 0.20
COUNT_WEIGHT = 0.10
DEFAULT_GATE = 0.85
DEFAULT_IOU_THR = 0.35


def normalize_number(value: Any) -> str:
    """Normalize collector numbers so '004/102' and '4' match."""
    text = str(value or "").lower().replace(" ", "")
    if "/" in text:
        text = text.split("/", 1)[0]
    return text.lstrip("0") or "0"


def identities_match(truth: Mapping[str, Any], pred: Mapping[str, Any]) -> bool:
    """Return True when pred matches a verified ID (name + number, optional set)."""
    truth_name = str(truth.get("name") or "").strip().lower()
    pred_name = str(pred.get("name") or "").strip().lower()
    if not truth_name or truth_name != pred_name:
        return False
    if not normalize_number(truth.get("number")) == normalize_number(pred.get("number")):
        return False
    truth_set = str(truth.get("setCode") or truth.get("set") or "").strip().lower()
    pred_set = str(pred.get("setCode") or pred.get("set") or "").strip().lower()
    if truth_set and pred_set and truth_set != pred_set:
        return False
    return True


def box_iou(
    a: Sequence[float],
    b: Sequence[float],
) -> float:
    ax1, ay1, ax2, ay2 = (float(v) for v in a)
    bx1, by1, bx2, by2 = (float(v) for v in b)
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / (union + 1e-6)


def score_scene(
    truth: Sequence[Mapping[str, Any]],
    preds: Sequence[Mapping[str, Any]],
    *,
    iou_thr: float = DEFAULT_IOU_THR,
) -> Dict[str, Any]:
    """Score a multi-card scene. Each truth/pred mapping needs identity fields
    and a ``box`` of (x1, y1, x2, y2).

    Returns score in [0, 1] plus breakdown. Identity recall is 70% of the score.
    """
    n_gt = len(truth)
    n_pred = len(preds)
    matched: set[int] = set()
    identity_hits = 0
    ious: List[float] = []

    for gt in truth:
        best_j = -1
        best_iou = 0.0
        for j, pred in enumerate(preds):
            if j in matched:
                continue
            iou = box_iou(gt["box"], pred["box"])
            if iou > best_iou:
                best_iou = iou
                best_j = j
        if best_j < 0 or best_iou < iou_thr:
            continue
        matched.add(best_j)
        ious.append(best_iou)
        if identities_match(gt, preds[best_j]):
            identity_hits += 1

    identity_recall = identity_hits / n_gt if n_gt else 0.0
    mean_iou = sum(ious) / len(ious) if ious else 0.0
    denom = max(n_gt, 1)
    count_acc = 1.0 - min(1.0, abs(n_pred - n_gt) / denom)
    score = (
        IDENTITY_WEIGHT * identity_recall
        + IOU_WEIGHT * mean_iou
        + COUNT_WEIGHT * count_acc
    )
    return {
        "score": float(score),
        "identity_recall": float(identity_recall),
        "identity_hits": identity_hits,
        "mean_iou": float(mean_iou),
        "count_acc": float(count_acc),
        "n_gt": n_gt,
        "n_pred": n_pred,
        "passes_gate": score >= DEFAULT_GATE,
    }


def score_identity_list(
    truth: Sequence[Mapping[str, Any]],
    preds: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Score verified IDs when box labels are missing (marketplace lot photos).

    A recovered name+number counts as IoU 1.0 for that card so identity still
    carries 70% of the score and a wrong card cannot pass the gate.
    """
    remaining = list(preds)
    identity_hits = 0
    for gt in truth:
        found_i = None
        for i, pred in enumerate(remaining):
            if identities_match(gt, pred):
                found_i = i
                break
        if found_i is not None:
            identity_hits += 1
            remaining.pop(found_i)

    n_gt = len(truth)
    n_pred = len(preds)
    identity_recall = identity_hits / n_gt if n_gt else 0.0
    mean_iou = identity_recall
    count_acc = 1.0 - min(1.0, abs(n_pred - n_gt) / max(n_gt, 1))
    score = (
        IDENTITY_WEIGHT * identity_recall
        + IOU_WEIGHT * mean_iou
        + COUNT_WEIGHT * count_acc
    )
    return {
        "score": float(score),
        "identity_recall": float(identity_recall),
        "identity_hits": identity_hits,
        "mean_iou": float(mean_iou),
        "count_acc": float(count_acc),
        "n_gt": n_gt,
        "n_pred": n_pred,
        "passes_gate": score >= DEFAULT_GATE,
    }
