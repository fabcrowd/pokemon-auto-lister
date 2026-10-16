#!/usr/bin/env python3
"""Rebuild CARD_BACK in tools/extension-wasm/lib/card-back.js from card-back crops.

Run it whenever the embedder or its art crop changes (lib/embed.js EMBEDDING_VERSION):

    python scripts/embed-card-back.py            # print holdout / front similarities only
    python scripts/embed-card-back.py --write    # also rewrite the CARD_BACK block

The crop is the one in lib/embed.js (artSourceRect): a centred square of the top 45% of the card.
Backs are rectified 750x1050 crops under data/setctx/ (gitignored); fronts are every other crop there.
"""
import argparse
import glob
import os
import re

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETCTX = os.path.join(ROOT, "data", "setctx")
TARGET = os.path.join(ROOT, "tools", "extension-wasm", "lib", "card-back.js")
BACKS = ["279630564-07/00", "279630564-07/01", "279630564-08/00", "279630564-09/00", "279630564-10/00", "279630564-11/00"]
HOLDOUT_BACKS = ["279630487-06/00", "279630487-10/00"]
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)

session = ort.InferenceSession(os.path.join(ROOT, "clip_visual_int8.onnx"), providers=["CPUExecutionProvider"])
INPUT = session.get_inputs()[0].name


def embed(path):
    card = Image.open(path).convert("RGB")
    w, h = card.size
    strip = max(1, int(h * 0.45))
    side = min(w, strip)
    sx, sy = (w - side) // 2, (strip - side) // 2
    art = card.crop((sx, sy, sx + side, sy + side)).resize((224, 224), Image.BICUBIC)
    x = ((np.asarray(art, dtype=np.float32) / 255 - MEAN) / STD).transpose(2, 0, 1)[None]
    v = session.run(None, {INPUT: x})[0].reshape(-1).astype(np.float32)
    return v / np.linalg.norm(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    mean = np.mean([embed(os.path.join(SETCTX, b + ".jpg")) for b in BACKS], axis=0)
    mean /= np.linalg.norm(mean)

    used = set(BACKS) | set(HOLDOUT_BACKS)
    fronts = [p for p in sorted(glob.glob(os.path.join(SETCTX, "27*", "*.jpg")))
              if os.path.relpath(p, SETCTX).replace("\\", "/")[:-4] not in used]
    front_sims = np.array([float(embed(p) @ mean) for p in fronts])
    print("six backs (training):", [round(float(embed(os.path.join(SETCTX, b + ".jpg")) @ mean), 3) for b in BACKS])
    print("holdout backs:", [round(float(embed(os.path.join(SETCTX, b + ".jpg")) @ mean), 3) for b in HOLDOUT_BACKS])
    print(f"{len(fronts)} fronts: max {front_sims.max():.3f}, p99 {np.percentile(front_sims, 99):.3f}, mean {front_sims.mean():.3f}")

    if not args.write:
        return
    rows = [", ".join(f"{float(x):.5g}" for x in mean[i:i + 16]) + "," for i in range(0, 512, 16)]
    block = "export const CARD_BACK = Object.freeze([\n  " + "\n  ".join(rows) + "\n]);"
    src = open(TARGET, encoding="utf-8").read()
    src, n = re.subn(r"export const CARD_BACK = Object\.freeze\(\[.*?\]\);", lambda _: block, src, flags=re.S)
    assert n == 1
    open(TARGET, "w", encoding="utf-8", newline="\n").write(src)
    print("wrote", TARGET)


if __name__ == "__main__":
    main()
