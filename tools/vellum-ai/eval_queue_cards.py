#!/usr/bin/env python3
"""
Eval VellumAI against queue cards that already have PokeGrade identities.

Usage (from tools/vellum-ai):
  .venv\\Scripts\\python eval_queue_cards.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUEUE = ROOT / "data" / "queue"

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vellum_ai.pipeline import identify_image_bytes  # noqa: E402


def load_cards():
    cards = []
    for path in sorted(QUEUE.glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        front = record.get("frontImagePath")
        identity = (record.get("pricedCache") or {}).get("identity") or {}
        if not front or not identity.get("name"):
            continue
        cards.append(
            {
                "id": record.get("id"),
                "front": front,
                "truth": {
                    "name": identity.get("name"),
                    "set": identity.get("set"),
                    "setCode": identity.get("setCode"),
                    "number": identity.get("number"),
                },
            }
        )
    return cards


def numbers_match(a, b) -> bool:
    def norm(v):
        s = str(v or "").lower().replace(" ", "")
        if "/" in s:
            s = s.split("/")[0]
        return s.lstrip("0") or "0"

    return norm(a) == norm(b)


def main() -> int:
    cards = load_cards()
    if not cards:
        print("No queue cards with front + identity found")
        return 2

    print(f"Evaluating {len(cards)} queue cards…\n")
    ok = 0
    for card in cards:
        front = Path(card["front"])
        truth = card["truth"]
        print(f"=== {card['id'][:8]} truth={truth['name']} {truth['number']} {truth['set']}")
        if not front.is_file():
            print(f"  MISSING FILE: {front}")
            continue
        result = identify_image_bytes(front.read_bytes())
        pred = result.get("identity") or {}
        print(f"  abstain={result.get('abstain')} reason={result.get('reason')}")
        print(f"  pred={pred.get('name')} {pred.get('number')} {pred.get('set') or pred.get('setCode')}")
        print(f"  finish={result.get('finish')} conf={result.get('confidence')}")
        qa = result.get("captureQa") or {}
        print(f"  qa glare={qa.get('glare')} blur={qa.get('blur')} box={qa.get('box')}")
        ocr = (result.get("raw") or {}).get("ocr") or {}
        print(f"  ocr={ocr}")
        cands = result.get("candidates") or []
        if cands:
            print(f"  top={[ (c.get('name'), c.get('number'), round(c.get('score') or 0, 3)) for c in cands[:3] ]}")

        match = (
            not result.get("abstain")
            and numbers_match(pred.get("number"), truth.get("number"))
            and (
                str(pred.get("name") or "").lower() == str(truth.get("name") or "").lower()
                or numbers_match(pred.get("number"), truth.get("number"))
            )
        )
        # Prefer name+number when available
        name_ok = str(pred.get("name") or "").lower() == str(truth.get("name") or "").lower()
        num_ok = numbers_match(pred.get("number"), truth.get("number"))
        hit = (not result.get("abstain")) and name_ok and num_ok
        print(f"  HIT={hit} (name_ok={name_ok} num_ok={num_ok})")
        if hit:
            ok += 1
        print()

    print(f"SCORE {ok}/{len(cards)}")
    return 0 if ok == len(cards) else 1


if __name__ == "__main__":
    raise SystemExit(main())
