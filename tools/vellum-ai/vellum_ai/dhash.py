"""Near-duplicate grouping of marketplace crops.

The same physical card is often relisted under a new listing id with a re-shot
or re-compressed photo. Splitting by listing id alone lets those land on both
sides of the train/holdout line, so listings are grouped first.

The hash matches scripts/lib/dhash.mjs: grayscale, 9x8 Lanczos resize, one bit
per pixel brighter than its right neighbour, first bit most significant.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

COLS = 9
ROWS = 8
MAX_DISTANCE = 6

# A decompression bomb should fail the hash, not exhaust memory.
Image.MAX_IMAGE_PIXELS = 50_000_000


def dhash_image(image: Image.Image) -> int:
    gray = np.asarray(image.convert("L").resize((COLS, ROWS), Image.LANCZOS), dtype=np.int16)
    bits = (gray[:, :-1] > gray[:, 1:]).ravel()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


def dhash_hex(image: Image.Image) -> str:
    return f"{dhash_image(image):016x}"


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def _load_cache(cache_path: Path) -> dict:
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def file_hashes(files: list[str], crop_dir: Path, cache_path: Path) -> dict[str, int]:
    """Hash of each crop that exists and decodes, cached by name, size, and mtime.

    Entries for files outside this call are kept: set_symbol hashes a subset.
    """
    cache = _load_cache(cache_path)
    dirty = False
    hashes: dict[str, int] = {}
    for name in dict.fromkeys(files):
        path = crop_dir / name
        try:
            stat = path.stat()
        except OSError:
            continue
        entry = cache.get(name)
        if (
            isinstance(entry, dict)
            and entry.get("size") == stat.st_size
            and entry.get("mtimeNs") == stat.st_mtime_ns
            and isinstance(entry.get("hash"), str)
        ):
            hashes[name] = int(entry["hash"], 16)
            continue
        try:
            with Image.open(path) as image:
                value = dhash_image(image)
        except (OSError, ValueError, Image.DecompressionBombError):
            continue
        hashes[name] = value
        cache[name] = {"size": stat.st_size, "mtimeNs": stat.st_mtime_ns, "hash": f"{value:016x}"}
        dirty = True
    if dirty:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, sort_keys=True), encoding="utf-8")
    return hashes


def listing_clusters(
    rows: list[dict],
    crop_dir: Path,
    cache_path: Path,
    max_distance: int = MAX_DISTANCE,
) -> dict[str, str]:
    """Map each listing to the smallest listing id in its near-duplicate cluster.

    Two listings join when any crop of one is within ``max_distance`` bits of any
    crop of the other. A crop that is missing or unreadable joins nothing.
    """
    listings = sorted({str(row["listing"]) for row in rows})
    parent = {listing: listing for listing in listings}

    def find(node: str) -> str:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a: str, b: str) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:
            parent[max(root_a, root_b)] = min(root_a, root_b)

    hashes = file_hashes([row["file"] for row in rows], crop_dir, cache_path)
    hashed = [(str(row["listing"]), hashes[row["file"]]) for row in rows if row["file"] in hashes]
    if hashed:
        owners = [listing for listing, _ in hashed]
        values = np.array([value for _, value in hashed], dtype=np.uint64)
        for i in range(len(values) - 1):
            xor = values[i + 1:] ^ values[i]
            distance = np.unpackbits(xor.view(np.uint8).reshape(-1, 8), axis=1).sum(axis=1)
            for offset in np.nonzero(distance <= max_distance)[0]:
                union(owners[i], owners[i + 1 + int(offset)])
    return {listing: find(listing) for listing in listings}
