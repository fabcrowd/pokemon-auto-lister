"""Market price lookup via pokemontcg.io v2 with 24h disk cache."""

from __future__ import annotations

import hashlib
import json
import pathlib
import time
import urllib.error
import urllib.request
from typing import Any, Dict

_PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
PRICE_CACHE_DIR = _PROJECT_ROOT / "data" / "price-cache"
_TTL = 86_400
_TCG_BASE = "https://api.pokemontcg.io/v2/cards"
_VARIANT_ORDER = ("holofoil", "normal", "reverseHolofoil", "1stEditionHolofoil", "unlimited")


def _cache_path(card_id: str) -> pathlib.Path:
    key = hashlib.sha256(card_id.encode()).hexdigest()
    return PRICE_CACHE_DIR / f"{key}.json"


def _load_cached(card_id: str) -> Dict[str, Any] | None:
    path = _cache_path(card_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        if time.time() - data.get("ts", 0) < _TTL:
            return data.get("price", {})
    except Exception:
        pass
    return None


def _save_cache(card_id: str, price: Dict[str, Any]) -> None:
    PRICE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(card_id)
    path.write_text(json.dumps({"ts": time.time(), "price": price}))


def _extract_prices(tcgplayer: Dict[str, Any]) -> Dict[str, Any]:
    prices = tcgplayer.get("prices") or {}
    for variant in _VARIANT_ORDER:
        p = prices.get(variant)
        if p and p.get("market") is not None:
            return {
                "market_price": p.get("market"),
                "price_low": p.get("low"),
                "price_high": p.get("high"),
                "price_variant": variant,
                "price_source": "tcgplayer",
            }
    return {}


def get_price(identity: Dict[str, Any]) -> Dict[str, Any]:
    """Return price dict for a card identity. Never raises."""
    set_code = str(identity.get("setCode") or "").strip()
    number = str(identity.get("number") or "").strip()
    if not set_code or not number:
        return {}

    bare = number.split("/")[0].lstrip("0") or "0"
    card_id = f"{set_code}-{bare}"

    cached = _load_cached(card_id)
    if cached is not None:
        return cached

    try:
        url = f"{_TCG_BASE}/{card_id}"
        req = urllib.request.Request(url, headers={"User-Agent": "pokemon-auto-lister/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read())
        tcgplayer = (body.get("data") or {}).get("tcgplayer") or {}
        price = _extract_prices(tcgplayer)
    except Exception:
        price = {}

    _save_cache(card_id, price)
    return price
