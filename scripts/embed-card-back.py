#!/usr/bin/env python3
"""Rebuild CARD_BACK in tools/extension-wasm/lib/card-back.js from verified card-back crops.

Run it whenever the query model or its art crop changes (lib/setup.js clip pin, lib/embed.js EMBEDDING_VERSION):

    python scripts/embed-card-back.py --model <clip_visual_int8.onnx>           # print similarities only
    python scripts/embed-card-back.py --model <clip_visual_int8.onnx> --write   # also rewrite the CARD_BACK block

The crop is the one in lib/embed.js (artSourceRect): a centred square of the top 45% of the card.
Backs are 750x1050 crops of English card backs, one file each in --backs (default data/card-back-crops/,
gitignored; manifest.json there lists the photo and detector box each came from). Draw them ONLY from training
photos (goodwill-pack*, hibid-pack/train), look at every crop, and keep at least 30 clean English backs: no
stacks, no foreign (rainbow/gold border) backs, no heavy glare. Never use eval splits or Facebook photos, which
are for measuring only. Fronts for the printed check are the optional --fronts directory (750x1050 crops).

--write also rewrites CARD_BACK_BUILT_FOR (model sha prefix and crop version, read from lib/setup.js and
lib/embed.js, so the model you pass must match the pin) and checks the file sha256 against the pin.
"""
import argparse
import glob
import hashlib
import os
import re

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "tools", "extension-wasm", "lib", "card-back.js")
SETUP = os.path.join(ROOT, "tools", "extension-wasm", "lib", "setup.js")
EMBED = os.path.join(ROOT, "tools", "extension-wasm", "lib", "embed.js")
MIN_BACKS = 30
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def pinned_sha():
    src = open(SETUP, encoding="utf-8").read()
    m = re.search(r'name:\s*"clip_visual_int8\.onnx".*?sha256:\s*"([0-9a-f]{64})"', src, re.S)
    assert m, "clip pin not found in setup.js"
    return m.group(1)


def embedding_version():
    m = re.search(r"EMBEDDING_VERSION\s*=\s*(\d+)", open(EMBED, encoding="utf-8").read())
    assert m, "EMBEDDING_VERSION not found in embed.js"
    return int(m.group(1))


def crops_in(folder):
    return sorted(p for ext in ("png", "jpg") for p in glob.glob(os.path.join(folder, "*." + ext)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="clip_visual_int8.onnx of the pinned release")
    ap.add_argument("--backs", default=os.path.join(ROOT, "data", "card-back-crops"))
    ap.add_argument("--fronts", default=None)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    sha = hashlib.sha256(open(args.model, "rb").read()).hexdigest()
    if args.write and sha != pinned_sha():
        raise SystemExit(f"{args.model} is {sha[:16]}, not the model pinned in setup.js ({pinned_sha()[:16]})")

    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name

    def embed(path):
        card = Image.open(path).convert("RGB")
        w, h = card.size
        strip = max(1, int(h * 0.45))
        side = min(w, strip)
        sx, sy = (w - side) // 2, (strip - side) // 2
        art = card.crop((sx, sy, sx + side, sy + side)).resize((224, 224), Image.BICUBIC)
        x = ((np.asarray(art, dtype=np.float32) / 255 - MEAN) / STD).transpose(2, 0, 1)[None]
        v = session.run(None, {name: x})[0].reshape(-1).astype(np.float32)
        return v / np.linalg.norm(v)

    backs = crops_in(args.backs)
    if len(backs) < MIN_BACKS:
        raise SystemExit(f"{len(backs)} back crops in {args.backs}; need at least {MIN_BACKS}")
    vecs = np.stack([embed(p) for p in backs])
    mean = vecs.mean(axis=0)
    mean /= np.linalg.norm(mean)
    sims = vecs @ mean
    print(f"model {sha[:16]}, {len(backs)} backs (training): min {sims.min():.3f}, median {np.median(sims):.3f}")

    if args.fronts:
        fronts = crops_in(args.fronts)
        fs = np.array([float(embed(p) @ mean) for p in fronts])
        print(f"{len(fronts)} fronts: max {fs.max():.3f}, p99 {np.percentile(fs, 99):.3f}, mean {fs.mean():.3f}")

    if not args.write:
        return
    rows = [", ".join(f"{float(x):.5g}" for x in mean[i:i + 16]) + "," for i in range(0, 512, 16)]
    block = "export const CARD_BACK = Object.freeze([\n  " + "\n  ".join(rows) + "\n]);"
    src = open(TARGET, encoding="utf-8").read()
    src, n = re.subn(r"export const CARD_BACK = Object\.freeze\(\[.*?\]\);", lambda _: block, src, flags=re.S)
    assert n == 1
    built = f'export const CARD_BACK_BUILT_FOR = Object.freeze({{ clip: "{sha[:16]}", crop: {embedding_version()} }});'
    src, n = re.subn(r"export const CARD_BACK_BUILT_FOR = .*?;", lambda _: built, src)
    assert n == 1
    open(TARGET, "w", encoding="utf-8", newline="\n").write(src)
    print("wrote", TARGET)


if __name__ == "__main__":
    main()
