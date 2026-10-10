# WASM Migration: Next Steps

Eliminate the Python server entirely. All detection, identification, and pricing runs inside the Chrome extension using onnxruntime-web. Models are downloaded once on first install and cached in the browser.

---

## Phase 0 — One-Time Artifact Generation (run locally, Python)

Two scripts you run once. Outputs get uploaded to GitHub Releases.

### `scripts/export_clip_onnx.py`

Exports the CLIP ViT-B-32 visual encoder to ONNX with int8 quantization (~38 MB).

```python
import torch
import open_clip
from onnxruntime.quantization import quantize_dynamic, QuantType
import numpy as np

model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
model.eval()

class VisualEncoder(torch.nn.Module):
    def forward(self, x):
        features = model.encode_image(x)
        return features / features.norm(dim=-1, keepdim=True)

visual = VisualEncoder()

dummy = torch.zeros(1, 3, 224, 224)
torch.onnx.export(
    visual, dummy, "clip_visual_fp32.onnx",
    input_names=["pixel_values"],
    output_names=["embedding"],
    dynamic_axes={"pixel_values": {0: "batch"}, "embedding": {0: "batch"}},
    opset_version=17,
)

quantize_dynamic("clip_visual_fp32.onnx", "clip_visual_int8.onnx", weight_type=QuantType.QUInt8)
print("Done. Size:", os.path.getsize("clip_visual_int8.onnx") / 1e6, "MB")
```

### `scripts/convert_catalog_for_browser.py`

Converts `embeddings.npy` to raw binary (Float32, little-endian) and gzips it.

```python
import numpy as np
import gzip
import shutil

emb = np.load("data/card-catalog/embeddings.npy").astype(np.float32)
print(f"Shape: {emb.shape}")  # (N, 512)

emb.tofile("catalog.bin")

with open("catalog.bin", "rb") as f_in, gzip.open("catalog.bin.gz", "wb", compresslevel=9) as f_out:
    shutil.copyfileobj(f_in, f_out)

print(f"catalog.bin: {os.path.getsize('catalog.bin') / 1e6:.1f} MB")
print(f"catalog.bin.gz: {os.path.getsize('catalog.bin.gz') / 1e6:.1f} MB")
```

### GitHub Releases assets to upload

| File | Source | Approx size |
|------|--------|-------------|
| `clip_visual_int8.onnx` | export script | ~38 MB |
| `card_detect.onnx` | already exists in tools/vellum-ai/ | ~10 MB |
| `catalog.bin.gz` | convert script | ~25 MB |
| `meta.json` | data/card-catalog/ | 4.8 MB |
| `id_map.json` | data/card-catalog/ | 0.24 MB |
| `phash.json` | data/card-catalog/ | 0.67 MB |

---

## Phase 1 — Extension Scaffold

Create `dist/extension-wasm/` — the existing `dist/extension/` stays untouched.

### `manifest.json`

MV3, no local server required, no `host_permissions` for localhost:

```json
{
  "manifest_version": 3,
  "name": "Pokémon Card Scanner",
  "version": "2.0.0",
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["https://api.pokemontcg.io/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"] }]
}
```

### Directory structure

```
dist/extension-wasm/
├── manifest.json
├── popup.html
├── popup.js
├── content.js          (copy from existing, unchanged)
├── background.js       (new — orchestrator)
├── vendor/
│   ├── ort.min.js      (onnxruntime-web bundle, ~900KB)
│   └── ort.wasm        (WASM binary)
└── lib/
    ├── setup.js        (first-run download manager)
    ├── detect.js       (YOLO card detection)
    ├── rectify.js      (perspective transform)
    ├── embed.js        (CLIP inference)
    ├── search.js       (cosine similarity + catalog)
    ├── ocr.js          (RapidOCR ONNX or regex fallback)
    ├── fusion.js       (RRF port from fusion.py)
    └── pricing.js      (pokemontcg.io + cache)
```

---

## Phase 2 — Core Inference Modules

### `lib/setup.js` — First-run download manager

Downloads models from GitHub Releases, stores in Cache API:

```js
const RELEASE_BASE = "https://github.com/YOUR_USER/cardscanner/releases/download/v2.0/";

const ASSETS = [
  { name: "clip_visual_int8.onnx", size_mb: 38 },
  { name: "card_detect.onnx",      size_mb: 10 },
  { name: "catalog.bin.gz",        size_mb: 25 },
  { name: "meta.json",             size_mb: 4.8 },
  { name: "id_map.json",           size_mb: 0.24 },
  { name: "phash.json",            size_mb: 0.67 },
];

export async function ensureModelsReady(onProgress) {
  const cache = await caches.open("cardscanner-v2");
  for (const asset of ASSETS) {
    const cached = await cache.match(RELEASE_BASE + asset.name);
    if (cached) continue;
    onProgress?.({ file: asset.name, status: "downloading" });
    const res = await fetch(RELEASE_BASE + asset.name);
    await cache.put(RELEASE_BASE + asset.name, res.clone());
    onProgress?.({ file: asset.name, status: "done" });
  }
}

export async function getAsset(name) {
  const cache = await caches.open("cardscanner-v2");
  const res = await cache.match(RELEASE_BASE + name);
  if (!res) throw new Error(`Asset not cached: ${name}`);
  return res;
}
```

### `lib/detect.js` — YOLO ONNX card detection

Ports `detect_multi.py` to JS:
1. Resize input frame to fit within 1280px
2. Run `card_detect.onnx` via `ort.InferenceSession`
3. Parse `[1, 5, num_anchors]` output (x, y, w, h, conf)
4. NMS with IOU threshold 0.45, confidence threshold 0.25
5. Return `[{x1,y1,x2,y2}]` in original image coordinates

```js
import { getAsset } from "./setup.js";

const CONF_THRESHOLD = 0.25;
const NMS_IOU = 0.45;
const MAX_DIM = 1280;

let _session = null;

export async function loadDetector() {
  if (_session) return;
  const asset = await getAsset("card_detect.onnx");
  const buf = await asset.arrayBuffer();
  _session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
}

export async function detectCards(canvas, origW, origH) {
  // letterbox resize, run session, parse output, NMS, rescale boxes
}
```

### `lib/rectify.js` — Perspective transform (pure JS)

For each detected box, crop and warp to 750×1050.
- Start with axis-aligned crop (handles ~90% of cards)
- Full homography warp is a follow-up improvement

```js
export function rectifyCard(sourceCanvas, box) {
  const { x1, y1, x2, y2 } = box;
  const dst = new OffscreenCanvas(750, 1050);
  dst.getContext("2d").drawImage(sourceCanvas, x1, y1, x2-x1, y2-y1, 0, 0, 750, 1050);
  return dst;
}
```

### `lib/embed.js` — CLIP ViT-B-32 ONNX inference

Ports `retrieve.py`'s `embed_bgr()` exactly — same preprocessing, same upper-45% crop:

```js
import { getAsset } from "./setup.js";

const IMAGENET_MEAN = [0.48145466, 0.4578275, 0.40821073];
const IMAGENET_STD  = [0.26862954, 0.26130258, 0.27577711];

let _session = null;

export async function loadEmbedder() {
  if (_session) return;
  const asset = await getAsset("clip_visual_int8.onnx");
  const buf = await asset.arrayBuffer();
  _session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
}

export async function embedCard(canvas750x1050) {
  // 1. Crop upper 45%: 750 × 472
  const cropH = Math.round(1050 * 0.45);
  const crop = new OffscreenCanvas(750, cropH);
  crop.getContext("2d").drawImage(canvas750x1050, 0, 0, 750, cropH, 0, 0, 750, cropH);

  // 2. Resize to 224×224
  const resized = new OffscreenCanvas(224, 224);
  resized.getContext("2d").drawImage(crop, 0, 0, 224, 224);

  // 3. Normalize to Float32 [1, 3, 224, 224] CHW
  const imageData = resized.getContext("2d").getImageData(0, 0, 224, 224);
  const tensor = rgbaToNormalizedCHW(imageData.data, IMAGENET_MEAN, IMAGENET_STD);

  // 4. Run ONNX
  const feeds = { pixel_values: new ort.Tensor("float32", tensor, [1, 3, 224, 224]) };
  const output = await _session.run(feeds);
  return output.embedding.data;  // Float32Array, length 512, L2-normalized
}
```

### `lib/search.js` — Brute-force cosine similarity

Loads `catalog.bin.gz`, decompresses via native `DecompressionStream`, dot-product search over ~21,000 × 512 Float32 vectors (~5-10ms):

```js
import { getAsset } from "./setup.js";

let _catalog = null;  // Float32Array, [N * 512] flattened
let _N = 0;

export async function loadCatalog() {
  if (_catalog) return;
  const asset = await getAsset("catalog.bin.gz");
  const compressed = await asset.arrayBuffer();
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const flat = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { flat.set(c, offset); offset += c.length; }
  _catalog = new Float32Array(flat.buffer);
  _N = _catalog.length / 512;
}

export function searchCatalog(queryEmbedding, topK = 20) {
  const scores = new Float32Array(_N);
  for (let i = 0; i < _N; i++) {
    let dot = 0;
    const base = i * 512;
    for (let j = 0; j < 512; j++) dot += queryEmbedding[j] * _catalog[base + j];
    scores[i] = dot;
  }
  return Array.from({length: _N}, (_, i) => i)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, topK)
    .map(idx => ({ idx, score: scores[idx] }));
}
```

### `lib/fusion.js` — RRF port from `fusion.py`

```js
const ACCEPT_MARGIN = 0.02;

export function fuse(clipHits, ocrNumber, meta) {
  let candidates = clipHits;
  if (ocrNumber) {
    const filtered = clipHits.filter(h => meta[h.idx]?.number === ocrNumber);
    if (filtered.length > 0) candidates = filtered;
  }

  const scored = candidates.map((hit, rank) => {
    const card = meta[hit.idx];
    let score = 1 / (60 + rank + 1);
    if (ocrNumber && card?.number === ocrNumber) score += 0.05;
    return { ...hit, rrf: score, card };
  }).sort((a, b) => b.rrf - a.rrf);

  if (scored.length === 0) return { abstain: true, reason: "no_candidates" };

  const top = scored[0];
  const second = scored[1];
  const margin = second ? top.rrf - second.rrf : 1;

  if (margin < ACCEPT_MARGIN) return { abstain: true, reason: "low_margin", margin };

  return {
    abstain: false,
    identity: top.card,
    confidence: top.score,
    margin,
    candidates: scored.slice(0, 5),
  };
}
```

### `lib/pricing.js` — pokemontcg.io with chrome.storage.local cache

```js
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRICE_VARIANTS = ["holofoil", "normal", "reverseHolofoil", "1stEditionHolofoil", "unlimited"];

export async function getPrice(identity) {
  const { setCode, number } = identity;
  if (!setCode || !number) return null;

  const cacheKey = `price:${setCode}-${number}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey] && Date.now() - cached[cacheKey].ts < CACHE_TTL_MS) {
    return cached[cacheKey].price;
  }

  const cardId = encodeURIComponent(`${setCode}-${number}`);
  const res = await fetch(`https://api.pokemontcg.io/v2/cards/${cardId}`);
  if (!res.ok) return null;
  const data = await res.json();
  const prices = data?.data?.tcgplayer?.prices;
  if (!prices) return null;

  for (const variant of PRICE_VARIANTS) {
    if (prices[variant]?.market) {
      const price = { market: prices[variant].market, variant, source: "tcgplayer" };
      await chrome.storage.local.set({ [cacheKey]: { price, ts: Date.now() } });
      return price;
    }
  }
  return null;
}
```

---

## Phase 3 — Background Orchestrator & Popup

### `background.js` — Service worker, owns all inference

```js
import { ensureModelsReady } from "./lib/setup.js";
import { loadDetector, detectCards } from "./lib/detect.js";
import { loadEmbedder, embedCard } from "./lib/embed.js";
import { loadCatalog, searchCatalog } from "./lib/search.js";
import { rectifyCard } from "./lib/rectify.js";
import { fuse } from "./lib/fusion.js";
import { getPrice } from "./lib/pricing.js";

let meta = null, idMap = null, phash = null;
let modelsReady = false;

async function init(onProgress) {
  await ensureModelsReady(onProgress);
  await Promise.all([loadDetector(), loadEmbedder(), loadCatalog()]);
  const cache = await caches.open("cardscanner-v2");
  meta  = await (await cache.match("...meta.json")).json();
  idMap = await (await cache.match("...id_map.json")).json();
  phash = await (await cache.match("...phash.json")).json();
  modelsReady = true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "init") {
    init(p => chrome.runtime.sendMessage({ action: "progress", ...p }))
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === "detect") {
    if (!modelsReady) { sendResponse({ error: "not_ready" }); return; }
    handleDetect(msg.imageB64).then(sendResponse);
    return true;
  }
});

async function handleDetect(imageB64) {
  const blob = await fetch("data:image/jpeg;base64," + imageB64).then(r => r.blob());
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);

  const boxes = await detectCards(canvas, bitmap.width, bitmap.height);
  const cards = [];

  for (const box of boxes) {
    const rectified = rectifyCard(canvas, box);
    const embedding = await embedCard(rectified);
    const hits = searchCatalog(embedding, 20);
    const result = fuse(hits, null, meta);
    if (result.abstain) {
      cards.push({ box, abstain: true, reason: result.reason });
      continue;
    }
    const price = await getPrice(result.identity);
    cards.push({
      box,
      identity: result.identity,
      confidence: result.confidence,
      abstain: false,
      market_price: price?.market ?? null,
      price_variant: price?.variant ?? null,
    });
  }
  return {
    cards,
    total_detected: boxes.length,
    total_identified: cards.filter(c => !c.abstain).length,
  };
}
```

### `popup.js` changes

Replace the server fetch call:

```js
// BEFORE:
const res = await fetch(`${SERVER}/detect`, { method: "POST", ... });

// AFTER:
const result = await chrome.runtime.sendMessage({ action: "detect", imageB64: b64 });
```

Remove all health check logic (`HEALTH_INTERVAL_MS`, `checkServer()`). Replace with a one-time model readiness check on popup open.

### `popup.html` — add first-run progress bar

```html
<div id="setup-overlay" style="display:none">
  <p>First-time setup — downloading models...</p>
  <progress id="setup-progress" max="6" value="0"></progress>
  <p id="setup-status"></p>
</div>
```

---

## Phase 4 — Testing & Release

1. Run Phase 0 scripts → confirm ONNX exports and sizes
2. Create GitHub Release tagged `v2.0`, upload all 6 assets
3. Set `RELEASE_BASE` constant in `lib/setup.js` to the actual release URL
4. Load `dist/extension-wasm/` in Chrome (developer mode)
5. First open: watch models download into Cache API (~75 MB total, one time)
6. Test with real cards — verify detection + identification + price
7. Package and publish to Chrome Web Store

---

## End-user experience

1. Install extension
2. First popup open: progress bar downloads ~75 MB of models (one time only)
3. After that: click scan, hold card up to camera, get results instantly
4. No server, no Python, no setup — works on any machine
