"""Near-duplicate grouping of marketplace crops.

The same physical card is often relisted under a new listing id with a re-shot
or re-compressed photo. Splitting by listing id alone lets those land on both
sides of the train/holdout line, so listings are grouped first.

The hash is a 64-bit difference hash: grayscale, 9x8 Lanczos resize, one bit
per pixel brighter than its right neighbour, first bit most significant. Only
Python hashes are compared with each other; sharp resizes photos differently
from PIL, so these values are not interchangeable with scripts/lib/dhash.mjs.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

COLS = 9
ROWS = 8
MAX_DISTANCE = 6
MAX_PIXELS = 50_000_000
# A hash this lopsided, or a thumbnail this flat, is a blank or washed-out crop
# that would match unrelated cards.
MIN_SET_BITS = MAX_DISTANCE + 1
MAX_SET_BITS = 64 - MAX_DISTANCE
MIN_STD = 4.0
WARN_FRACTION = 0.05

_HASH = re.compile(r"^[0-9a-f]{16}$")


def image_signature(image: Image.Image) -> tuple[int, float]:
    """The dHash and the grayscale spread of the 9x8 thumbnail."""
    gray = np.asarray(image.convert("L").resize((COLS, ROWS), Image.LANCZOS), dtype=np.int16)
    bits = (gray[:, :-1] > gray[:, 1:]).ravel()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value, float(gray.std())


def dhash_image(image: Image.Image) -> int:
    return image_signature(image)[0]


def dhash_hex(image: Image.Image) -> str:
    return f"{dhash_image(image):016x}"


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def is_degenerate(value: int, std: float) -> bool:
    return not MIN_SET_BITS <= value.bit_count() <= MAX_SET_BITS or std < MIN_STD


def _load_cache(cache_path: Path) -> dict:
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _valid_entry(entry: object, size: int, mtime_ns: int) -> bool:
    return (
        isinstance(entry, dict)
        and entry.get("size") == size
        and entry.get("mtimeNs") == mtime_ns
        and isinstance(entry.get("hash"), str)
        and bool(_HASH.match(entry["hash"]))
        and isinstance(entry.get("std"), (int, float))
    )


def _write_cache(cache_path: Path, cache: dict) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=cache_path.parent, prefix=cache_path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(json.dumps(cache, sort_keys=True))
        os.replace(temp_name, cache_path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def file_hashes(
    files: list[str], crop_dir: Path, cache_path: Path
) -> tuple[dict[str, tuple[int, float]], Counter]:
    """Hash and spread of each readable crop, cached by name, size, and mtime.

    Also counts the crops skipped as missing, undecodable, or oversized.
    Entries for files outside this call are kept: set_symbol hashes a subset.
    """
    cache = _load_cache(cache_path)
    dirty = False
    hashes: dict[str, tuple[int, float]] = {}
    skipped: Counter = Counter()
    for name in dict.fromkeys(files):
        path = crop_dir / name
        try:
            stat = path.stat()
        except OSError:
            skipped["missing"] += 1
            continue
        entry = cache.get(name)
        if _valid_entry(entry, stat.st_size, stat.st_mtime_ns):
            hashes[name] = (int(entry["hash"], 16), float(entry["std"]))
            continue
        try:
            with Image.open(path) as image:
                if image.width * image.height > MAX_PIXELS:
                    skipped["oversized"] += 1
                    continue
                value, std = image_signature(image)
        except Image.DecompressionBombError:
            skipped["oversized"] += 1
            continue
        except (OSError, ValueError):
            skipped["undecodable"] += 1
            continue
        hashes[name] = (value, std)
        cache[name] = {"size": stat.st_size, "mtimeNs": stat.st_mtime_ns, "hash": f"{value:016x}", "std": std}
        dirty = True
    if dirty:
        _write_cache(cache_path, cache)
    return hashes, skipped


def near_pairs(values: list[int], max_distance: int) -> set[tuple[int, int]]:
    """Index pairs within ``max_distance`` bits.

    The 64 bits are cut into ``max_distance + 1`` bands. Pairs that differ in at
    most ``max_distance`` bits agree on at least one whole band, so only values
    sharing a band are compared.
    """
    pairs: set[tuple[int, int]] = set()
    bands = max_distance + 1
    if bands > 64:
        buckets = {(0, 0): list(range(len(values)))}
    else:
        edges = [round(k * 64 / bands) for k in range(bands + 1)]
        buckets = {}
        for index, value in enumerate(values):
            for band in range(bands):
                low, high = edges[band], edges[band + 1]
                key = (band, (value >> low) & ((1 << (high - low)) - 1))
                buckets.setdefault(key, []).append(index)
    for members in buckets.values():
        for a in range(len(members) - 1):
            for b in range(a + 1, len(members)):
                i, j = members[a], members[b]
                if hamming(values[i], values[j]) <= max_distance:
                    pairs.add((min(i, j), max(i, j)))
    return pairs


def listing_clusters(
    rows: list[dict],
    crop_dir: Path,
    cache_path: Path,
    max_distance: int = MAX_DISTANCE,
) -> dict[str, str]:
    """Map each listing to the smallest listing id in its near-duplicate cluster.

    Two listings join when any crop of one is within ``max_distance`` bits of any
    crop of the other. A crop that is missing, unreadable, oversized, or
    degenerate joins nothing.
    """
    listings = sorted({str(row["listing"]) for row in rows})
    parent = {listing: listing for listing in listings}

    def find(node: str) -> str:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    hashes, skipped = file_hashes([row["file"] for row in rows], crop_dir, cache_path)
    hashed = []
    for row in rows:
        if row["file"] not in hashes:
            continue
        value, std = hashes[row["file"]]
        if is_degenerate(value, std):
            skipped["degenerate"] += 1
            continue
        hashed.append((str(row["listing"]), value))
    for i, j in near_pairs([value for _, value in hashed], max_distance):
        root_a, root_b = find(hashed[i][0]), find(hashed[j][0])
        if root_a != root_b:
            parent[max(root_a, root_b)] = min(root_a, root_b)
    clusters = {listing: find(listing) for listing in listings}
    largest = max(Counter(clusters.values()).values(), default=0)
    print(
        f"dhash: skipped missing {skipped['missing']} undecodable {skipped['undecodable']} "
        f"oversized {skipped['oversized']} degenerate {skipped['degenerate']}; "
        f"largest cluster {largest} of {len(listings)} listings"
    )
    if largest > WARN_FRACTION * len(listings):
        print(
            f"warning: largest near-duplicate cluster holds {largest} of {len(listings)} listings; "
            "check for blank or generic crops",
            file=sys.stderr,
        )
    return clusters
