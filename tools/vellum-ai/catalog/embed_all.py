#!/usr/bin/env python3
"""Embed catalog images with OpenCLIP and write FAISS / npy index."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CATALOG = ROOT / "data" / "card-catalog"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--model", default="ViT-B-32")
    parser.add_argument("--pretrained", default="openai")
    args = parser.parse_args()

    meta_path = args.catalog / "meta.json"
    if not meta_path.is_file():
        raise SystemExit(f"Missing {meta_path} — run build_catalog.py first")

    import open_clip  # type: ignore
    import torch  # type: ignore
    from PIL import Image

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    model, _, preprocess = open_clip.create_model_and_transforms(
        args.model, pretrained=args.pretrained
    )
    model.eval()

    vectors = []
    kept_meta = []
    images_dir = args.catalog / "images"
    # Pre-count rows with images for progress
    candidates = []
    for row in meta:
        path = None
        if row.get("imagePath") and Path(row["imagePath"]).is_file():
            path = Path(row["imagePath"])
        elif row.get("id") and (images_dir / f"{row['id']}.webp").is_file():
            path = images_dir / f"{row['id']}.webp"
        elif row.get("id") and (images_dir / f"{row['id']}.png").is_file():
            path = images_dir / f"{row['id']}.png"
        elif row.get("id") and (images_dir / f"{row['id']}.jpg").is_file():
            path = images_dir / f"{row['id']}.jpg"
        if path is not None:
            candidates.append((row, path))

    print(f"Embedding {len(candidates)} catalog images…")
    for i, (row, path) in enumerate(candidates, 1):
        image = Image.open(path).convert("RGB")
        # Art-biased: top 45%
        w, h = image.size
        image = image.crop((0, 0, w, max(1, int(h * 0.45))))
        tensor = preprocess(image).unsqueeze(0)
        with torch.no_grad():
            feat = model.encode_image(tensor)
            feat = feat / feat.norm(dim=-1, keepdim=True)
        vectors.append(feat.cpu().numpy()[0])
        kept_meta.append(row)
        if i % 200 == 0 or i == len(candidates):
            print(f"  {i}/{len(candidates)}", flush=True)

    if not vectors:
        raise SystemExit("No images found to embed — re-run build_catalog.py --download-images")

    mat = np.stack(vectors).astype(np.float32)
    np.save(args.catalog / "embeddings.npy", mat)
    (args.catalog / "meta.json").write_text(json.dumps(kept_meta, indent=2), encoding="utf-8")
    (args.catalog / "id_map.json").write_text(
        json.dumps([str(r.get("id") or i) for i, r in enumerate(kept_meta)]),
        encoding="utf-8",
    )

    try:
        import faiss  # type: ignore

        index = faiss.IndexFlatIP(mat.shape[1])
        faiss.normalize_L2(mat)
        index.add(mat)
        faiss.write_index(index, str(args.catalog / "embeddings.faiss"))
        print(f"FAISS index: {args.catalog / 'embeddings.faiss'} ({len(kept_meta)} vectors)")
    except Exception as exc:  # noqa: BLE001
        print(f"FAISS unavailable ({exc}); saved embeddings.npy only")

    print(f"Embedded {len(kept_meta)} cards")


if __name__ == "__main__":
    main()
