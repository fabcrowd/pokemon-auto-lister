#!/usr/bin/env python3
"""Build tools/extension-wasm/data/hub-penalty.bin, the optional "reduce look-alike matches" list.

    python scripts/build-hub-penalty.py [--out PATH] [--lambda 0.5] [--k 10]

Some catalog cards (an Onix, a Mewtwo V-UNION promo, the Poke Ball trainers) sit close to many real photos
of other cards and win matches they should not. For every catalog row this takes the mean cosine to its k
nearest real-world card crops (CSLS hubness correction), centres it on the physical-card mean and scales
it by lambda. The extension ranks by `cosine - penalty` and still reports the plain cosine.

Output: one signed byte per catalog row, in catalog row order, 1 unit = 0.001 cosine, clamped to +-127.

Inputs (all under data/, none of them the sealed test set):
  data/variant-photos/crops/*.jpg       cropped listing photos (the labelled "variant" set, names only)
  data/edition-crops/*.jpg              edition-stamp crops
  data/harvest/*.json + .jpg            marketplace frames with proposed card boxes
Left out on purpose: the reviewed HiBid lot photos under data/detect-hibid-real. They are the evaluation
set for this feature, and harvest frames from the same listings are skipped too. data/sealed-test and
data/realworld are never read.

Rebuild it whenever any of these change, because the file is only meaningful for one embedder, crop and catalog:
  - the CLIP model (clip_visual_int8.onnx) or lib/embed.js (EMBEDDING_VERSION),
  - the catalog (catalog.bin.gz / meta.json: row order is the file's only key),
  - the crop sets above.
The script refuses a model, catalog or meta.json that differs from the sha256 pinned in lib/setup.js. The
file is local, not a release asset: tools/extension-wasm/data/ is gitignored like the models, and a build
without it simply has no effect (the options page says so). The extension also ignores a file whose row
count differs from the catalog's, but it cannot tell two catalogs of equal size apart.
"""
import argparse
import glob
import gzip
import hashlib
import json
import os
import re

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETUP_JS = os.path.join(ROOT, "tools", "extension-wasm", "lib", "setup.js")
DIGITAL = re.compile(r"^(A\d|B\d|P-A)")  # TCG Pocket ids; search.js physicalHits drops them too
UNIT = 0.001
DIM = 512
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def pinned_hashes():
    """sha256 pins of the shipped model files, read from lib/setup.js so there is one source of truth."""
    text = open(SETUP_JS, encoding="utf-8").read()
    pins = {}
    for m in re.finditer(r'name:\s*"([^"]+)",.*?sha256:\s*"([0-9a-f]{64})"', text, re.S):
        pins.setdefault(m.group(1), m.group(2))
    return pins


def penalty_bytes(sims, physical, k, lam):
    """sims: crops x catalog cosines. physical: bool per catalog row. Returns one int8 per catalog row."""
    k = min(k, sims.shape[0])
    nearest = -np.partition(-sims, k - 1, axis=0)[:k]  # the k largest per catalog row
    hubness = nearest.mean(axis=0)
    penalty = lam * (hubness - hubness[physical].mean())
    return np.clip(np.round(penalty / UNIT), -127, 127).astype(np.int8).tobytes()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check_pinned(path, name, pins):
    if name not in pins:
        raise SystemExit(f"{name} has no sha256 pin in lib/setup.js")
    if sha256(path) != pins[name]:
        raise SystemExit(f"{path} is not the pinned release of {name} (lib/setup.js); the penalty would not fit the shipped catalog")


def load_embedder(model_path):
    import onnxruntime as ort
    from PIL import Image

    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    def embed(card):
        """Same crop as lib/embed.js: centred square of the top 45% of the card, to 224x224."""
        card = card.convert("RGB")
        w, h = card.size
        strip = max(1, int(h * 0.45))
        side = min(w, strip)
        sx, sy = (w - side) // 2, (strip - side) // 2
        art = card.crop((sx, sy, sx + side, sy + side)).resize((224, 224), Image.BICUBIC)
        x = ((np.asarray(art, dtype=np.float32) / 255 - MEAN) / STD).transpose(2, 0, 1)[None]
        v = session.run(None, {input_name: x})[0].reshape(-1).astype(np.float32)
        return v / (np.linalg.norm(v) or 1.0)

    return embed


def hibid_listings(data):
    listings = set()
    for f in glob.glob(os.path.join(data, "detect-hibid-real", "*", "*.json")):
        if f.endswith("proposal.json") or f.endswith("meta.json"):
            continue
        listings.add(os.path.basename(os.path.dirname(f)))
    return listings


def crop_vectors(data, embed):
    from PIL import Image

    vectors, counts = [], {"variant": 0, "edition": 0, "harvest": 0}

    def add(img, kind):
        if img.width < 16 or img.height < 16:
            return
        vectors.append(embed(img))
        counts[kind] += 1

    for kind, pattern in (("variant", "variant-photos/crops/*.jpg"), ("edition", "edition-crops/*.jpg")):
        for path in sorted(glob.glob(os.path.join(data, pattern))):
            img = Image.open(path)
            img.load()
            add(img, kind)

    skip = hibid_listings(data)
    for meta_path in sorted(glob.glob(os.path.join(data, "harvest", "*.json"))):
        meta = json.load(open(meta_path, encoding="utf-8"))
        if any(listing in meta.get("origin", "") for listing in skip):
            continue
        jpg = meta_path[:-5] + ".jpg"
        if not os.path.exists(jpg):
            continue
        img = Image.open(jpg)
        img.load()
        for box in meta.get("boxes", []):
            x1, y1, x2, y2 = (int(round(c)) for c in box)
            x1, y1, x2, y2 = max(0, x1), max(0, y1), min(img.width, x2), min(img.height, y2)
            if x2 - x1 >= 16 and y2 - y1 >= 16:
                add(img.crop((x1, y1, x2, y2)), "harvest")
    return np.stack(vectors).astype(np.float32), counts


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(ROOT, "tools", "extension-wasm", "data", "hub-penalty.bin"))
    ap.add_argument("--data", default=os.path.join(ROOT, "data"))
    ap.add_argument("--model", default=os.path.join(ROOT, "clip_visual_int8.onnx"))
    ap.add_argument("--catalog", default=None, help="catalog.bin.gz (default data/card-catalog/catalog.bin.gz)")
    ap.add_argument("--meta", default=None, help="meta.json that matches the shipped catalog (default data/card-catalog-backup-2026-10-11/meta.json)")
    ap.add_argument("--lambda", dest="lam", type=float, default=0.5)
    ap.add_argument("--k", type=int, default=10)
    args = ap.parse_args()

    catalog_path = args.catalog or os.path.join(args.data, "card-catalog", "catalog.bin.gz")
    meta_path = args.meta or os.path.join(args.data, "card-catalog-backup-2026-10-11", "meta.json")
    pins = pinned_hashes()
    check_pinned(args.model, "clip_visual_int8.onnx", pins)
    check_pinned(catalog_path, "catalog.bin.gz", pins)
    check_pinned(meta_path, "meta.json", pins)

    catalog = np.frombuffer(gzip.open(catalog_path).read(), dtype=np.float32).reshape(-1, DIM)
    meta = json.load(open(meta_path, encoding="utf-8"))
    if len(meta) != len(catalog):
        raise SystemExit(f"meta.json has {len(meta)} rows, catalog has {len(catalog)}")
    physical = np.array([not DIGITAL.match(str(m.get("id", ""))) for m in meta])

    vectors, counts = crop_vectors(args.data, load_embedder(args.model))
    data = penalty_bytes(vectors @ catalog.T, physical, args.k, args.lam)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(data)
    values = np.frombuffer(data, dtype=np.int8)
    print(f"{len(values)} rows from {len(vectors)} crops {counts}, k={args.k}, lambda={args.lam}")
    print(f"penalty range {values.min() * UNIT:+.3f} .. {values.max() * UNIT:+.3f}; wrote {args.out}")


if __name__ == "__main__":
    main()
