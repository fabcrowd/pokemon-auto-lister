"""Nightly pipeline: contributions/ -> community-pack.bin + manifest.json (unsigned) in --out.

    python -m pipeline.run --data data --assets assets --out out --pack-url <url> --seq <run number>

This step holds no secrets and signs nothing: the separate `sign` job verifies the output and signs the manifest
(scripts/sign_release.py). --data is only read as JSON files; nothing in it is executed or imported.
"""
import argparse
import hashlib
import json
import os
import datetime
import sys

import numpy as np

from .catalog import Catalog
from .consensus import promote
from .contributions import build_samples, load_contributions
from .embed import ClipEmbedder
from .exam import TOP_K, exam_cases, score_exam
from .manifest import build_manifest, manifest_bytes
from .pack import read_pack, write_pack
from .regression import load_regression


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


def run_pipeline(data_dir, out_dir, pins, embedder, catalog, clip_hash, catalog_hash, pack_url, seq, issued_at, regression=None):
    """Runs every stage and writes the pack and the unsigned manifest. Returns a summary dict.

    regression: (embeddings, card ids) of the fixed server-owned set, or None. Without it the manifest can never
    say improved.
    """
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

    regression_result = None
    if regression is not None and len(regression[1]):
        regression_result = score_exam(
            regression[0], regression[1], catalog, pack.card_ids, pack.dequantized(),
            ref_min=pins["reference"]["min"], ref_margin=pins["reference"]["margin"],
            high_sim=pins["highTier"]["sim"], high_gap=pins["highTier"]["gap"],
        )
        regression_result = {k: regression_result[k] for k in ("before", "after", "n")}

    manifest = build_manifest(pins, clip_hash, catalog_hash, len(pack.card_ids), pack_bytes, pack_url, exam, regression_result, seq, issued_at)
    raw = manifest_bytes(manifest)

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "community-pack.bin"), "wb") as f:
        f.write(pack_bytes)
    with open(os.path.join(out_dir, "manifest.json"), "wb") as f:
        f.write(raw)

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
    ap.add_argument("--seq", type=int, required=True, help="the workflow run number; only ever goes up")
    ap.add_argument("--regression", default="regression.npz", help="fixed regression set (scripts/build_regression.py); missing means never improved")
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
        pack_url=args.pack_url, seq=args.seq,
        issued_at=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        regression=load_regression(args.regression) if os.path.exists(args.regression) else None,
    )
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
