#!/usr/bin/env python3
"""Model-assisted labelling with an explicit review step.

1. ``propose``: run the current detector on unlabelled photos and write
   ``<photo>.proposal.json`` (never a training label) plus numbered overlay
   contact sheets for review.
2. ``apply``: read a decisions file (``<relative photo path><TAB><decision>``)
   and write ``<photo>.json`` sidecars with ``reviewed: true``.

Decisions: ``ok`` (accept all proposals), ``neg`` (reviewed, no cards),
``skip`` (exclude — e.g. piles too dense to box), or any mix of
``drop:i,j``, ``ignore:i,j`` (cut-off cards: neither hit nor miss) and
``add:[x1,y1,x2,y2]`` (source-pixel boxes).

Usage (from tools/vellum-ai):
    python detect/review_proposals.py propose --data ../../data/detect-hibid-real --sheets ../../.tmp/review
    python detect/review_proposals.py apply --data ../../data/detect-hibid-real --decisions decisions.tsv
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = HERE.parent / "models" / "card_detect.onnx"
_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
_ADD = re.compile(r"add:\[([^\]]+)\]")


def apply_decision(decision: str, proposal: list) -> list | None:
    decision = decision.strip()
    if decision == "ok":
        return [list(b) for b in proposal]
    if decision == "neg":
        return []
    if decision == "skip":
        return None
    dropped: set[int] = set(_indices(decision, "ignore:"))
    added: list[list[float]] = []
    rest = _ADD.sub("", decision)
    for m in _ADD.finditer(decision):
        added.append([float(v) if "." in v else int(v) for v in m.group(1).split(",")])
    for token in rest.split():
        if token.startswith("drop:"):
            dropped.update(int(i) for i in token[5:].split(",") if i)
        elif not token.startswith("ignore:"):
            raise ValueError(f"Unknown decision token: {token!r}")
    if not dropped and not added:
        raise ValueError(f"Empty decision: {decision!r}")
    return [list(b) for i, b in enumerate(proposal) if i not in dropped] + added


def _indices(decision: str, prefix: str) -> list[int]:
    return [int(i) for tok in decision.split() if tok.startswith(prefix) for i in tok[len(prefix):].split(",") if i]


def ignored_boxes(decision: str, proposal: list) -> list:
    return [list(proposal[i]) for i in _indices(decision, "ignore:")]


def write_reviewed(data_dir: Path, decisions: dict[str, str], note: str) -> int:
    written = 0
    for rel, decision in decisions.items():
        img = data_dir / rel
        proposal_path = img.with_name(img.stem + ".proposal.json")
        proposal = json.loads(proposal_path.read_text(encoding="utf-8"))["boxes"] if proposal_path.exists() else []
        boxes = apply_decision(decision, proposal)
        if boxes is None:
            continue
        sidecar = {"reviewed": True, "boxes": boxes, "ignore": ignored_boxes(decision, proposal),
                   "review_note": note, "decision": decision}
        img.with_suffix(".json").write_text(json.dumps(sidecar), encoding="utf-8")
        written += 1
    return written


def _images(data_dir: Path) -> list[Path]:
    return sorted(p for p in data_dir.rglob("*") if p.suffix.lower() in _EXTS)


def _pending(data_dir: Path, only: set[str] | None) -> list[Path]:
    return [
        p for p in _images(data_dir)
        if (only is None or p.relative_to(data_dir).as_posix() in only)
        and not p.with_suffix(".json").exists() and not p.with_name(p.stem + ".proposal.json").exists()
    ]


def propose(data_dir: Path, sheets_dir: Path, weights: Path, conf: float, per_sheet: int,
            only: set[str] | None = None) -> int:
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    sys.path.insert(0, str(HERE.parent))
    sys.path.insert(0, str(HERE))
    import vellum_ai.detect_multi as detect_multi  # noqa: PLC0415
    from vellum_ai.detect_multi import pad_to_square, unpad_box  # noqa: PLC0415

    detect_multi._CONF_THRESHOLD = conf
    sheets_dir.mkdir(parents=True, exist_ok=True)
    pending = _pending(data_dir, only)
    tiles, index_lines, sheet_no = [], [], 0

    def flush():
        nonlocal tiles, sheet_no
        if not tiles:
            return
        cols = 4
        rows = (len(tiles) + cols - 1) // cols
        sheet = np.full((rows * 420, cols * 420, 3), 255, np.uint8)
        for i, t in enumerate(tiles):
            y, x = (i // cols) * 420, (i % cols) * 420
            sheet[y:y + t.shape[0], x:x + t.shape[1]] = t
        cv2.imwrite(str(sheets_dir / f"sheet_{sheet_no:03d}.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
        sheet_no += 1
        tiles = []

    for n, img_path in enumerate(pending):
        bgr = cv2.imread(str(img_path))
        if bgr is None:
            continue
        square, px, py = pad_to_square(bgr)
        hits = detect_multi._detect_onnx_multi(square, weights)
        boxes = [[round(v) for v in unpad_box(h["box"], px, py)] for h in hits]
        scores = [round(h["confidence"], 3) for h in hits]
        img_path.with_name(img_path.stem + ".proposal.json").write_text(
            json.dumps({"boxes": boxes, "scores": scores}), encoding="utf-8")

        vis = bgr.copy()
        lw = max(2, vis.shape[1] // 250)
        for i, b in enumerate(boxes):
            cv2.rectangle(vis, (b[0], b[1]), (b[2], b[3]), (0, 255, 0), lw)
            cv2.putText(vis, str(i), (b[0] + lw * 2, b[1] + lw * 14), cv2.FONT_HERSHEY_SIMPLEX,
                        lw * 0.6, (0, 0, 255), lw)
        scale = 400 / max(vis.shape[:2])
        vis = cv2.resize(vis, (int(vis.shape[1] * scale), int(vis.shape[0] * scale)))
        tile = np.full((420, 420, 3), 255, np.uint8)
        tile[:vis.shape[0], :vis.shape[1]] = vis
        rel = img_path.relative_to(data_dir).as_posix()
        cv2.putText(tile, f"#{n} {rel} ({bgr.shape[1]}x{bgr.shape[0]})", (2, 414),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1)
        tiles.append(tile)
        index_lines.append(f"{n}\t{rel}\t{len(boxes)}\tsheet_{sheet_no:03d}")
        if len(tiles) == per_sheet:
            flush()
    flush()
    (sheets_dir / "index.tsv").write_text("\n".join(index_lines) + "\n", encoding="utf-8")
    return len(index_lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("propose")
    p.add_argument("--data", type=Path, required=True)
    p.add_argument("--sheets", type=Path, required=True)
    p.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    p.add_argument("--conf", type=float, default=0.25)
    p.add_argument("--per-sheet", type=int, default=16)
    p.add_argument("--only", type=Path, default=None, help="Text file of image paths (relative to --data) to propose")
    a = sub.add_parser("apply")
    a.add_argument("--data", type=Path, required=True)
    a.add_argument("--decisions", type=Path, required=True)
    a.add_argument("--note", default="model proposal reviewed visually (overlay) and corrected")
    args = parser.parse_args()

    if args.cmd == "propose":
        only = set(args.only.read_text(encoding="utf-8").split()) if args.only else None
        n = propose(args.data, args.sheets, args.weights, args.conf, args.per_sheet, only)
        print(f"Proposed {n} images; sheets in {args.sheets}")
        return 0
    decisions = {}
    for line in args.decisions.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            rel, decision = line.split("\t", 1)
            decisions[rel.strip()] = decision
    print(f"Wrote {write_reviewed(args.data, decisions, args.note)} reviewed sidecars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
