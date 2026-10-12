#!/usr/bin/env python3
"""End-to-end score on reviewed real lot photos: find the right card, then price it.

Sidecars (``<photo>.json``) need ``reviewed: true``, pixel ``boxes`` and a
parallel ``ids`` list of catalog ids (``null`` = card present but unreadable;
counted for detection only). Runs the shipped ``identify_all_from_bytes`` path.

Per ground-truth card with an id:
  exact    detected (IoU ≥ 0.5) and identified as that exact catalog id
  lenient  same name + collector number (reprint in another set)
  priced   exact and ``prices.json`` holds a price verified as that product
           (written by ``scripts/price-eval-ids.mjs`` from this script's report)

Usage (from tools/vellum-ai):
    python detect/eval_lots.py --data ../../data/detect-hibid-real --split test --report ../../.tmp/lots-report.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from eval_real import in_ignore, iou  # noqa: E402

REPO_ROOT = HERE.parent.parent.parent
DEFAULT_META = REPO_ROOT / "data" / "card-catalog" / "meta.full.json"
_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def _same_print_family(a: str | None, b: str | None, meta: dict) -> bool:
    if not a or not b:
        return False
    ma, mb = meta.get(a), meta.get(b)
    if not ma or not mb:
        return a == b
    norm = lambda v: str(v or "").lower().split("/")[0].lstrip("0")  # noqa: E731
    return ma["name"].lower() == mb["name"].lower() and norm(ma["number"]) == norm(mb["number"])


def score_image(preds, truth_boxes, truth_ids, priced: set, meta: dict, iou_thr: float = 0.5,
                ignore=None) -> dict:
    """preds: list of (box, predicted_id_or_None)."""
    pairs = sorted(
        ((iou(p[0], t), pi, ti) for pi, p in enumerate(preds) for ti, t in enumerate(truth_boxes)),
        reverse=True,
    )
    match: dict[int, int] = {}
    used_p: set[int] = set()
    for score, pi, ti in pairs:
        if score < iou_thr:
            break
        if pi in used_p or ti in match:
            continue
        used_p.add(pi)
        match[ti] = pi

    s = {"cards": 0, "exact": 0, "lenient": 0, "priced": 0, "detected": len(match),
         "unreadable": 0, "truth_boxes": len(truth_boxes),
         "false_positives": sum(1 for pi, p in enumerate(preds) if pi not in used_p and not in_ignore(p[0], ignore))}
    for ti, truth in enumerate(truth_ids):
        if truth is None:
            s["unreadable"] += 1
            continue
        s["cards"] += 1
        pred = preds[match[ti]][1] if ti in match else None
        if pred == truth:
            s["exact"] += 1
            if truth in priced:
                s["priced"] += 1
        if pred == truth or _same_print_family(pred, truth, meta):
            s["lenient"] += 1
    return s


def summarize(rows: list[dict]) -> dict:
    tot = {k: sum(r[k] for r in rows) for k in rows[0]} if rows else {}
    cards = tot.get("cards", 0) or 1
    return {
        **tot,
        "images": len(rows),
        "find_accuracy": tot.get("exact", 0) / cards,
        "lenient_accuracy": tot.get("lenient", 0) / cards,
        "price_accuracy": tot.get("priced", 0) / cards,
        "detect_recall": tot.get("detected", 0) / (tot.get("truth_boxes", 0) or 1),
    }


def load_items(data_dir: Path, split: str | None) -> list[tuple[Path, dict]]:
    items = []
    for img in sorted(p for p in data_dir.rglob("*") if p.suffix.lower() in _EXTS):
        try:
            meta = json.loads(img.with_suffix(".json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if meta.get("reviewed") is not True or "ids" not in meta:
            continue
        if split and meta.get("split") != split:
            continue
        items.append((img, meta))
    return items


def priced_ids(prices: dict) -> set:
    return {k for k, v in prices.items() if isinstance(v, dict) and v.get("correct") and v.get("market")}


def identity_record(identity: dict | None) -> dict | None:
    if not identity:
        return None
    return {k: identity.get(k) for k in ("name", "set", "number")}


def _pred_id(identity: dict | None) -> str | None:
    if not identity:
        return None
    if identity.get("productId"):
        return str(identity["productId"])
    if identity.get("setCode") and identity.get("number"):
        return f"{identity['setCode']}-{identity['number']}"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--split", default=None, help="Only sidecars with this split (train/test)")
    parser.add_argument("--prices", type=Path, default=None,
                        help="JSON {id: {market, correct}}; default <data>/prices.json")
    parser.add_argument("--meta", type=Path, default=DEFAULT_META)
    parser.add_argument("--report", type=Path, default=None)
    args = parser.parse_args()

    sys.path.insert(0, str(HERE.parent))
    from vellum_ai.identify_multi import identify_all_from_bytes  # noqa: PLC0415

    meta = {m["id"]: m for m in json.loads(args.meta.read_text(encoding="utf-8"))}
    prices_path = args.prices or args.data / "prices.json"
    prices = json.loads(prices_path.read_text(encoding="utf-8")) if prices_path.exists() else {}
    priced = priced_ids(prices)

    rows, report = [], []
    for img, side in load_items(args.data, args.split):
        results = identify_all_from_bytes(img.read_bytes(), source_image=img.name)
        preds = [(list(r.box), _pred_id(r.identity)) for r in results]
        s = score_image(preds, side["boxes"], side["ids"], priced, meta, ignore=side.get("ignore"))
        rows.append(s)
        report.append({"image": img.relative_to(args.data).as_posix(), "truth": side["ids"],
                       "gt_boxes": side["boxes"], "ignore": side.get("ignore"), "preds": preds,
                       "identities": [identity_record(r.identity) for r in results],
                       "reasons": [r.reason for r in results], **s})
        print(f"  {img.relative_to(args.data)}: cards={s['cards']} exact={s['exact']} "
              f"lenient={s['lenient']} detected={s['detected']}/{s['truth_boxes']} fp={s['false_positives']}")

    summary = summarize(rows)
    if args.report:
        args.report.write_text(json.dumps({"summary": summary, "images": report}, indent=1), encoding="utf-8")
    print(json.dumps({k: round(v, 3) if isinstance(v, float) else v for k, v in summary.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
