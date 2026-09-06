"""Resolve identity from Collectr portfolio CSV (OCR / number match)."""

from __future__ import annotations

import csv
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

_SET_CODE_TO_NAME = {
    "por": "perfectorder",
    "cri": "chaosrising",
    "meg": "megaevolution",
}


def _default_csv() -> Path:
    env = os.environ.get("COLLECTR_CSV")
    if env:
        return Path(env)
    root = Path(__file__).resolve().parents[3]
    return root / "data" / "collectr-export.csv"


def _norm_number(value: Any) -> str:
    text = str(value or "").lower().replace(" ", "")
    if "/" in text:
        left, _, right = text.partition("/")
        left = left.lstrip("0") or "0"
        right = right.lstrip("0") or "0"
        return f"{left}/{right}"
    return text.lstrip("0") or "0"


def _norm_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


class CollectrCatalog:
    def __init__(self, csv_path: Optional[Path] = None) -> None:
        self.csv_path = Path(csv_path or _default_csv())
        self.rows: List[Dict[str, str]] = []
        self._loaded = False

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if not self.csv_path.is_file():
            return
        with self.csv_path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if str(row.get("Category") or "").lower() != "pokemon":
                    continue
                self.rows.append(row)

    def available(self) -> bool:
        self.load()
        return len(self.rows) > 0

    def candidates_for_number(self, number: str, set_hint: Optional[str] = None) -> List[Dict[str, Any]]:
        self.load()
        want = _norm_number(number)
        want_left = want.split("/")[0]
        want_full = "/" in want
        hits: List[Dict[str, Any]] = []
        for row in self.rows:
            card_num = _norm_number(row.get("Card Number"))
            if want_full:
                if card_num != want:
                    continue
            elif card_num != want and card_num.split("/")[0] != want_left:
                continue
            item = {
                "id": f"collectr:{row.get('Product Name')}:{row.get('Card Number')}",
                "name": row.get("Product Name"),
                "set": row.get("Set"),
                "setCode": None,
                "number": row.get("Card Number"),
                "game": "pokemon",
                "market": row.get("Market Price (As of 2026-08-09)") or None,
                "score": 1.0,
            }
            if set_hint:
                hint_norm = _norm_name(set_hint)
                set_norm = _norm_name(item["set"])
                mapped = _SET_CODE_TO_NAME.get(hint_norm, "")
                if hint_norm in set_norm or (mapped and mapped in set_norm):
                    item["score"] = 1.2
                else:
                    item["score"] = 0.5
            hits.append(item)
        hits.sort(key=lambda h: -float(h.get("score") or 0))
        return hits

    def resolve(self, ocr: Dict[str, Any], name_hint: Optional[str] = None) -> Optional[Dict[str, Any]]:
        number = ocr.get("number")
        if not number:
            return None
        total = ocr.get("total")
        full = f"{number}/{total}" if total else str(number)
        set_hint = ocr.get("setCode")
        hits = self.candidates_for_number(full if total else number, set_hint=set_hint)
        if not hits and total:
            hits = self.candidates_for_number(number, set_hint=set_hint)
        if not hits:
            return None
        if name_hint:
            want = _norm_name(name_hint)
            named = [h for h in hits if want and want in _norm_name(h["name"])]
            if named:
                hits = named
        if len(hits) == 1:
            return hits[0]
        exact = [h for h in hits if _norm_number(h["number"]) == _norm_number(full)]
        if len(exact) == 1:
            return exact[0]
        boosted = [h for h in hits if float(h.get("score") or 0) >= 1.0]
        if len(boosted) == 1:
            return boosted[0]
        if name_hint and hits:
            return hits[0]
        return None


_catalog: Optional[CollectrCatalog] = None


def get_collectr_catalog() -> CollectrCatalog:
    global _catalog
    if _catalog is None:
        _catalog = CollectrCatalog()
    return _catalog
