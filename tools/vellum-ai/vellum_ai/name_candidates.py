"""Catalog prints by OCR'd card name — a retrieval path that does not depend on CLIP.

On real lot photos CLIP often misses the true card entirely (not in its top 300),
while geometric verification against the right print still finds 60-160 inliers.
The name printed at the top of the card narrows the search to a handful of prints.
"""

from __future__ import annotations

import difflib
import re
from functools import lru_cache
from typing import Any, Dict, List, Sequence

from .local_verify import is_digital_only

_MIN_KEY = 4
_FUZZY_CUTOFF = 0.85


def _key(text: Any) -> str:
    return re.sub(r"[^a-z]", "", str(text or "").lower())


class NameIndex:
    def __init__(self, meta: Sequence[Dict[str, Any]]) -> None:
        self.by_key: Dict[str, List[Dict[str, Any]]] = {}
        for row in meta:
            if is_digital_only(row.get("id")):
                continue
            key = _key(row.get("name"))
            if len(key) >= _MIN_KEY:
                self.by_key.setdefault(key, []).append(row)
        self.keys = sorted(self.by_key, key=len, reverse=True)

    def _keys_in_line(self, line: str) -> List[str]:
        line_key = _key(line)
        if len(line_key) < _MIN_KEY:
            return []
        found = [k for k in self.keys if k in line_key]
        # "Kadabra" also contains "Abra": keep only names not inside a longer match.
        found = [k for k in found if not any(k != other and k in other for other in found)]
        if found:
            return found
        return difflib.get_close_matches(line_key, self.keys, n=1, cutoff=_FUZZY_CUTOFF)

    def candidates(self, lines: Sequence[str]) -> List[Dict[str, Any]]:
        keys: List[str] = []
        for line in lines:
            for key in self._keys_in_line(str(line)):
                if key not in keys:
                    keys.append(key)
        return [row for key in keys for row in self.by_key[key]]


@lru_cache(maxsize=1)
def get_name_index() -> NameIndex:
    from .retrieve import get_index  # noqa: PLC0415

    index = get_index()
    index.load()
    return NameIndex(index.meta)
