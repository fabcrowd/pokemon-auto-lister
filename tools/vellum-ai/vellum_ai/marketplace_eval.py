"""Load Facebook + HiBid multi-card photos for detect eval.

Sources, in order:
  1. tools/vellum-ai/detect/marketplace_cases.json (seed URLs / expected counts)
  2. data/sniper/state.json worklist (live cycle harvest)
  3. Already-cached JPEGs under data/detect-marketplace/{facebook|hibid}/
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MANIFEST = Path(__file__).resolve().parents[1] / "detect" / "marketplace_cases.json"
DEFAULT_CACHE = REPO_ROOT / "data" / "detect-marketplace"
DEFAULT_SNIPER_STATE = REPO_ROOT / "data" / "sniper" / "state.json"
MARKETPLACE_SOURCES = frozenset({"facebook", "hibid"})
HIBID_GRAPHQL = "https://hibid.com/graphql"
_HIBID_LOTSEARCH_QUERY = """
query LotSearch($pageNumber: Int!, $pageLength: Int!, $searchText: String, $status: AuctionLotStatus, $sortOrder: EventItemSortOrder) {
  lotSearch(
    input: { searchText: $searchText, status: $status, sortOrder: $sortOrder }
    pageNumber: $pageNumber
    pageLength: $pageLength
    sortDirection: ASC
  ) {
    pagedResults {
      results {
        id
        lead
        featuredPicture {
          thumbnailLocation
          hdThumbnailLocation
          fullSizeLocation
        }
      }
    }
  }
}
""".strip()


def hibid_lotsearch_body(query: str = "pokemon cards") -> Dict[str, Any]:
    return {
        "operationName": "LotSearch",
        "query": _HIBID_LOTSEARCH_QUERY,
        "variables": {
            "pageNumber": 1,
            "pageLength": 40,
            "searchText": query,
            "status": "OPEN",
            "sortOrder": "TIME_LEFT",
        },
    }


def fetch_hibid_lotsearch_cases(
    opener: Optional[Callable[..., Any]] = None,
    query: str = "pokemon cards",
) -> List[Dict[str, Any]]:
    """One LotSearch page → HiBid detect cases. Returns [] on network failure."""
    fetch = opener or urlopen
    body = json.dumps(hibid_lotsearch_body(query)).encode("utf-8")
    req = Request(
        HIBID_GRAPHQL,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "pokemon-auto-lister-detect/0.1",
        },
    )
    try:
        with fetch(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return []
    return cases_from_hibid_lotsearch(payload)


def source_from_item_id(item_id: str) -> Optional[str]:
    text = str(item_id or "")
    if text.startswith("hibid:"):
        return "hibid"
    if text.startswith("facebook:"):
        return "facebook"
    return None


SNIPER_LEDGERS = ("worklist", "seen", "hearted", "suspects")


def harvest_sniper_worklist(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Facebook + HiBid photos from every sniper ledger. Mercari is ignored."""
    cases: List[Dict[str, Any]] = []
    for bucket in SNIPER_LEDGERS:
        mapping = state.get(bucket) or {}
        if not isinstance(mapping, dict):
            continue
        for item_id, meta in mapping.items():
            if not isinstance(meta, dict):
                continue
            source = meta.get("source") or source_from_item_id(str(item_id))
            if source not in MARKETPLACE_SOURCES:
                continue
            urls = _unique_urls(
                list(meta.get("imageUrls") or [])
                + ([meta["imageUrl"]] if meta.get("imageUrl") else [])
            )
            if not urls:
                continue
            identities = _identities_from_meta(meta)
            cases.append(
                {
                    "source": source,
                    "itemId": str(item_id),
                    "title": meta.get("title"),
                    "listingUrl": meta.get("listingUrl"),
                    "imageUrls": urls,
                    "identities": identities,
                    "expected_min_cards": 2,
                    "ledger": bucket,
                }
            )
    return merge_cases(cases)


def load_manifest_cases(path: Path) -> List[Dict[str, Any]]:
    if not path.is_file():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw = payload.get("cases") if isinstance(payload, dict) else payload
    cases: List[Dict[str, Any]] = []
    for row in raw or []:
        source = str(row.get("source") or source_from_item_id(str(row.get("itemId") or "")))
        if source not in MARKETPLACE_SOURCES:
            continue
        urls = _unique_urls(row.get("imageUrls") or [])
        cases.append(
            {
                "source": source,
                "itemId": str(row.get("itemId") or f"{source}:unknown"),
                "title": row.get("title"),
                "listingUrl": row.get("listingUrl"),
                "imageUrls": urls,
                "identities": list(row.get("identities") or []),
                "expected_min_cards": int(row.get("expected_min_cards") or 2),
            }
        )
    return cases


def cases_from_hibid_lotsearch(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse a HiBid LotSearch GraphQL payload into detect cases (photos only)."""
    results = (
        payload.get("pagedResults", {}).get("results")
        if isinstance(payload, dict)
        else None
    )
    if results is None and isinstance(payload, dict):
        results = (
            payload.get("lotSearch", {}).get("pagedResults", {}).get("results")
            or payload.get("data", {}).get("lotSearch", {}).get("pagedResults", {}).get("results")
        )
    cases: List[Dict[str, Any]] = []
    for lot in results or []:
        if not isinstance(lot, dict) or lot.get("id") is None:
            continue
        picture = lot.get("featuredPicture") or {}
        urls = _unique_urls(
            [
                picture.get("hdThumbnailLocation"),
                picture.get("fullSizeLocation"),
                picture.get("thumbnailLocation"),
            ]
        )
        if not urls:
            continue
        lot_id = str(lot["id"])
        cases.append(
            {
                "source": "hibid",
                "itemId": f"hibid:{lot_id}",
                "title": lot.get("lead") or lot.get("title"),
                "listingUrl": f"https://hibid.com/lot/{lot_id}",
                "imageUrls": urls,
                "identities": [],
                "expected_min_cards": 2,
            }
        )
    return cases


def cases_by_source(cases: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    grouped = {"facebook": [], "hibid": []}
    for case in cases:
        source = case.get("source")
        if source in grouped:
            grouped[source].append(case)
    return grouped


def merge_cases(*groups: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_id: Dict[str, Dict[str, Any]] = {}
    for group in groups:
        for case in group:
            key = case["itemId"]
            if key not in by_id:
                by_id[key] = {**case, "imageUrls": list(case.get("imageUrls") or [])}
                continue
            existing = by_id[key]
            existing["imageUrls"] = _unique_urls(
                [*(existing.get("imageUrls") or []), *(case.get("imageUrls") or [])]
            )
            if not existing.get("identities") and case.get("identities"):
                existing["identities"] = case["identities"]
    return list(by_id.values())


def cache_image_path(cache_dir: Path, source: str, item_id: str, index: int) -> Path:
    safe = str(item_id).replace(":", "_").replace("/", "_")
    return cache_dir / source / safe / f"{index:02d}.jpg"


def list_cached_images(cache_dir: Path) -> Dict[str, List[Path]]:
    found: Dict[str, List[Path]] = {"facebook": [], "hibid": []}
    for source in MARKETPLACE_SOURCES:
        root = cache_dir / source
        if not root.is_dir():
            continue
        found[source] = sorted(
            p for p in root.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        )
    return found


def download_url(url: str, dest: Path, opener: Optional[Callable[..., Any]] = None) -> bool:
    """Download one listing photo. Returns False on any failure."""
    fetch = opener or urlopen
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = Request(url, headers={"User-Agent": "pokemon-auto-lister-detect/0.1"})
        with fetch(req, timeout=20) as resp:
            body = resp.read()
        if not body or len(body) < 32:
            return False
        dest.write_bytes(body)
        return True
    except Exception:
        return False


def materialize_cases(
    cases: List[Dict[str, Any]],
    cache_dir: Path,
    *,
    download: bool = False,
    opener: Optional[Callable[..., Any]] = None,
) -> List[Dict[str, Any]]:
    """Attach local_paths for each case, optionally downloading missing URLs."""
    ready: List[Dict[str, Any]] = []
    for case in cases:
        paths: List[Path] = []
        urls = list(case.get("imageUrls") or [])
        if urls:
            for i, url in enumerate(urls):
                dest = cache_image_path(cache_dir, case["source"], case["itemId"], i)
                if dest.is_file() or (download and download_url(url, dest, opener=opener)):
                    paths.append(dest)
        else:
            folder = cache_dir / case["source"] / str(case["itemId"]).replace(":", "_")
            if folder.is_dir():
                paths.extend(
                    sorted(
                        p
                        for p in folder.iterdir()
                        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
                    )
                )
        if not paths:
            continue
        ready.append({**case, "local_paths": paths})
    return ready


def _identities_from_meta(meta: Dict[str, Any]) -> List[Dict[str, Any]]:
    identities: List[Dict[str, Any]] = []
    seen: set[tuple] = set()
    for photo in meta.get("photosScanned") or []:
        ident = (photo or {}).get("identity")
        _add_identity(identities, seen, ident)
    _add_identity(identities, seen, meta.get("identity"))
    return identities


def _add_identity(
    identities: List[Dict[str, Any]],
    seen: set[tuple],
    ident: Any,
) -> None:
    if not isinstance(ident, dict) or not ident.get("name"):
        return
    key = (
        str(ident.get("name") or "").lower(),
        str(ident.get("number") or ""),
        str(ident.get("setCode") or ident.get("set") or ""),
    )
    if key in seen:
        return
    seen.add(key)
    identities.append(
        {
            "name": ident.get("name"),
            "number": ident.get("number"),
            "set": ident.get("set"),
            "setCode": ident.get("setCode"),
        }
    )


def _unique_urls(urls: Iterable[Any]) -> List[str]:
    out: List[str] = []
    for url in urls:
        text = str(url or "").strip()
        if text and text not in out:
            out.append(text)
    return out


