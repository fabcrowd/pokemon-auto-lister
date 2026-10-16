"""Nightly pipeline: contributions/ -> community-pack.bin + manifest.json + manifest.sig in --out.

    python -m pipeline.run --assets assets --out out --pack-url <release asset url>

The signing key comes from the PACK_SIGNING_KEY environment variable (PKCS8 PEM) and the run stops at once without it.
"""
import argparse
import hashlib
import json
import os
import sys

import numpy as np

from .catalog import Catalog
from .consensus import promote
from .contributions import build_samples, load_contributions
from .embed import ClipEmbedder
from .exam import TOP_K, exam_cases, score_exam
from .manifest import build_manifest, manifest_bytes
from .pack import read_pack, write_pack
from .signing import sign_bytes


def _embed(samples, embedder):
    """Samples whose crop embeds, with their vectors; the rest are dropped and counted."""
    kept, vectors = [], []
    for s in samples:
        try:
            vectors.append(np.asarray(embedder(s.crop), dtype=np.float32))
            kept.append(s)
        except ValueError:
            continue
    dim = vectors[0].shape[0] if vectors else 512
    return kept, (np.stack(vectors) if vectors else np.zeros((0, dim), dtype=np.float32)), len(samples) - len(kept)


def run_pipeline(data_dir, out_dir, pins, embedder, catalog, clip_hash, catalog_hash, signing_key, pack_url):
    """Runs every stage and writes the three release files. Returns a summary dict."""
    if not signing_key:
        raise ValueError("PACK_SIGNING_KEY is not set")
    items, dropped = load_contributions(data_dir)
    valid_ids = set(catalog.ids)

    teach, teach_emb, teach_failed = _embed(build_samples(items, valid_ids=valid_ids, split="teach"), embedder)
    if len(teach):
        idx, _ = catalog.top_k_batch(teach_emb, TOP_K)
        neighbours = [{catalog.ids[j] for j in row} for row in idx]
    else:
        neighbours = []
    promotion = promote(teach, teach_emb, neighbours)
    pack_bytes = write_pack([r.card_id for r in promotion.rows], np.stack([r.embedding for r in promotion.rows]) if promotion.rows else np.zeros((0, 512), dtype=np.float32))
    pack = read_pack(pack_bytes)

    cases = exam_cases(items, valid_ids)
    exam_samples, exam_emb, exam_failed = _embed([s for s, _ in cases], embedder)
    truths = {s.key: t for s, t in cases}
    exam = score_exam(
        exam_emb, [truths[s.key] for s in exam_samples], catalog, pack.card_ids, pack.dequantized(),
        ref_min=pins["reference"]["min"], ref_margin=pins["reference"]["margin"],
        high_sim=pins["highTier"]["sim"], high_gap=pins["highTier"]["gap"],
    )

    manifest = build_manifest(pins, clip_hash, catalog_hash, len(pack.card_ids), pack_bytes, pack_url, exam)
    raw = manifest_bytes(manifest)
    signature = sign_bytes(raw, signing_key)

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "community-pack.bin"), "wb") as f:
        f.write(pack_bytes)
    with open(os.path.join(out_dir, "manifest.json"), "wb") as f:
        f.write(raw)
    with open(os.path.join(out_dir, "manifest.sig"), "w", encoding="ascii") as f:
        f.write(signature)

    return {
        "entries": len(pack.card_ids),
        "improved": manifest["improved"],
        "exam": exam,
        "contributionsDropped": dropped,
        "embedFailed": teach_failed + exam_failed,
        **promotion.stats,
    }


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=".", help="data repo root (holds contributions/)")
    ap.add_argument("--assets", default="assets", help="folder written by scripts/fetch_assets.py")
    ap.add_argument("--out", default="out")
    ap.add_argument("--pins", default="pins.json")
    ap.add_argument("--pack-url", required=True, help="where the extension will download community-pack.bin")
    args = ap.parse_args(argv)

    with open(args.pins, encoding="utf-8") as f:
        pins = json.load(f)
    paths = {a["name"]: os.path.join(args.assets, a["name"]) for a in pins["assets"]}
    for a in pins["assets"]:
        if _sha256_file(paths[a["name"]]) != a["sha256"]:
            sys.exit(f"{a['name']} does not match its pinned sha256; refusing to run")
    hashes = {a["name"]: a["sha256"][:16] for a in pins["assets"]}

    summary = run_pipeline(
        data_dir=args.data, out_dir=args.out, pins=pins,
        embedder=ClipEmbedder(paths["clip_visual_int8.onnx"]),
        catalog=Catalog.load(paths["catalog.bin.gz"], paths["id_map.json"]),
        clip_hash=hashes["clip_visual_int8.onnx"], catalog_hash=hashes["catalog.bin.gz"],
        signing_key=os.environ.get("PACK_SIGNING_KEY", "").encode(), pack_url=args.pack_url,
    )
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
