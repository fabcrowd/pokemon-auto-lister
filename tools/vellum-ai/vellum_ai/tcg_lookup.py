"""PokémonTCG API cross-reference with disk cache.

Uses api.pokemontcg.io/v2 — free, no auth key required for basic queries
(1000 requests/day unauthenticated). All results are cached to
data/tcg-cache/ with a configurable TTL so repeat lookups are free.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

_CACHE_DIR = Path(
    os.environ.get(
        "TCG_CACHE_DIR",
        Path(__file__).resolve().parents[3] / "data" / "tcg-cache",
    )
)
_CACHE_TTL_SECONDS = int(os.environ.get("TCG_CACHE_TTL", str(7 * 24 * 3600)))
_API_BASE = "https://api.pokemontcg.io/v2/cards"
_TIMEOUT = 10


def _cache_path(key: str) -> Path:
    slug = hashlib.sha256(key.encode()).hexdigest()[:16]
    return _CACHE_DIR / f"{slug}.json"


def _load_cache(key: str) -> Optional[List[Dict[str, Any]]]:
    path = _cache_path(key)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - data.get("ts", 0) > _CACHE_TTL_SECONDS:
            return None
        return data["results"]
    except Exception:
        return None


def _save_cache(key: str, results: List[Dict[str, Any]]) -> None:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(key)
    try:
        path.write_text(
            json.dumps({"ts": time.time(), "results": results}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


def _fetch(params: Dict[str, str]) -> List[Dict[str, Any]]:
    qs = urlencode(params)
    url = f"{_API_BASE}?{qs}"
    req = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(req, timeout=_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return payload.get("data", [])
    except (URLError, OSError, json.JSONDecodeError):
        return []


def _normalize_number(value: Any) -> str:
    text = str(value or "").strip().lstrip("0") or "0"
    if "/" in text:
        left, _, right = text.partition("/")
        return f"{left.lstrip('0') or '0'}/{right.lstrip('0') or '0'}"
    return text


def _card_to_record(raw: Dict[str, Any]) -> Dict[str, Any]:
    set_data = raw.get("set") or {}
    images = raw.get("images") or {}
    return {
        "id": raw.get("id"),
        "name": raw.get("name"),
        "number": raw.get("number"),
        "set": set_data.get("name"),
        "setCode": set_data.get("id"),
        "imageUrl": images.get("large") or images.get("small"),
        "game": "pokemon",
        "score": 1.0,
    }


def lookup_card(
    number: str,
    set_id: Optional[str] = None,
    name_hint: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Look up cards by collector number, optionally filtered by set ID.

    Returns a list of card records ordered by relevance. Results are cached
    to disk; cached entries are reused for _CACHE_TTL_SECONDS (default 7 days).

    Args:
        number: Collector number, e.g. "4" or "4/102" or "025/165".
        set_id: TCG set ID, e.g. "base1", "sv5", "par". Optional.
        name_hint: If provided, exact-match results are ranked first.
    """
    norm = _normalize_number(number)
    bare = norm.split("/")[0] if "/" in norm else norm

    cache_key = f"num:{bare}|set:{set_id or ''}|name:{name_hint or ''}"
    cached = _load_cache(cache_key)
    if cached is not None:
        return cached

    q_parts = [f'number:"{bare}"']
    if set_id:
        q_parts.append(f'set.id:"{set_id.lower()}"')
    params: Dict[str, str] = {"q": " ".join(q_parts), "pageSize": "20"}

    raw_cards = _fetch(params)

    # If set_id was given but returned nothing, retry without it
    if not raw_cards and set_id:
        params_no_set: Dict[str, str] = {"q": f'number:"{bare}"', "pageSize": "20"}
        raw_cards = _fetch(params_no_set)

    records = [_card_to_record(c) for c in raw_cards]

    if name_hint:
        want = name_hint.strip().lower()
        for r in records:
            if r.get("name", "").lower() == want:
                r["score"] = 1.5
        records.sort(key=lambda r: -float(r.get("score") or 0))

    _save_cache(cache_key, records)
    return records


def resolve_card(
    number: str,
    set_id: Optional[str] = None,
    name_hint: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Return the single best-matching card record, or None."""
    results = lookup_card(number, set_id=set_id, name_hint=name_hint)
    if not results:
        return None
    if len(results) == 1:
        return results[0]
    # Prefer exact name match
    if name_hint:
        want = name_hint.strip().lower()
        exact = [r for r in results if r.get("name", "").lower() == want]
        if len(exact) == 1:
            return exact[0]
    # Prefer set_id match when provided
    if set_id:
        matched = [r for r in results if (r.get("setCode") or "").lower() == set_id.lower()]
        if len(matched) == 1:
            return matched[0]
    return results[0]
