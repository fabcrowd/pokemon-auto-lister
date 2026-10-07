#!/usr/bin/env python3
"""Embed catalog images with OpenCLIP and write FAISS / npy index."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CATALOG = ROOT / "data" / "card-catalog"

BATCH_SIZE = 64


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--model", default="ViT-B-32")
    parser.add_argument("--pretrained", default="openai")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
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

    # Set torch to use all available threads
    torch.set_num_threads(torch.get_num_threads())

    images_dir = args.catalog / "images"
    candidates: list[tuple[dict, Path]] = []
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

    total = len(candidates)
    print(f"Embedding {total} catalog images (batch={args.batch_size})…")

    vectors: list[np.ndarray] = []
    kept_meta: list[dict] = []
    bs = args.batch_size

    for batch_start in range(0, total, bs):
        batch = candidates[batch_start : batch_start + bs]
        tensors = []
        valid_rows = []
        for row, path in batch:
            try:
                image = Image.open(path).convert("RGB")
                w, h = image.size
                image = image.crop((0, 0, w, max(1, int(h * 0.45))))
                tensors.append(preprocess(image))
                valid_rows.append(row)
            except Exception:  # noqa: BLE001
                pass

        if not tensors:
            continue

        batch_tensor = torch.stack(tensors)
        with torch.no_grad():
            feats = model.encode_image(batch_tensor)
            feats = feats / feats.norm(dim=-1, keepdim=True)

        vectors.extend(feats.cpu().numpy())
        kept_meta.extend(valid_rows)

        done = min(batch_start + bs, total)
        if done % 200 == 0 or done == total:
            print(f"  {done}/{total}", flush=True)

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
