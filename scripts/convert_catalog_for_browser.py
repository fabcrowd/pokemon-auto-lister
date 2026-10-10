"""
Convert embeddings.npy → catalog.bin.gz for browser use.

Reads:  data/card-catalog/embeddings.npy  (22070 × 512, float32)
        data/card-catalog/meta.json        (array of card metadata)
Writes: catalog.bin.gz   — raw float32 little-endian, gzip compressed
        id_map.json       — [index → cardID string]

Both output files go in data/card-catalog/ and must be uploaded to GitHub Release v2.0.
"""

import gzip
import json
import os
import struct
import numpy as np

CATALOG_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "card-catalog")
EMB_PATH    = os.path.join(CATALOG_DIR, "embeddings.npy")
META_PATH   = os.path.join(CATALOG_DIR, "meta.json")
BIN_GZ_PATH = os.path.join(CATALOG_DIR, "catalog.bin.gz")
IDMAP_PATH  = os.path.join(CATALOG_DIR, "id_map.json")


def main():
    print(f"Loading {EMB_PATH} …")
    embeddings = np.load(EMB_PATH)
    print(f"  shape: {embeddings.shape}, dtype: {embeddings.dtype}")

    if embeddings.dtype != np.float32:
        embeddings = embeddings.astype(np.float32)

    # L2-normalize every row so browser can use raw dot-product as cosine similarity
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    embeddings = (embeddings / norms).astype(np.float32)

    raw_bytes = embeddings.astype("<f4").tobytes()  # little-endian float32
    print(f"  raw bytes: {len(raw_bytes):,}")

    print(f"Writing {BIN_GZ_PATH} …")
    with gzip.open(BIN_GZ_PATH, "wb", compresslevel=9) as f:
        f.write(raw_bytes)
    gz_mb = os.path.getsize(BIN_GZ_PATH) / 1_000_000
    print(f"  compressed: {gz_mb:.1f} MB")

    print(f"Loading {META_PATH} …")
    with open(META_PATH, encoding="utf-8") as f:
        meta = json.load(f)

    if len(meta) != embeddings.shape[0]:
        raise ValueError(
            f"meta.json has {len(meta)} entries but embeddings has {embeddings.shape[0]} rows"
        )

    id_map = [card["id"] for card in meta]
    print(f"Writing {IDMAP_PATH} …")
    with open(IDMAP_PATH, "w", encoding="utf-8") as f:
        json.dump(id_map, f, separators=(",", ":"))
    idmap_kb = os.path.getsize(IDMAP_PATH) / 1_000
    print(f"  {idmap_kb:.0f} KB")

    print("\nDone. Upload these files to GitHub Release v2.0:")
    print(f"  {BIN_GZ_PATH}")
    print(f"  {IDMAP_PATH}")
    print(f"  {META_PATH}  (also upload meta.json)")


if __name__ == "__main__":
    main()
