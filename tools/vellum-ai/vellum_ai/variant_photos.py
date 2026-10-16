"""Save real photographs of physical cards, labeled from the listing title.

ShopGoodwill listing photos are pictures of cards on a table or in a sleeve.
Official card renders and anything the title calls a scan or a proxy are not
collected. One listing is one physical card, so every crop from it shares a
label and stays together when the set is split.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np

from vellum_ai.detect import CLASS_FULL_CARD, DEFAULT_ONNX
from vellum_ai.detect_multi import _detect_onnx_letterboxed
from vellum_ai.variant_labels import variant_labels

ROOT = Path(__file__).resolve().parents[3]
PHOTO_ROOT = ROOT / "data" / "variant-photos"
CROP_DIR = PHOTO_ROOT / "crops"
MANIFEST = PHOTO_ROOT / "manifest.jsonl"
GOODWILL = ROOT / "data" / "detect-marketplace" / "goodwill"

QUERIES = (
    "pokemon 1st edition",
    "pokemon shadowless",
    "pokemon reverse holo",
    "pokemon unlimited holo",
    "pokemon non-holo",
    "pokemon prerelease card",
    "pokemon staff card",
    "pokemon league promo",
    "pokemon stamped",
    "black star league promo",
)
OUT_W, OUT_H = 750, 1050
MIN_CARD_PX = 400
_UA = "Mozilla/5.0"
_IMAGE_HOSTS = {"shopgoodwillimages.azureedge.net"}
_MAX_PHOTO_BYTES = 20_000_000


def card_crops(image_bgr: np.ndarray) -> list[np.ndarray]:
    """Fronts of cards in one photograph, each resized the way the extension crops.

    A card back, a corner, or a card too small to show a stamp is left out.
    More than two fronts means the photo is a pile, not one card.
    """
    hits = [
        hit for hit in _detect_onnx_letterboxed(image_bgr, Path(DEFAULT_ONNX))
        if hit["class_id"] == CLASS_FULL_CARD and (hit["box"][3] - hit["box"][1]) >= MIN_CARD_PX
    ]
    if not hits or len(hits) > 2:
        return []
    crops = []
    for hit in hits:
        x1, y1, x2, y2 = (int(round(v)) for v in hit["box"])
        x1, y1 = max(0, x1), max(0, y1)
        card = image_bgr[y1:y2, x1:x2]
        if card.size == 0:
            continue
        crops.append(cv2.resize(card, (OUT_W, OUT_H), interpolation=cv2.INTER_AREA))
    return crops


def _request(url: str, body: bytes | None = None) -> dict:
    headers = {"accept": "application/json", "user-agent": _UA}
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def search_listings(query: str, pages: int = 3, days_back: str = "90") -> Iterator[tuple[str, str]]:
    """Closed ShopGoodwill listings for one search, as (item id, title)."""
    for page in range(1, pages + 1):
        payload = {
            "searchText": query, "selectedGroup": "", "selectedCategoryIds": "",
            "selectedSellerIds": "", "lowPrice": "0", "highPrice": "999999",
            "searchBuyNowOnly": "", "searchPickupOnly": "false", "searchNoPickupOnly": "false",
            "searchOneCentShippingOnly": "false", "searchDescriptions": "false",
            "searchClosedAuctions": "true", "closedAuctionEndingDate": date.today().strftime("%m/%d/%Y"),
            "closedAuctionDaysBack": str(days_back), "searchCanadaShipping": "false",
            "searchInternationalShippingOnly": "false", "sortColumn": "1",
            "page": str(page), "pageSize": "40", "sortDescending": "false",
            "savedSearchId": 0, "useBuyerPrefs": "true", "searchUSOnlyShipping": "false",
            "categoryLevelNo": "1", "categoryLevel": 1, "categoryId": 0, "partNumber": "",
            "catIds": "", "isWeddingCatagory": "false", "isMultipleCategoryIds": False,
            "isFromHeaderMenuTab": False, "layout": "grid", "isFromHomePage": False,
        }
        found = _request(
            "https://buyerapi.shopgoodwill.com/api/Search/ItemListing",
            json.dumps(payload).encode("utf-8"),
        )
        items = (found.get("searchResults") or {}).get("items") or []
        if not items:
            return
        for item in items:
            yield str(item.get("itemId") or ""), str(item.get("title") or "")
        time.sleep(0.4)


def listing_id(value: object) -> str:
    """A ShopGoodwill item id. It names files, so anything but digits is refused."""
    text = str(value or "")
    if not re.fullmatch(r"\d{1,12}", text):
        raise ValueError(f"not a listing id: {text!r}")
    return text


def image_url(server: str, path: str) -> str:
    """Photo URL from the listing's own server field, which must be the image CDN."""
    base = str(server or "").rstrip("/") + "/"
    url = base + str(path).replace("\\", "/").lstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in _IMAGE_HOSTS:
        raise ValueError(f"unexpected image server: {server!r}")
    return url


def listing_photos(item_id: str) -> Iterator[tuple[str, bytes]]:
    """Photograph bytes for one listing, in the listing's own order."""
    item = _request(
        f"https://buyerapi.shopgoodwill.com/api/itemDetail/GetItemDetailModelByItemId/{listing_id(item_id)}"
    )
    server = str(item.get("imageServer") or "")
    paths = [p.strip() for p in str(item.get("imageUrlString") or "").split(";") if p.strip()]
    for index, path in enumerate(paths):
        req = urllib.request.Request(image_url(server, path), headers={"user-agent": _UA})
        with urllib.request.urlopen(req, timeout=30) as res:
            yield f"{index:02d}.jpg", res.read(_MAX_PHOTO_BYTES)
        time.sleep(0.15)


def _seen() -> set[str]:
    if not MANIFEST.is_file():
        return set()
    seen = set()
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        if line.strip():
            seen.add(str(json.loads(line)["listing"]))
    return seen


def _write_crops(listing: str, title: str, labels: dict[str, str], photos: list[tuple[str, bytes]]) -> int:
    """Crop fronts and append one manifest row per crop. Returns how many."""
    CROP_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    for name, blob in photos:
        image = cv2.imdecode(np.frombuffer(blob, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            continue
        for index, crop in enumerate(card_crops(image)):
            file_name = f"{listing}_{Path(name).stem}_{index}.jpg"
            if not cv2.imwrite(str(CROP_DIR / file_name), crop, [cv2.IMWRITE_JPEG_QUALITY, 90]):
                raise OSError(f"could not write {CROP_DIR / file_name}")
            rows.append({"listing": listing, "file": file_name, "title": title, **labels})
    # One write per listing, so a crash never leaves half a listing marked as seen.
    with MANIFEST.open("a", encoding="utf-8") as manifest:
        manifest.write("".join(json.dumps(row) + "\n" for row in rows))
    return len(rows)


def relabel_manifest() -> int:
    """Re-apply the title rules. Drops a crop whose title is a lot or a scan."""
    if not MANIFEST.is_file():
        return 0
    kept = []
    seen_files: set[str] = set()
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("file") in seen_files:
            continue
        labels = variant_labels(str(row.get("title") or ""))
        if labels is None:
            continue
        seen_files.add(row["file"])
        for key in ("edition", "finish", "stamp"):
            row.pop(key, None)
        row.update(labels)
        kept.append(row)
    staged = MANIFEST.with_suffix(".jsonl.tmp")
    staged.write_text("".join(json.dumps(row) + "\n" for row in kept), encoding="utf-8")
    os.replace(staged, MANIFEST)
    return len(kept)


def harvest_local() -> int:
    """Label photographs already saved under data/detect-marketplace/goodwill."""
    seen = _seen()
    total = 0
    if not GOODWILL.is_dir():
        return 0
    for folder in sorted(GOODWILL.iterdir()):
        title_path = folder / "title.txt"
        if not folder.is_dir() or not title_path.is_file() or folder.name in seen:
            continue
        title = title_path.read_text(encoding="utf-8", errors="replace")
        labels = variant_labels(title)
        if labels is None:
            continue
        photos = [(path.name, path.read_bytes()) for path in sorted(folder.glob("*.jpg"))]
        count = _write_crops(folder.name, title.strip(), labels, photos)
        total += count
        print(f"local {folder.name} {count} {labels}")
    return total


def harvest_search(
    pages: int = 3,
    limit: int = 500,
    queries: tuple[str, ...] | None = None,
    days_back: str = "90",
) -> int:
    """Download labeled single-card listings. ``limit`` caps new listings."""
    seen = _seen()
    added = 0
    crops = 0
    for query in queries or QUERIES:
        print("search", query)
        for item_id, title in search_listings(query, pages=pages, days_back=days_back):
            if not item_id or item_id in seen:
                continue
            labels = variant_labels(title)
            if labels is None:
                continue
            seen.add(item_id)
            try:
                photos = list(listing_photos(item_id))
            except (OSError, ValueError) as err:
                print("skip", item_id, err)
                continue
            count = _write_crops(item_id, title, labels, photos)
            crops += count
            added += 1
            print(f"{item_id} {count} {labels} {title[:80]}")
            if added >= limit:
                print(f"{crops} crops from {added} listings")
                return crops
    print(f"{crops} crops from {added} listings")
    return crops
