# Detector Upgrade — Implementation Handoff

A systematic plan to take the current YOLO11n card detector from "works on clean web grids, fails on marketplace photos" to a robust, self-improving detector covering all three scanning environments (web grids, multi-card photos, zoomed single photos).

This document is executable. Each phase has entry criteria, exact commands, validation, and rollback.

---

## 0. What already exists (don't reinvent)

Before starting any phase, read these first. Significant infrastructure is in place.

### Training pipeline — `tools/vellum-ai/detect/` (~2,700 lines)

| File | Lines | What it does |
|---|---|---|
| `train_detect.py` | 57 | Fine-tunes `yolo11n.pt` on a YOLO dataset, exports ONNX with `imgsz=640, simplify=True` |
| `retrain.py` | 277 | **Self-improving loop**: ingests pseudo-labeled harvest frames, retrains, gates on mAP@50 ≥ 0.95 **and** improvement over baseline, promotes winner. Already supports `--dry-run`, `--min-new`, `--epochs`. |
| `synth_bootstrap.py` | 359 | Composites single catalog cards onto varied backgrounds with warp/lighting/noise |
| `synth_multi_card.py` | 295 | Composites **multiple** cards per image (lot shots, grids) with YOLO labels |
| `bootstrap.py` + `bootstrap_from_inbox.py` | 475 | Seeds initial labeled set from scanning sessions |
| `eval_detect.py`, `eval_multi_detect.py`, `eval_corner_confusion.py` | 370 | Evaluation harness (mAP, box IoU, corner confusion matrix) |
| `label_marketplace.py` | 141 | Labels marketplace case fixtures |
| `stress_test.py`, `stress_test_multi.py` | 342 | Regression tests for shipping-quality gates |
| `marketplace_cases.json`, `loop_stages.json` | — | Named regression fixtures and stage progression (currently at stage 7/7) |

### Extension pipeline — `dist/extension-wasm/`

| File | Role |
|---|---|
| `lib/detect.js` | YOLO inference wrapper. Already has runtime-adjustable `setConfThreshold()` |
| `background.js` | DOM finder → YOLO-in-photo → grid-split fallback → YOLO-viewport fallback |
| `content.js` | DOM traversal (`findCardImages`, `findCardsDiag`) with `photos[]` list for multi-card images |
| `lib/condition-pricing.js` | Three-tier pricing with backend/PPT/pokemontcg sources |

### Model artifacts

- Current `card_detect.onnx` ships via GitHub Release v2.0 (`fabcrowd/pokemon-auto-lister`)
- Download URL hard-coded in `dist/extension-wasm/lib/setup.js` under `RELEASE_BASE`
- Loaded via `chrome.runtime` into `caches` namespace `cardscanner-models-v2.1`

### What's **missing** (what this handoff builds)

- Real-image labeled data in the training set (only synthetic today)
- OBB (rotated bounding box) support, which means `rectify.js` can't warp quadrilaterals
- Extension-side telemetry pipeline to feed `retrain.py` with real user scans
- Opt-in UX for telemetry (privacy ask)
- Active-learning review UI
- Zero-shot fallback (Grounding DINO)
- DINOv3 embedding swap for CLIP

---

## 0.5 Open TODOs

### Recently completed (update doc sections as needed)

- [x] **MutationObserver auto-rescan** — `content.js` now arms a `MutationObserver` after each scan and sends `newCardsDetected` to the background when new card-shaped images appear (lazy load / infinite scroll). `background.js` handles that message: re-scans only when popup is open, models ready, and no scan is in flight (`_autoScanInFlight` guard). `window.__cardScanner` exposes `startObserving`/`stopObserving` for Playwright tests. Update §0 extension pipeline table to mention this.
- [x] **pokemontcg.io free API** — `lib/condition-pricing.js` switched from paid PokéWallet/RapidAPI wrappers to the free pokemontcg.io REST API (4 h TTL cache). No API key needed for read-only calls. Update §1 Accounts / access to remove PokéWallet as a requirement.

### Pre-work gaps — must fix before phases can start

These are missing files or code that the handoff doc assumes exist. None of the phase entry criteria can be met until these are in place.

#### Blockers for §2 Shared infra (day 1)

- [ ] **`tools/vellum-ai/detect/eval_shipping.py` does not exist.** This is the gate for every single phase. Create it first — before touching training or data. The eval suite dirs it expects (`tests/synthetic`, `tests/marketplace-held-out`, `tests/zoomed-single`) also need to be seeded. See §2.2 for spec.
- [ ] **`tools/vellum-ai/datasets/` directory does not exist.** The doc assumes `datasets/pokemon-cards-v1/` already contains the current training data, but the actual file is `tools/vellum-ai/detect/dataset.yaml` (flat, no subdirectory). Reconcile: either move the existing YAML into `datasets/pokemon-cards-v1/dataset.yaml` and update all script paths, or document that `pokemon-cards-v1` is a path alias. Resolve before running `mix_datasets.py`.
- [ ] **`tools/vellum-ai/scripts/` directory does not exist.** `mix_datasets.py`, `scrape_marketplace_screenshots.py`, `aabb_to_obb.py`, and `publish_model.py` are all specified to live here. Create the directory and stub the scripts before Phase 1 step 2.

#### Blocker for Phase 1 ship (§3, step 8)

- [ ] **`dist/extension-wasm/model-manifest.json` does not exist.** Without it the "users auto-update on next popup open" step in Phase 1 step 8 is a no-op. Must be created and checked into the release before v3.0 ships.
- [ ] **`setup.js` still hard-codes `RELEASE_BASE`** (4 usages at lines 4, 20, 37, and ~102/111). The manifest-fetch rewrite from §2.4 must land before the v3.0 release, otherwise installed extensions will never pull the new model. This is a Phase 1 pre-requisite, not a Phase 1 output.

#### Pre-work for Phase 3 (§5)

- [ ] **`dist/extension-wasm/lib/telemetry.js` does not exist.** Create it before wiring the `sendTelemetry` call site in `background.js` (see §5.1 for the full spec).
- [ ] **`probeBackend()` is not implemented in `background.js`.** Phase 5 step 4 calls it (`if (probeBackend()) call /api/zero-shot-detect`). Write a simple `async function probeBackend()` that hits `/api/health` with a 2 s timeout and returns a boolean. Phase 3 also references it implicitly.
- [ ] **`options.html` has no telemetry section.** The opt-in UX from §5.1 needs to be added before telemetry goes live. Opt-in default is `false` — adding the UI is safe to do any time, but it must ship before enabling the telemetry call site.

#### Config

- [ ] **`.env.example` is missing `ROBOFLOW_API_KEY`.** Phase 1 step 1 uses `Roboflow(api_key='YOUR_KEY')`. Add `ROBOFLOW_API_KEY=` to `.env.example` so it's not forgotten when someone follows the steps from scratch.

---

## 1. Prerequisites

### Compute

- **Minimum:** CPU-only. YOLO11n fine-tune takes ~10 h for 100 epochs. Enough for Phase 1.
- **Recommended:** 1× T4 GPU ($0.35/hr on vast.ai/lambda, or free on Colab T4). Cuts training to ~1 h.
- **Needed for ongoing Phase 3 loop:** a box that can run `retrain.py` nightly. Local Windows works. Cloud T4 at ~$5/day if desired.

### Accounts / access

- **Roboflow** (free tier) — pull the 494-image Pokemon dataset. Sign up at roboflow.com.
- **GitHub repo write** on `fabcrowd/pokemon-auto-lister` to publish release assets.
- **Cloudflare R2 or S3** (optional, needed only for Phase 3 telemetry) — ~$5/mo for the user-scan corpus.
- **Hugging Face account** (free) — pull DINOv3 and Grounding DINO weights.

### Python env

The existing `tools/vellum-ai/.venv312` has ultralytics, torch, open-clip, onnx, onnxruntime. If building from scratch:

```powershell
cd tools\vellum-ai
py -3.12 -m venv .venv312
.\.venv312\Scripts\pip install -r requirements.txt
# For Phases 5-6 additionally:
.\.venv312\Scripts\pip install transformers huggingface_hub
```

---

## 2. Shared infrastructure (build once, before any phase)

Four pieces that every subsequent phase depends on. Build these first — one day of work.

### 2.1 Data layout convention

Create under `tools/vellum-ai/datasets/`:

```
datasets/
├── pokemon-cards-v1/           # current synthetic-only (already exists)
│   ├── images/{train,val,test}/
│   ├── labels/{train,val,test}/
│   └── dataset.yaml
├── roboflow-pokemon-v1/        # NEW — pulled from Roboflow
│   ├── images/, labels/, dataset.yaml
├── marketplace-real/           # NEW — hand-labeled real screenshots
│   ├── images/, labels/, dataset.yaml
├── user-pseudo/                # NEW — Phase 3 telemetry pipeline writes here
│   └── <date>/images/+labels/
└── combined-vX/                # produced by `scripts/mix_datasets.py`
    └── dataset.yaml            # references the three above with weights
```

### 2.2 Evaluation harness upgrade

Extend `eval_detect.py` with a **held-out real validation set** that NEVER sees training data. This is the ground truth that gates every model promotion.

Create `tools/vellum-ai/detect/eval_shipping.py`:
- Takes a model path
- Runs against 3 fixed test suites:
  - `tests/synthetic` (100 synthetic images — regression check)
  - `tests/marketplace-held-out` (50 real marketplace shots — never used in training)
  - `tests/zoomed-single` (20 single-card photos — lightbox scenario)
- Reports per-suite recall @ IoU=0.5, mean mAP@50, false-positive rate
- Writes a `models/<name>/eval-report.json`
- Exits non-zero if ANY suite falls below configurable floor (recall ≥ 0.80 default)

This becomes the gate for every subsequent phase. Any model that regresses on any suite is rejected.

### 2.3 Dataset mixer

Create `tools/vellum-ai/scripts/mix_datasets.py`:
- Reads a `mix.yaml` like `{synthetic: 0.4, roboflow: 0.3, marketplace: 0.2, pseudo: 0.1}`
- Builds a merged `dataset.yaml` with YOLO-compatible path lists + sample weights
- Honors per-dataset max count caps (so a huge pseudo corpus doesn't swamp a few hundred hand-labeled gold)
- Deterministic — same mix.yaml always builds the same split

### 2.4 Model manifest + versioning

Create `dist/extension-wasm/model-manifest.json` served from GitHub Pages (or just checked into the release):

```json
{
  "schema_version": 1,
  "detector": { "name": "card_detect", "version": "3.0.0", "url": "...", "sha256": "...", "min_extension_version": "2.0.0" },
  "embedder": { "name": "clip_visual_int8", "version": "1.0.0", "url": "...", "sha256": "..." },
  "catalog":  { "version": "1.0.0", "url": "...", "sha256": "..." }
}
```

Modify `dist/extension-wasm/lib/setup.js` to:
- Fetch the manifest on every popup open (cheap, cached 1h)
- Compare installed versions to manifest; if newer, show "Updating detector…" and swap in background
- Validate SHA-256 before swapping to prevent corrupted downloads

**Validation:** `python detect/eval_shipping.py --model models/current/card_detect.onnx` must pass on current model before touching anything else. If it already fails, fix the harness, not the model.

---

## 3. Phase 1 — Fine-tune on real data

**Entry criteria:** Shared infrastructure (§2) done. Current model passes `eval_shipping.py` as baseline.

### Steps

1. **Pull Roboflow dataset**

   ```powershell
   cd tools\vellum-ai
   .\.venv312\Scripts\python -c "from roboflow import Roboflow; rf = Roboflow(api_key='YOUR_KEY'); rf.workspace('tcg-card-dectector').project('pokemon-card-detector-gksmy').version(1).download('yolov8', location='datasets/roboflow-pokemon-v1')"
   ```

2. **Collect marketplace screenshots** (one-time, ~1 hour)

   ```powershell
   # New script to write:
   .\.venv312\Scripts\python scripts/scrape_marketplace_screenshots.py --out datasets/marketplace-real/raw --count 500
   ```

   Script uses Playwright to screenshot public pages: eBay sold listings for popular Pokemon cards, Google Image Search for "pokemon card lot photo", Pokellector set pages. Saves raw screenshots only — no labels yet.

3. **Hand-label 50-100 marketplace shots** (one evening)

   Load the raw screenshots into Roboflow (free annotation UI) or CVAT. Draw YOLO boxes around every Pokemon card. Export in YOLO format into `datasets/marketplace-real/images/+labels/`.

4. **Build the mix**

   ```yaml
   # tools/vellum-ai/mixes/v3.yaml
   datasets:
     synthetic: { weight: 0.5, max_count: 10000 }
     roboflow:  { weight: 0.3, max_count: 494 }
     marketplace: { weight: 0.2, max_count: 100 }
   splits: { train: 0.85, val: 0.10, test: 0.05 }
   ```

   ```powershell
   .\.venv312\Scripts\python scripts/mix_datasets.py --config mixes/v3.yaml --out datasets/combined-v3
   ```

5. **Train**

   ```powershell
   .\.venv312\Scripts\python detect/train_detect.py `
     --data datasets/combined-v3/dataset.yaml `
     --epochs 100 `
     --name card_detect_v3
   ```

6. **Export to ONNX**

   `train_detect.py` already does this. Output: `models/card_detect_v3/weights/best.onnx`.

7. **Gate**

   ```powershell
   .\.venv312\Scripts\python detect/eval_shipping.py `
     --model models/card_detect_v3/weights/best.onnx `
     --baseline models/current/card_detect.onnx
   ```

   Must beat baseline on marketplace-held-out suite by ≥ 5% recall OR be ≥ 80% recall absolute. Must not regress on synthetic suite more than 2%.

8. **Ship**

   - Upload ONNX to GitHub Release v3.0
   - Update `model-manifest.json` with new SHA256 and version `3.0.0`
   - Users auto-update on next popup open

**Rollback:** Revert `model-manifest.json` to point back at v2.0 URL. Users re-download old model on next check (adds 10 MB round-trip, acceptable).

**Expected impact:** marketplace-held-out suite recall from ~0% to ≥ 70%.

---

## 4. Phase 2 — Oriented Bounding Boxes

**Entry criteria:** Phase 1 shipped and stable for 3+ days (no rollback).

### Steps

1. **Switch base model** in `train_detect.py`

   ```python
   # change default:
   parser.add_argument("--model", default="yolo11n-obb.pt")
   ```

2. **Convert existing axis-aligned labels to OBB**

   Create `scripts/aabb_to_obb.py`: for each YOLO label `cls cx cy w h`, write `cls x1 y1 x2 y2 x3 y3 x4 y4` using angle=0 (degenerate OBB). YOLO11-OBB accepts this.

3. **Augment labels for Roboflow + marketplace sets** — these already have axis-aligned labels. Run `aabb_to_obb.py` on them. Over time, label new marketplace examples with real angles.

4. **Train**

   ```powershell
   .\.venv312\Scripts\python detect/train_detect.py `
     --data datasets/combined-v3/dataset.yaml `
     --model yolo11n-obb.pt `
     --name card_detect_obb_v1
   ```

5. **Extension-side changes** (`dist/extension-wasm/lib/`)

   - `detect.js`: parse OBB output format (polygon with 4 points per detection, not just x1,y1,x2,y2). YOLO11-OBB outputs `[cx, cy, w, h, angle, conf]` per detection — convert to the 4 corner points.
   - `rectify.js`: replace axis-aligned crop with a **4-point perspective warp** to 750×1050. Use the `canvas.transform()` API or do it manually via `drawImage` with explicit source coordinates after computing the inverse homography. (For angle≤5°, falling back to AABB is fine.)
   - `content.js`: `drawCornerBox()` already draws 4 corners — just needs to accept polygon coords instead of x1,y1,x2,y2.
   - `background.js`: box payload format changes from `[x1,y1,x2,y2]` to `[x1,y1,x2,y2,x3,y3,x4,y4]`. Ensure popup + content handle both for backward compat.

6. **Gate** — must not regress on synthetic suite more than 2%; must improve on a NEW rotated-cards suite (`tests/rotated` — 20 photos of cards at 10-45° angles).

7. **Ship** — manifest version 4.0.0.

**Rollback:** The AABB-compatible payload format must stay valid; downgrade manifest to 3.0.0 if OBB regresses.

**Expected impact:** rotated-cards suite recall from ~15% (current, by accident) to ≥ 75%.

---

## 5. Phase 3 — Self-learning loop (telemetry + retrain)

**Entry criteria:** Phase 1 shipped. OBB from Phase 2 is nice-to-have but not required.

Most of the server-side already exists (`retrain.py` with gating). Missing pieces: the telemetry client in the extension, the opt-in UX, and the storage endpoint.

### 5.1 Extension — opt-in telemetry

**New Options page section** (`dist/extension-wasm/options.html`):

```
┌─────────────────────────────────────────────────┐
│ Help improve detection (optional)              │
│ ─────────────────────────────                   │
│ Share anonymized scan screenshots so the       │
│ detector keeps getting better. Your card data   │
│ and page URLs are never sent.                   │
│                                                 │
│ ☐ Share scan screenshots                        │
│                                                 │
│ [ Learn what's shared ]                         │
└─────────────────────────────────────────────────┘
```

**Flag:** `chrome.storage.sync.set({telemetryOptIn: true})` — default **false**.

**New file `lib/telemetry.js`:**

```js
// After each successful scanPage, if opted in, POST:
//   { capturedImage: <base64 jpeg of viewport>,
//     detections: [{box, score, source}],   // what our model found
//     devicePixelRatio, viewportWidth, viewportHeight }
// to a configured endpoint. Scrub URL/path/EXIF before send.
export async function sendTelemetry(payload) {
  const { telemetryOptIn, telemetryEndpoint } = await getStorageSync(...);
  if (!telemetryOptIn || !telemetryEndpoint) return;
  await fetch(telemetryEndpoint, { method: "POST", body: JSON.stringify(payload) });
}
```

**Call site** in `background.js` `handleScanPage`:

```js
await relayToTab({ action: "relayOverlay", cards, srcWidth, srcHeight });
sendTelemetry({ capturedImage: b64, detections: cards.map(c => ({box: c.box, score: c.score, via: c.via})) }).catch(() => {});
```

### 5.2 Server — ingestion endpoint

Add to `src/server.js`:

```js
if (req.method === "POST" && url.pathname === "/api/telemetry/scan") {
  return handleTelemetry(req, res, { dataDir });
}
```

Writes incoming scans to `data/telemetry/YYYY-MM-DD/<uuid>.jpg` + `<uuid>.json` (detections). Rate-limit per IP (reuse existing patterns).

Expose a non-personal upload token so only the extension can POST. Users with their own backend can set `telemetryEndpoint` to their own host.

### 5.3 Pseudo-label generator

New script `tools/vellum-ai/detect/pseudo_label_from_telemetry.py`:

- Reads `data/telemetry/YYYY-MM-DD/*.jpg` + `.json`
- Runs the CURRENT model (teacher) on each image
- **Soft-teacher filter:** keep only detections with
  - conf ≥ 0.80, AND
  - consistent across two augmentations (horizontal flip, slight hue shift)
- Writes YOLO labels to `datasets/user-pseudo/YYYY-MM-DD/`
- Logs a summary (how many images kept, dropped, avg confidence)

### 5.4 Nightly retrain job

Wire the existing `retrain.py` to a Windows Task Scheduler job (or cron on Linux):

```powershell
# Nightly at 2am:
cd C:\Users\daroo\Desktop\Repos\cardscanner\pokemon-auto-lister\tools\vellum-ai
.\.venv312\Scripts\python detect/pseudo_label_from_telemetry.py --days 7
.\.venv312\Scripts\python detect/retrain.py --min-new 50
# If retrain promotes a new model, publish:
.\.venv312\Scripts\python scripts/publish_model.py --release v3.1
```

The existing `retrain.py` already handles gating. Add `scripts/publish_model.py` to:
- Upload the promoted ONNX to the GitHub Release
- Update `model-manifest.json` with new version/SHA
- (Optional) send a Slack/Discord ping with the eval report

### 5.5 Rollout UX

In the extension Options page, show telemetry status:

```
Help improve detection: ✓ sharing (23 scans contributed · last upload: 2h ago)
                        or
                        ○ off  [ Enable to help ]
```

Give users confidence by showing WHAT they contributed. Store last 10 upload timestamps in `chrome.storage.local`.

**Validation:** After 1 week with ≥ 100 opt-in users, confirm:
- Retrain runs promoted at least one new model
- Promoted model beats baseline on `tests/marketplace-held-out`
- No model got promoted that regressed on `tests/synthetic`

**Rollback:** Flag `_disable_auto_update: true` in manifest instantly halts auto-updates for all users.

**Expected impact:** compounding — each promotion covers more of the real-world distribution. Target: 90% recall on marketplace suite after 3 months.

---

## 6. Phase 4 — Active-learning review UI

**Entry criteria:** Phase 3 running and ingesting telemetry.

### Steps

1. **Uncertain-example queue** — modify `pseudo_label_from_telemetry.py` to also emit detections with `0.30 ≤ conf < 0.70` into `data/telemetry/review-queue/`. These are the "I'm not sure" cases.

2. **Review UI** — add to the Node dashboard (`public/review.html` + `src/server.js` route `/review`):

   ```
   ┌──────────────────────────────────────┐
   │  Review queue: 23 uncertain images   │
   │                                      │
   │  [Image with proposed box overlay]   │
   │                                      │
   │  ✓ is a card    ✗ not a card         │
   │  ↻ adjust box   ⏭ skip               │
   └──────────────────────────────────────┘
   ```

   Approved boxes get written to `datasets/human-reviewed/` with HIGH training weight (10×).

3. **Mix update** — the next retrain run gives reviewed examples 10× weight so the model learns from them aggressively.

**Validation:** 15 min/week of review consistently moves the needle on `tests/marketplace-held-out`. If it doesn't, the retrain loop is already catching those cases from pseudo-labels and the UI is not pulling weight — document and skip.

**Expected impact:** marginal (3-5% recall) but catches the long-tail edge cases that pseudo-labels miss by definition.

---

## 7. Phase 5 — Grounding DINO zero-shot fallback

**Entry criteria:** None — fully independent, can run concurrent with any other phase.

### Decision point first

Two deployment options:

- **Server-side** (recommended): Grounding DINO runs on the Node dashboard behind `/api/zero-shot-detect`. Browser-only users don't get this; dashboard users do. Simple, no size cost in the extension.
- **In-browser via transformers.js**: Grounding DINO Small is ~440 MB — too big for a Chrome extension. **Skip.**

Pick server-side.

### Steps

1. **Install on the Node dashboard** (one-time):
   ```powershell
   pip install transformers torch pillow
   # or run in a Python sidecar — the existing vellum-ai pattern
   ```

2. **New Python sidecar** `tools/vellum-ai/grounding_dino_server.py`:
   - Loads `IDEA-Research/grounding-dino-tiny` once
   - Exposes `POST /detect {image_b64, prompt}` returning `[{box, score, label}]`
   - Default prompt: `"a trading card . a pokemon card ."`
   - Threshold: box_threshold=0.25, text_threshold=0.25

3. **Node server proxy** — add `/api/zero-shot-detect` endpoint in `src/server.js` that forwards to the sidecar.

4. **Extension integration** (`dist/extension-wasm/background.js`):
   - After local YOLO fallback returns 0 cards, if `probeBackend()` says backend is reachable, call `/api/zero-shot-detect` with the captured viewport
   - Treat any returned box as a card candidate → feed CLIP → fuse → price

5. **Auto-add zero-shot hits to review queue** — anything the local model missed but zero-shot found is a prime candidate for the next retrain.

**Validation:** On a test corpus of 20 pages where current model finds 0 cards, zero-shot path finds ≥ 70%.

**Rollback:** Shut down the sidecar. Extension gracefully degrades back to local-only pipeline.

**Expected impact:** covers the long tail where our local YOLO is OOD. Especially FB Marketplace lightboxes, Instagram, novel marketplace UIs.

---

## 8. Phase 6 — DINOv3 embedding swap (optional)

**Entry criteria:** None — independent track. Only pursue if identification accuracy on real marketplace shots is still weak after Phases 1-3.

### Steps

1. **Benchmark first** — don't commit effort if the current CLIP ViT-B/32 is already pulling its weight. Build `scripts/eval_embedder.py` that measures top-1 and top-5 catalog match accuracy against `tests/marketplace-held-out` with the current CLIP vs DINOv3.

2. If DINOv3 wins by ≥ 5%, proceed:

   - Download `facebook/dinov3-small-16` (~22M params)
   - Export to ONNX int8 (~90 MB)
   - **Re-embed** the full 21,669 catalog with DINOv3 (one GPU hour) → new `catalog.bin.gz`
   - Update `lib/embed.js` to use DINOv3 preprocessing (slightly different normalization constants)
   - Update `model-manifest.json` with new embedder + catalog versions

3. **Backward compat** — ship DINOv3 as a NEW catalog file alongside the CLIP one. Extension can pick based on manifest. Rollback is just reverting the manifest.

**Validation:** Top-1 catalog match accuracy on `tests/marketplace-held-out-identity` must improve by ≥ 5%.

**Expected impact:** better identification on near-duplicate art (reprints), especially where CLIP ties multiple sets.

---

## 9. Shipping checklist (every model release)

Before uploading any new `card_detect.onnx` to a public release:

- [ ] `python detect/eval_shipping.py --model <new> --baseline <current>` returns exit 0
- [ ] `python detect/stress_test_multi.py` all cases pass
- [ ] `node test-page-scan.js` end-to-end still passes locally
- [ ] `node test-hibid-fb.js --url=http://127.0.0.1:7788/multi.html` finds ≥ 2 cards
- [ ] SHA256 computed and added to `model-manifest.json`
- [ ] `min_extension_version` set so old extension builds don't try to use a format they can't parse
- [ ] Rollback plan documented in release notes (prev manifest archived as `v<n-1>.json`)

---

## 10. Timeline

Assuming 1 engineer at ~6 productive hours/day:

| Day | Workstream A (main) | Workstream B (parallel) |
|---|---|---|
| 1 | §2 Shared infra | — |
| 2–3 | Phase 1 — fine-tune + ship | Phase 5 — Grounding DINO sidecar |
| 4–6 | Phase 2 — OBB upgrade | Phase 5 — extension integration |
| 7–8 | Phase 3 — telemetry client + endpoint | Phase 6 — DINOv3 benchmark (gate: do we even bother?) |
| 9–11 | Phase 3 — pseudo-label + retrain wiring + first promotion | Phase 6 — if gate passed, swap embedder |
| 12–13 | Phase 4 — review UI | buffer |
| 14 | Integration smoke test on all 3 real sites + hibid-fb test | — |
| 15 | Ship v3.0 bundle (new model + extension + manifest), monitor | — |

Three weeks of calendar time if interruptions / meetings eat half the day.

---

## 11. Known risks + mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Pseudo-labels poison the model (confirmation bias) | HIGH | Hard conf threshold 0.80, aug-consistency check, **held-out real validation never seen in training**, mAP@50 ≥ 0.95 gate in `retrain.py` already enforces this |
| Telemetry privacy backlash | HIGH | Opt-in default off, strip URL/EXIF/HTTP headers, document exactly what's sent (link to source), one-click disconnect, allow user to point at their own endpoint |
| OBB breaks axis-aligned callers | MEDIUM | Payload stays `[x1,y1,x2,y2,...]` with 4 or 8 numbers; downstream code checks length. Fall back to AABB when `angle < 5°`. |
| GitHub Release storage limits | LOW | Each release is < 500 MB; GitHub allows up to 2 GB per asset, unlimited release count |
| Grounding DINO sidecar flakes / crashes | LOW | Server has 2 s timeout + 3-attempt retry (existing pattern in `pricing.js`); extension gracefully degrades |
| Our YOLO beats DINOv3 after Phase 1 and we waste Phase 6 effort | LOW | Phase 6 starts with a benchmark gate — don't commit until the gate passes |
| User can't tell if auto-update made things worse | MEDIUM | Keep last 3 model versions in cache; add "Revert to previous model" button in Settings |

---

## 12. Owner / contact map

Fill in before kicking off:

| Component | Owner | Notes |
|---|---|---|
| Shared infra (§2) | | |
| Phase 1 fine-tune | | |
| Phase 2 OBB | | needs frontend eng for `rectify.js` warp |
| Phase 3 telemetry pipeline | | needs legal review on privacy copy |
| Phase 4 review UI | | lowest priority, defer if under time pressure |
| Phase 5 Grounding DINO | | independent, no dependency on others |
| Phase 6 DINOv3 | | optional, gated on benchmark |
| GitHub Releases publishing | | needs repo-write access |
| Opt-in telemetry endpoint | | needs R2/S3 account + domain for `/api/telemetry/scan` |

---

## 13. If you only have 3 days

Skip to this subset. It delivers 70% of the value:

1. **Day 1:** §2 shared infra (eval harness, dataset mixer) + Phase 1 data collection (Roboflow + 50 hand-labels)
2. **Day 2:** Phase 1 train + ship v3.0 model + Phase 5 server-side Grounding DINO
3. **Day 3:** Smoke test everything, publish manifest, write release notes

That gives you: better detector + zero-shot fallback. Skip OBB, telemetry, review UI, DINOv3. Revisit when you have more time or if the metrics after week 1 show you need them.
