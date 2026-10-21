# Plan: make the recognizer accurate on small, blurry, Marketplace-quality card crops

Written 2026-10-21 (America/New_York). This is a plan only: nothing has been trained, pushed or released.
It is written so that Claude Code on the owner's Windows PC can run it step by step in PowerShell.
Each step lists its files, commands and a pass/fail check.

Read first: `HANDOFF.md`, `docs/improvement-plan.md` (Phases 5 and 8), and the 2026-10-20 failure analysis
(summarised in section 0; the full copy is `/workspace/recognition-research.md` on the agent box).

---

## 0. Where we are (measured, not estimated)

**Pipeline.** YOLO11n `card_detect.onnx` → card box → art crop (`lib/embed.js`: centred square of the top 45 % of
the card, resized to 224) → CLIP ViT-B/32 int8 (`clip_visual_int8.onnx`, about 89 MB) → cosine against
`catalog.bin.gz` (22,070 × 512 float32, about 42 MB gz) → optional `adapter.bin` (rank-32 residual map, a signed
bundle from `fabcrowd/card-scanner-data`) → `lib/fusion.js` gate.

**There is no text tower in the loop.** `catalog.bin` holds *image* embeddings of the catalog art, made by the same
visual tower. "Keeping the catalog in sync" means re-embedding all 22,070 rows, plus the nightly
`catalog-extra.bin` rows, with the exact int8 model that ships whenever the tower changes.

**FB photos, offline replica, 138 in-catalog cards (served resolution, no adapter):**

| Card height in photo | n | top-1 | top-5 | top-20 |
|---|---|---|---|---|
| < 100 px | 13 | 0 | 1 | 1 |
| 100–149 px | 33 | 1 | 3 | 9 |
| 150–199 px | 30 | 21 | 23 | 28 |
| 200–299 px | 57 | 42 | 48 | 51 |
| ≥ 300 px | 5 | 3 | 5 | 5 |

- **Below 150 px:** top-1 is **1 of 46**. Title OCR reads 0 of 46, and the collector number reads 0 of 138 at any size.
- **200–299 px:** crops are right **89 %** of the time (name level, extension).
- **FB11 in the extension:** **73 of 90 named rows** are right.
- **Formerly "not recognised" cards (guess-first):** the top guess is right about **10 %** of the time, and the top 5 contain it **25–30 %** of the time.
- **Live adapter** (`pack-20261018-2`, seed-trained): +6 top-1 overall (66 → 72). On small crops (< 200 px) it goes from 20 to 26 of 76.
- **Tried and rejected:**
  - Real-ESRGAN x4 super-resolution: −9 top-1. It invents texture that the clean catalog scans don't have.
  - Bicubic upscaling with unsharp: −6.
  - Crop-shift averaging: no gain, and scans took twice as long.
- **Bigger pixels help most.** Reading Facebook's original main photo took the 50-card lot from 3 to 12 right names. This is already on `feat/fb-accuracy-ui`.

**Why small crops fail.** At a card height of 120 px, the art square is about 54 px and gets upscaled 4× to 224 px. The
catalog side is a clean, sharp scan about 600 px tall. CLIP was never trained to map a 54 px art patch with JPEG blocks,
sleeve shine and glare to the same point as the clean scan.

The current seed augmentation (`pipeline/augment.py`) covers tilt, blur, glare, warm cast, noise and JPEG, but it has
**no downscale step**. So the adapter has never seen tiny inputs. That resolution gap is this plan's target.

The literature calls this resolution asymmetry in metric learning:
- [Suma et al., WACV 2023](https://openaccess.thecvf.com/content/WACV2023/papers/Suma_Large-to-Small_Image_Resolution_Asymmetry_in_Deep_Metric_Learning_WACV_2023_paper.pdf)
- [resolution-varying contrastive fine-tuning](https://www.mdpi.com/2076-3417/11/15/6783)
- [resolution augmentation](https://doi.org/10.48550/arxiv.2302.05621)

**Honest ceiling.** Below about 100 px card height, the art square is around 45 px and most of the card's identity is gone.
Training can't recover pixels that aren't there.

- Expect real gains at 100–200 px and modest gains below 100 px.
- Google Lens does better partly because it uses much larger models, a web-scale index and the listing's own text.
- Larger source photos remain the first lever.

---

## 1. Recommended path (summary)

1. **Phase 0: build the eval set first.**
   - Port the FB eval set and the offline replica into `card-scanner-data`, and add a scorer that reports by card height.
   - Grow the real FB set to at least 300 crops under 150 px. On 46 cards, a +3 change is noise.
2. **Phase 1: degraded data and an adapter retrain.** This runs on CPU, costs the least and needs no extension release.
   - Add a Marketplace degradation pipeline.
   - Rebuild `seed.npz` with small degraded views and let the nightly retrain `adapter.bin`.
   - Add a small-crop slice to the gate so the gain can register.
   - Optionally try degraded-view catalog rows (option d).
3. **Phase 2: fine-tune the CLIP image tower on the GPU.** This has the biggest expected gain.
   - Train LoRA or the last N blocks with a clean-to-degraded contrastive loss plus an ArcFace-style loss.
   - Add a distillation anchor on clean views, and use WiSE-FT weight interpolation to protect large-crop accuracy.
   - Export int8 with the same exporter, re-embed the catalog, re-gate, and release as `v3.0`.
4. **Phase 3: improve the detector.** Train on hard negatives (sleeves, inserts, backs, piles) and add SAHI-style tiling for dense lots.
5. **Phase 4 (optional): a backbone bake-off or a distilled small student.** Do this only if Phase 2 leaves a gap.
6. **Ongoing: the self-improvement loop** feeds real picked crops back into Phases 1 and 2.

**Expected result after Phases 1–2.** These are estimates, to be measured:

| Bucket | Today | After Phases 1–2 |
|---|---|---|
| < 150 px, top-1 | about 2 % | **17–30 %** |
| < 150 px, top-5 | about 9 % | **35–55 %** |
| 150–199 px | 70 % | **80–90 %** |
| ≥ 200 px | (baseline) | no loss, enforced by the gates in section 7 |

---

## 2. One-time setup on the PC (Phase 0a, about 1 h)

Paths assume the existing clone `C:\users\daroo\desktop\repos\cardscanner\pokemon-auto-lister`.

### 2.1 Check the GPU model and VRAM

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv
# If nvidia-smi is not found: the NVIDIA driver is missing, or the GPU is AMD/Intel (see the note below).
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion
```

- Record the GPU name, total MiB and compute capability in `card-scanner-data\train\MACHINE.md`.
- RTX 50-series cards (compute 12.x) need the CUDA 12.8 PyTorch wheels. Older RTX cards work with cu126 or cu128.
- **AMD or Intel GPUs:** the CUDA wheels won't work on Windows. Either use WSL2 with ROCm, or run only Phases 1 and 3 on CPU and rent a cloud GPU for Phase 2.

### 2.2 Clone the data repo and create a GPU venv (separate from CI)

```powershell
cd C:\users\daroo\desktop\repos\cardscanner
if (-not (Test-Path card-scanner-data)) { git clone https://github.com/fabcrowd/card-scanner-data.git }
cd card-scanner-data
git switch -c feat/blurry-training
py -3.12 -m venv .venv-gpu
# If activation is blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\.venv-gpu\Scripts\Activate.ps1
python -m pip install --upgrade pip
# Take the exact line for your CUDA from https://pytorch.org/get-started/locally/ ; cu128 covers RTX 20xx-50xx:
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
pip install open_clip_torch peft onnx onnxruntime==1.31.0 numpy pillow opencv-python-headless albumentations pytest
python -c "import torch;print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0), round(torch.cuda.get_device_properties(0).total_memory/2**30,1),'GiB')"
```

- `onnxruntime==1.31.0` matches `requirements.txt`, so embeddings made on the PC equal the nightly's.
- The GPU packages go in a new `train/requirements-gpu.txt`. CI never installs it and keeps using the hash-pinned `requirements.txt`.

### 2.3 Choose settings by VRAM

`train/finetune_clip.py --profile auto` reads `torch.cuda.get_device_properties(0).total_memory` and picks a row:

| VRAM | Phase 2 trainable part | Batch (pairs) | Other |
|---|---|---|---|
| < 6 GB | LoRA r=8 on attention + MLP of the last 6 blocks | 64, grad-accum 4 | gradient checkpointing; or skip Phase 2 and do Phase 1 + (d) |
| 6–8 GB | LoRA r=16 on all 12 blocks | 128, accum 2 | checkpointing on |
| 10–12 GB | last 4 blocks full + LoRA r=16 on the rest | 256 | checkpointing off |
| 16 GB | last 6 blocks full | 384 | |
| ≥ 24 GB | full visual tower (layer-wise LR decay 0.7) | 512 | |

- **Precision:** bf16 autocast on Ampere (RTX 30xx) and newer. Use fp16 with GradScaler on Turing (RTX 20xx, GTX 16xx).
- **YOLO11n (Phase 3) batch size:** `batch=16` fits in 4 GB, use `batch=32` at 8 GB, and `batch=-1` (auto) above that.

### 2.4 Local data (never committed, because both repos are **public**)

- **Catalog art.**
  - `pokemon-auto-lister\data\card-catalog\images` already exists on the PC, per HANDOFF.
  - If any images are missing, run `python scripts\fetch_catalog_art.py --meta assets\meta.json --out ..\pokemon-auto-lister\data\card-catalog\images`.
  - This new script downloads `imageUrl` from tcgdex. It is resumable, makes at most 4 requests/s and skips existing files.
  - For 22,070 cards, expect 1–3 h and 2–4 GB.
- **Models.** Run `python scripts\fetch_assets.py` (it already exists), or copy `clip_visual_int8.onnx`, `catalog.bin.gz`, `id_map.json`, `meta.json` and `card_detect.onnx` into `assets\`.
- **FB eval pack.** `/workspace/fb-eval-pack.zip` on the agent box (3 MB) holds:
  - the 11 served photos and 2 originals,
  - `truth.json` (157 reviewed boxes, each with a label),
  - the replica scripts `pipe.py` and `analyze.py`.

  Expand it into `card-scanner-data\data\`. Do not commit these images: they are other people's listing photos.

Add these to `.gitignore`: `data/`, `runs/`, `train/out/`, `assets/`, `*.pt`, `*.safetensors`.

---

## 3. Data

### 3.1 Degradation pipeline: `pipeline/degrade.py`

This is a new module, written in PIL + numpy only so the nightly can import it.

`marketplace_view(card_img, seed, height=None) -> PIL.Image` is deterministic per seed, like `augment.photo_like`.

- It works on the **whole card** at its final small size.
- The embedder then takes the art crop exactly as `lib/embed.js` does: `embed.art_rect`, then PIL bicubic to 224 px.
- The order matters because the art square is about 0.45 × the card height.

| # | Step | Range / probability | Why |
|---|---|---|---|
| 1 | Box jitter (the detector box is loose or tight) | ±6 % per side, p=0.8 | 40 of 138 FB boxes are off-aspect; their top-1 was 40 % vs 52 % |
| 2 | Perspective + rotation | corners ±6 %, rotation ±8°, p=0.7 | tilted cards in binders and lots |
| 3 | Sleeve / toploader / binder pocket | p=0.6: a semi-transparent 2–8 % border (for a toploader, a thick clear edge with a grey rim), a plastic tint and 1–3 specular streaks. p=0.15: a pocket edge line | almost every FB card is sleeved |
| 4 | Glare / sheen | the existing `_glare`/`_sheen` at p=0.4, plus a 5 % chance of a blown-out patch covering 5–25 % of the art | glare bucket E |
| 5 | Partial occlusion | p=0.25: a neighbouring card or finger covers 5–20 % from one side | piles, overlapping lots |
| 6 | Colour cast + exposure | white-balance gains matching 2,800–7,500 K, gamma 0.8–1.25, saturation 0.7–1.2, p=0.8 | indoor phone light |
| 7 | Motion / defocus blur, applied **before** step 8 at full size | Gaussian σ 0.3–1.2, or 2–5 px of linear motion, p=0.35 | hand-held shots |
| 8 | **Downscale to the target card height** | 40–200 px, with 40 % of the weight in 60–150 px. The filter is picked at random from area, bilinear, bicubic and lanczos | the main gap; `augment.py` has no downscale at all |
| 9 | Phone pipeline | ISO noise σ 2–10 (chroma + luma) at p=0.7; phone over-sharpening (unsharp r=1, 30–120 %) at p=0.4 | phone JPEGs are noisy and over-sharpened |
| 10 | Double JPEG on the photo grid | First a phone save at q 85–95. Then a random 0–7 px offset (so blocks misalign) and a Facebook re-encode at q **30–80** with 4:2:0 chroma | FB serves 720×960 re-encodes |

Notes:

- **Albumentations** has tested versions of most of these steps (`Downscale`, `ImageCompression`, `ISONoise`, `Perspective`, `RandomSunFlare`). See https://albumentations.ai/docs/api-reference/albumentations/augmentations/pixel/compression/ and https://albumentations.ai/docs/api-reference/augmentations/transforms/ .
  - The nightly can't install Albumentations (CI is hash-pinned), so `pipeline/degrade.py` stays PIL/numpy.
  - `train/` may use Albumentations for speed, but its output must match the same distribution. A test compares sharpness and blockiness histograms.
- **Where the idea comes from.** The high-order, shuffled degradation model comes from BSRGAN (https://arxiv.org/abs/2103.14006) and Real-ESRGAN (https://arxiv.org/abs/2107.10833).
  - Their super-resolution model hurt us at inference.
  - Their *degradation synthesis* is the right tool for making training data.
- **Calibrate against real crops.**
  - For each real FB eval crop, measure the Laplacian variance of the art at native size and the 8×8 JPEG blockiness.
  - Tune the ranges until the synthetic histograms overlap the real ones.
  - `scripts/degrade_report.py` (new) writes a contact sheet to `data/reports/degrade-vs-real.png` with both histograms.
- **Tests** in `tests/test_degrade.py`:
  - output is deterministic per seed,
  - output height stays within range,
  - the art crop is identical to `embed.art_rect`,
  - nothing breaks on 40 px or odd-aspect inputs.

### 3.2 Training sources

| Source | What | Use | Where it comes from |
|---|---|---|---|
| Catalog art (22,070) | clean scan per card | anchor (clean view) **and** degraded views (positives) | `data/card-catalog/images` |
| Owner corrections | crop + picked card id | real positives, weight ×4 | extension Options → **Export corrections** (JSON with crops; `background.js exportCorrections`) → `scripts/import_corrections.py` (new) |
| Community `inbox`, **teach** split only | relay contributions: crop (≤ 400 px, base64) + answer | real positives after consensus (2 installs on 2 days) or owner review | `git fetch origin inbox` → `scripts/harvest_inbox_crops.py` (new; reuses `pipeline/contributions.build_samples(split="teach")`) |
| Community pack | promoted reference rows (embeddings only) | adapter pairs (already wired in `run.py`) | nightly |
| Existing labelled crops | `variant-photos`, `edition-crops` | real positives (already used by `build_seed.py`) | `data/` |

The exam split of the community `inbox` is never trained on.

Rules:

- **Banned sources.** `pipeline/seed.FORBIDDEN` already lists `hibid`, `sealed-test` and `realworld`. Add `fb-eval`, so no build can ever train on the eval set.
- **Dedupe.** Remove real crops that match the eval set by listing id or by dHash (Hamming distance ≤ 6). Lots get relisted.
- **Same-art groups.** Many catalog rows share an illustration: reprints, promos, and the same art across sets.
  - Build `data/same-art.json` once. Group rows whose clean embeddings have cos ≥ 0.95 under the current model, or that share the name and artist.
  - In contrastive losses, don't treat rows in the same group as negatives. Otherwise training fights label noise it can't win.
  - CollectorVision trains illustration labels as a separate task for the same reason: https://github.com/HanClinto/CollectorVision .

### 3.3 Held-out real FB eval set

The images live locally in `data/fb-eval/`. The new script `scripts/build_fb_eval.py` builds the set from them.

**Size.** Start from the 11 photos: 138 in-catalog boxes, 46 of them under 150 px. Before this set gates Phase 2, grow it to:
- **≥ 60 listings,**
- **≥ 600 boxes,**
- **≥ 300 boxes under 150 px.**

At n=46, the 95 % interval on a 10 % rate is about ±9 points.

**Collect:**
- Save the served photos **and** the original main photo (drop `ctp=` from the `og:image` URL) into `data/fb-eval/<listing-id>/`. Do it promptly, because fbcdn URLs expire.
- Favour lots, binder pages and toploader stacks.
- Include some single-card listings so large crops stay represented.

**Labelling guidance.** Write this into `data/fb-eval/LABELLING.md` and follow it exactly.

1. **Propose and review.** Run `scripts/build_fb_eval.py propose` to get detector boxes, then review **every** box on the contact sheet.
   Never accept proposals as truth: unreviewed full-frame labels are how the 2026-09 detector got poisoned.
2. **Label on the original** when there is one, then carry each label to the served copy by IoU ≥ 0.5.
3. **Give each box exactly one label:**
   - `card:<catalog id>` when the exact printing is certain.
   - `name:<card name>` when only the name is certain. These are scored at name level only.
   - `#noncard` for an insert, empty sleeve or divider.
   - `#back` for a card back.
   - `#pile` for a stack of cards.
   - `#partial` when less than 60 % of the card is visible, or it is cut off by the photo edge.
   - `#merged` when one box covers two or more cards.
   - `#offcatalog` for non-English cards or cards not in the catalog.
   - `#unsure` when you can't tell. These are excluded from scoring.
4. **Confirm by eye.** The seller's title is only a hint. Check each card against the catalog image (`imageUrl`).
5. **Record** `readHeight` (the box height in pixels at the resolution the extension reads) and `source` (`served` or `original`).
6. **Second pass.** A second reviewer, or Claude Code with side-by-side sheets, settles disagreements. Keep `labels.json` locally or in a private repo.
7. **Split by listing, never by box.** Once a listing is in `fb-eval`, its crops are banned from all training.

**Outputs:**
- `data/fb-eval/crops/*.jpg`
- `data/fb-eval/manifest.jsonl`, with crop, truth, kind, readHeight, bucket and listing for each box.
- `regression-small.npz` for the nightly gate. It holds embeddings and card ids only, no images, the same policy as `regression.npz`.

**Synthetic small set, for development only.** `scripts/build_synth_small.py` takes 2,000 random catalog cards and degrades them at fixed heights of 60, 90, 120, 150 and 200 px, using seeds that are never used in training. It is the fast inner-loop metric, but **not** a ship gate: the catalog images are themselves the training anchors.

---

## 4. Model options, ranked by browser feasibility

**Runtime today.**
- onnxruntime-web **1.17.3, WASM only**: `vendor/ort.wasm.min.js`, with `numThreads = 1` in the service worker.
- Hashes are pinned in `scripts/vendor-hashes.json`, and assets in `lib/setup.js ASSETS`.
- So any model must stay WASM-friendly int8.

### (a) Retrain the adapter on degraded data

This is the cheapest option. There is no new model, and it ships through the nightly bundle.

- **What to build.** Extend `scripts/build_seed.py` with `--degrade marketplace --per-card 3 --heights 40:200 --dtype float16`.
  - Real crops come first, as now.
  - Then add 3 `marketplace_view` variants per catalog card.
  - Add one `photo_like` variant per card too, so medium-size photos aren't forgotten.
  - That makes about 88k pairs.
  - Store them as float16 so `seed.npz` stays under 50 MB (GitHub's limit is 100 MB). The loader upcasts them.
- **Training.**
  - `pipeline/train_adapter.train` stays as it is: numpy, softmax over the whole adapted catalog, and it ships only if it beats identity on a 10 % hold-out.
  - At batch 128, 88k pairs is about 690 steps per epoch, so raise `max_seconds` to 900 and the workflow `timeout-minutes` if needed.
  - Also try rank 64. `adapter.bin` v1 allows any rank, and the file would be 64 KB.
- **Embedding time.** Embedding 88k crops with the int8 model takes about 20–40 min on the PC's CPU with 8 workers. GPU onnxruntime barely speeds up the dynamic-int8 graph, so CPU is fine.
- **Expected gain:**
  - Under 150 px: top-1 rises from 1 to 3–6 of 46, and top-5 from 4 to 8–12.
  - 150–199 px: +2 to +4.
  - Basis: the current seed adapter gained +6 top-1, and +6 under 200 px, without any downscale step.
- **Risk to large crops: low.**
  - It is a rank-32 residual, gated against identity and HiBid.
  - Watch `wrongHigh`. Adapter-changed answers are advisory and never "high" (`gate.py`).
- **Delivery.**
  - Commit the new `seed.npz` to `card-scanner-data` `main`. The nightly then trains, gates, signs and publishes `adapter.bin`.
  - **No extension release is needed.**
  - The gate must be able to see the gain, so also add the `regression-small.npz` slice (section 7.3).

### (d) Multi-resolution catalog rows

This is cheap and needs no new model, but it does need a small extension change.

- **What to build.**
  - For each card, embed K=4 degraded views at 60, 90, 120 and 150 px.
  - Store their re-normalised **mean** as one small-view row per card.
  - In the community-pack int8 format (`pack.py`), 22,070 × 512 int8 is 11.3 MB.
  - A variant keeps two rows per card (60–100 px and 100–150 px), which is 22.6 MB.
- **How the extension uses it.**
  - Search these rows only when `readHeight < 150`.
  - Use `max(clean, small)` per card, or treat the small row as a second vote.
  - A match on a small-view row is never shown as sure.
- **Files:**
  - `scripts/build_small_rows.py`
  - a bundle part `catalogSmall` (`manifest.ASSET_FILES`, `lib/bundle.js`), or a release asset
  - `lib/search.js` (option `smallRows`)
  - `background.js` (pass `readHeight`)
  - tests
- **Expected gain.**
  - Under 150 px: +1 to +3 top-1 and +2 to +5 top-5. It partly stacks with (a).
  - It can be measured offline on CPU **today**, before any extension work.
- **Risk: hubness.** Blurry rows look alike, so they can attract wrong matches.
  - Correct for it CSLS-style, using the existing `build-hub-penalty.py`.
  - Use the rows only for small crops, so there is no risk to large crops.

### (b) Fine-tune the CLIP image tower

This has the biggest expected gain, with the same model size and the same runtime.

- **Architecture.**
  - Keep ViT-B/32 with a 224 input, so the graph, size (about 89 MB int8), speed and preprocessing don't change.
  - Train LoRA (https://arxiv.org/abs/2106.09685, https://huggingface.co/docs/peft) or the last N blocks, depending on VRAM (section 2.3).
- **Batches.** Each batch has P cards × 2 views:
  - a **clean** view: catalog art with light photometric jitter and ±3 % box jitter;
  - a **degraded** view from `marketplace_view`.
  - Real crops (owner corrections and consensus teach rows) join as extra degraded positives, oversampled ×4.
  - Hard batches: half of each batch comes from the 50 catalog neighbours of a random card, which brings in look-alikes and the same Pokémon across sets.
- **Loss.**
  `L = InfoNCE(degraded↔clean, symmetric, learnable τ starting at 0.05, same-art masked)`
  `+ 0.5 · ArcFace(both views → 22,070-way head; s=32, m=0.2; sub-center k=2 for noisy real labels)`
  `+ 1.0 · (1 − cos(f_θ(clean), f_0(clean)))`
  - The last term anchors clean-view embeddings to the frozen original tower, which protects large-crop accuracy.
  - Initialise the ArcFace head from the current catalog embeddings. This is the LP-FT idea: start from a good head so early training doesn't distort the backbone (https://arxiv.org/abs/2202.10054).
  - References: ArcFace https://arxiv.org/abs/1801.07698 ; sub-center ArcFace https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123560715.pdf ; https://kevinmusgrave.github.io/pytorch-metric-learning/
- **Schedule.**
  - AdamW: LR 1e-5 on full blocks and 1e-4 on LoRA, weight decay 0.05.
  - Cosine decay after 1 warm-up epoch, for 10–20 epochs. Each epoch is 22,070 cards × (1 clean + 2 degraded) views.
  - Evaluate on the synthetic small set and the FB set after every epoch.
- **WiSE-FT.**
  - Interpolate `θ = (1−α)·θ0 + α·θ1` for α ∈ {0.3, 0.5, 0.7, 1.0}.
  - Keep the largest α that passes **every** gate in section 7 (https://arxiv.org/abs/2109.01903 ; https://github.com/mlfoundations/wise-ft).
  - This is the main insurance against losing large-crop accuracy.
  - With LoRA, run `merge_and_unload` first, then interpolate.
- **Re-embed the catalog.**
  - Embed all catalog rows with the **int8** ONNX model, using the same `embed.preprocess`. The script is `train/embed_catalog.py`; it writes `catalog.bin.gz`, and `id_map.json` is unchanged.
  - Gate on int8 numbers, not fp32, because quantization error interacts with fine-tuning.
- **Time.**
  - About 176k forward/backward passes per epoch: 2–4 min per epoch on a 4090, or 8–15 min on a 3060 12 GB.
  - 15 epochs plus the 4-point α sweep: 1–4 h of GPU time.
  - Re-embedding the catalog (int8, CPU): 15–30 min.
- **Expected gain (an estimate, not measured here):**
  - Under 150 px: top-1 8–15 of 46 (17–33 %), top-5 15–25 (33–55 %).
  - 150–199 px: from 21 to 24–27 of 30.
  - 200 px and up: unchanged, because the gates require it.
- **Risks.**
  1. Large-crop regression. Mitigated by WiSE-FT, the clean anchor and the gates.
  2. Everything keyed to the model has to be redone (section 6.2).
  3. Overfitting to catalog art. The real FB set is the judge, never the synthetic set.

### (c) Small dedicated model, distilled student, or another backbone

This needs the most engineering. Do it only if (b) leaves a gap.

- **Zero-training bake-off first** (`train/bakeoff.py`). Embed the FB eval crops and the catalog with each candidate, and report top-1 and top-5 by height bucket. Candidates:
  - DINOv2-S/14: https://github.com/facebookresearch/dinov2
  - MobileCLIP2-S0: https://huggingface.co/apple/MobileCLIP2-S0 ; ONNX https://huggingface.co/plhery/mobileclip2-onnx
  - SigLIP2-B/16: https://huggingface.co/collections/upshift/siglip-2-for-the-browser-onnx-webgpu

  DINOv2 leads CLIP on instance retrieval (https://arxiv.org/abs/2304.07193), but that is unproven on 50 px art.
- **Student model.**
  - A MobileNetV3-Large (https://arxiv.org/abs/1905.02244) or EfficientNet-Lite0 embedding with 256 dimensions.
  - Train it with feature distillation to the fine-tuned CLIP on clean views, plus the same InfoNCE/ArcFace losses on degraded views.
  - About 5–8 MB in int8, roughly 10× faster in WASM, and its own 22,070 × 256 int8 catalog of 5.6 MB.
  - Use it **only as a second opinion for crops under 150 px** (rank fusion with CLIP), never as the main recognizer.
- **Expected gain:** unknown until the bake-off.
- **Risk:** a second model to version, hash and gate. Alone it is likely worse than CLIP at 200 px and up.

### Ranking

| Option | Browser feasibility | Small-crop gain | Large-crop risk | Effort |
|---|---|---|---|---|
| (a) adapter on degraded data | uses the existing shipping channel | + | low | 2–3 days, CPU |
| (d) small-view catalog rows | small extension change, +11 MB | + | none (used for small crops only) | 1–2 days |
| (b) fine-tuned CLIP tower | same graph, same size | ++ (largest) | medium, low with WiSE-FT + gates | 4–7 days, GPU |
| (c) student or new backbone | new model + catalog | ? | medium | 1–2 weeks |

---

## 5. Detector (Phase 3)

The current detector lives in `tools/vellum-ai/detect/` (YOLO11n, classes `full_card`, `corner_closeup`, `card_back`). `lib/detect.js` treats **any** class as a card. In the FB photos, 16 of 158 boxes were not single cards. That is 10 % of rows, and each one shows up as "not recognised".

**Hard negatives (first try, no class change):**
- **Collect** FB lot frames that contain empty sleeves, Neo inserts and dividers, toploader stacks, piles, sealed product and empty binder pockets.
- **Label every real card fully** and leave the negatives unlabelled. YOLO treats unlabelled area as background.
- **Add 5–10 % pure background images** (empty `.txt` label files), taken from the same domain. See https://docs.ultralytics.com/yolov5/tutorials/tips-for-best-training-results and https://github.com/ultralytics/ultralytics/issues/12941 .
- **Label card backs as `card_back`** (class 2), so the UI can say "card back" instead of "not recognised".
- **Add `tools/vellum-ai/detect/mine_hard_negatives.py`** (new). It proposes the boxes the current model fires on, and a reviewer marks which are negatives. `label_marketplace.py` already requires reviewed sidecars.
- **If false positives stay high,** add a class 3 `not_card` and exclude it in `lib/detect.js` (a one-line filter plus a test). This changes the ONNX output width, so it is a new asset version.
- **CLIP-side backstop:** the existing `check.bin` path (`train_check.py`, the "not a card" vote). Seed it with the 16 labelled non-card crops.

**SAHI-style tiling for dense lots** (https://arxiv.org/abs/2202.06934 ; https://docs.ultralytics.com/guides/sahi-tiled-inference/):
- **Measured so far:** 2×2 tiles with 40 % overlap add 1–2 real cards per 50-card photo.
- **When to tile:** only when the full pass finds ≥ 20 boxes, or the median box height is under 10 % of the photo height.
- **Merging:** merge tile results with NMS at IoU 0.5, and drop tile-edge partials (reuse the edge-cut rule from e48c421).
- **Training:** add `make_tiles_dataset.py` (new). It cuts training lots into 640 px tiles so small cards appear at tile scale, and the ONNX input stays 640.
- **Extension:** add `lib/detect.js detectTiled()` behind a flag. It runs about 5 detector passes, on dense photos only.

**Gate (from `tasks/lessons.md`):**
- Never promote a detector on mAP or box counts.
- Run the Chrome lot harness (`.tmp/lots/run.mjs` + `analyze2.py`) and the FB sets, and gate on **right and wrong names**. v7b passed offline but still added 7 confident wrong names.
- Train with `python tools\vellum-ai\detect\train_detect.py --epochs 80 --name card_detect_v8`, then export with `imgsz=640, simplify=True` to match `lib/detect.js`.

---

## 6. Export, size and versioning

### 6.1 CLIP export

`train/export_onnx.py` (new) loads the merged, WiSE-interpolated checkpoint into `open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")`. It then uses **exactly** the settings of `pokemon-auto-lister/scripts/export_clip_onnx.py`:
- the legacy exporter (`dynamo=False`) at opset 14;
- input `pixel_values` [batch, 3, 224, 224] and output `image_embeds`, L2-normalised;
- `quantize_dynamic(weight_type=QuantType.QUInt8)`.

That graph already runs in ort-web 1.17.3 WASM, so the vendor files don't change.

- **Parity check:** on 500 random crops, int8 vs fp32 cosine similarity must be ≥ 0.98 (median ≥ 0.99). Compare top-1 on the eval sets and gate on int8.
- **If int8 loses more than 1 point on any gate:** try `quantize_static` QDQ with per-channel weights, calibrated on 300 clean and 300 degraded crops (https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html). **Confirm it loads in ort-web 1.17.3 WASM** before relying on it.
- **Size budget:**

  | Asset | Budget |
  |---|---|
  | CLIP int8 | ≤ 90 MB (as now) |
  | `catalog.bin.gz` | ≤ 45 MB (same shape) |
  | Option (d) small-view rows | +11 MB |
  | Detector | ≤ 11 MB |
  | Student, if any | ≤ 8 MB, plus a 6 MB catalog |

- **WebGPU is out of scope here.** The vendored build is WASM-only, and the service worker can't host WebGPU. The WebGPU EP doesn't cover dynamic-int8 `MatMulInteger`, so it would need an fp16 model (about 176 MB), an offscreen document, an ORT upgrade and new `vendor-hashes.json` entries via `scripts/setup_vendor.ps1`. Revisit it only for speed: https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html , https://github.com/huggingface/transformers.js/issues/1512 .

### 6.2 Releasing a new CLIP and catalog (`v3.0` in the code repo)

1. **Release:** upload `clip_visual_int8.onnx` and `catalog.bin.gz` to a new GitHub release `v3.0`. `id_map.json` and `meta.json` are unchanged. Assets are cached by URL, so existing installs fetch only the changed files.
2. **Extension asset list:** in `tools/extension-wasm/lib/setup.js ASSETS`, set `release: "v3.0"` and the new `sha256` and `bytes` for those two entries.
3. **Data repo pins:** update `card-scanner-data/pins.json` with the same assets and hashes, plus the refit `reference`, `accept` and `highTier` values.
4. **Refit thresholds:** similarity distributions shift after fine-tuning. Refit `lib/fusion.js` (`MIN_ACCEPT_SIM .72`, `CLEAR_GAP .02`, `HIGH_SIM .85`) with `tools/vellum-ai/calibrate_accept.py` on held-out data, not the gate sets. Rebuild the hub penalty with `scripts/build-hub-penalty.py`.
5. **Rebuild model-keyed data** with the new int8 model passed as `--model`: `seed.npz`, `regression.npz`, `regression-small.npz` and the option (d) rows.
   - The bundle is matched to the CLIP hash (`packBuild()` → `modelTags()`). The old adapter and memory pack are ignored until a bundle for the new hash is published.
   - Check that stale local reference fingerprints are dropped and re-embedded on a model change. Add a test if they aren't.
6. **`EMBEDDING_VERSION` stays 2** because the crop is unchanged.
7. **`scripts/vendor-hashes.json` is unchanged** because ORT stays at 1.17.3.

### 6.3 Adapter-only release (Phase 1)

- **No code release is needed.** Commit `seed.npz`, `regression-small.npz` and the gate change to `card-scanner-data` `main`. The nightly does the rest.
- **Rollback:** revert the commit, and the next nightly republishes. Sequence numbers only go up, so a rollback is a new run, never a replay.

---

## 7. Evaluation gates

### 7.1 Scripts

| Script | Repo | Measures |
|---|---|---|
| `scripts/eval_small.py` (new; ported from `/workspace/research/pipe.py` + `analyze.py`) | card-scanner-data | Offline replica: boxes → art crop → model → catalog, plus adapter and small rows. Reports top-1/5/20 at name and exact level by height bucket (< 100, 100–149, 150–199, 200–299, ≥ 300), wrong-at-high, and a McNemar paired test against a baseline JSON. Writes `data/reports/<run>.json` and `.md`. |
| `pipeline/gate.py` with `regression.npz` + `regression-small.npz` | card-scanner-data (nightly) | top-1, accepted right/wrong, abstain rate vs the live bundle |
| `scripts/eval_pokellector.py` (copy of `/workspace/evalq.py`) | card-scanner-data | the 102 Base Set cards at native, 137, 114 and 90 px |
| Chrome harness | pokemon-auto-lister | Unit tests, eslint, **3/3** Base Set, **22/22**, **pokellector 102/102**, FB11 shot + src, mp listings and fbo originals, scored with `fb/score.py` and `score.py`. Reports right (sure) / wrong (sure) / unknown. |
| Lot harness `.tmp/lots/run.mjs` + `analyze2.py` | pokemon-auto-lister | Detector changes only: right and wrong names on the 67 lot photos |

### 7.2 Ship gates

Every candidate must pass all of these. The baseline is HEAD 6405c03 + `pack-20261018-2`.

**No regression on large crops (hard requirements):**
- pokellector **102/102**, **3/3** and **22/22** stay the same.
- FB crops ≥ 200 px: top-1 at name level stays at or above the baseline (46/62 offline with the adapter).
- HiBid regression top-1 stays ≥ 0.5074.
- FB11 src: wrong (sure) ≤ 3. FB11 shot: wrong (sure) ≤ 5. The right count doesn't drop in either mode.
- `evalq` numbers at native size and at 137 px don't drop.

**Small-crop targets.** Compare on the same crops with a paired test (p < 0.05 once n ≥ 300).

| Bucket | Today | Phase 1 target | Phase 2 target | Stretch |
|---|---|---|---|---|
| < 150 px top-1 (name) | 2 % (1/46) | ≥ 8 % | **≥ 20 %** | 30 % |
| < 150 px top-5 (name) | 9 % (4/46) | ≥ 20 % | **≥ 45 %** | 60 % |
| 150–199 px top-1 | 70 % (21/30) | ≥ 75 % | **≥ 85 %** | 90 % |
| Guess-first rows, top guess right | ~10 % | ≥ 15 % | **≥ 25 %** | 35 % |
| Guess-first rows, right in top 5 | 25–30 % | ≥ 35 % | **≥ 50 %** | 65 % |
| FB11 src right (sure) / wrong (sure) | 73 (57) / 17 (3) | right ≥ 75, wrong-sure ≤ 3 | right ≥ 80, wrong-sure ≤ 3 | |

**Calibration:** on the FB set, no more than 5 % of "sure" rows may be wrong. If more are, refit the thresholds.

### 7.3 Make the nightly see small-crop gains

`gate.py` scores HiBid listing crops only, so a small-crop gain can register as "no gain".

- **Code:** add an optional `regression-small.npz` slice to `pipeline/regression.py` and `run.py`.
- **New rule in `gate.better_outcome`:**
  - HiBid top-1 after ≥ before,
  - **and** small-slice top-1 after > before,
  - **and** `acceptedWrong` doesn't rise on either set.
- **Tests:** `tests/test_gate.py`, `tests/test_run.py`.
- **Data:** the slice comes only from `fb-eval` listings, which are banned from training.

---

## 8. Phases, time and exact steps

Each step is one Claude Code task. Suggested prompt: *"Do step X.Y of docs/blurry-training-plan.md, stop at its check, and report the numbers."*

- Commit once per step, on `feat/blurry-training` in `card-scanner-data`.
- Code-repo changes go on their own branch in `pokemon-auto-lister`.
- Nothing is pushed or released without the owner's OK.

### Phase 0: measure first (1–2 days)

| Step | Do | Check |
|---|---|---|
| 0.1 | Section 2 setup, GPU check, venv | `torch.cuda.is_available()` is True; `MACHINE.md` is filled in |
| 0.2 | Expand `fb-eval-pack.zip` into `data\`. Write `scripts/eval_small.py` from `pipe.py` and `analyze.py` | It reproduces the section 0 table (±1 per bucket) |
| 0.3 | Run `eval_small.py` with `--adapter` pointing at the `pack-20261018-2` `adapter.bin` | 72/138 top-1; < 200 px: 26/76 (±1) |
| 0.4 | `fetch_catalog_art.py`, then `build_synth_small.py --cards 2000 --heights 60,90,120,150,200 --seed 9001` | Synthetic top-1 by height; baseline JSON saved |
| 0.5 | Collect 20+ more listings and label them (section 3.3) with `build_fb_eval.py propose` / `build` | ≥ 300 boxes; contact sheets reviewed twice |

```powershell
cd C:\users\daroo\desktop\repos\cardscanner\card-scanner-data
.\.venv-gpu\Scripts\Activate.ps1
Expand-Archive -Path $HOME\Downloads\fb-eval-pack.zip -DestinationPath data -Force
python scripts\fetch_assets.py
python scripts\eval_small.py --set fb --model assets\clip_visual_int8.onnx --catalog assets\catalog.bin.gz --meta assets\meta.json --out data\reports\baseline.json
python -m pytest -q
```

### Phase 1: degraded data and adapter (2–3 days, CPU is enough)

| Step | Do | Check |
|---|---|---|
| 1.1 | Add `pipeline/degrade.py`, `tests/test_degrade.py` and `scripts/degrade_report.py` | Tests pass. Synthetic and real sharpness/blockiness histograms overlap (KS statistic < 0.15) |
| 1.2 | `build_seed.py --degrade marketplace --per-card 3 --heights 40:200 --dtype float16`; add `fb-eval` to FORBIDDEN | `seed.npz` < 50 MB; `test_build_seed.py` passes |
| 1.3 | `scripts/train_adapter_local.py` (new; wraps `pipeline.train_adapter.train`) at rank 32 and rank 64 | `eval_small.py --adapter` meets the Phase 1 targets and holds the large-crop gates |
| 1.4 | `regression-small.npz`, the gate change (section 7.3) and its tests | `python -m pytest -q`; dry-run `python -m pipeline.run` on a local copy of `inbox` |
| 1.5 | Option (d): `build_small_rows.py`, measured with `eval_small.py --small-rows` | Keep it only if top-5 under 150 px gains ≥ +2 and wrong-at-high doesn't rise |
| 1.6 | With the owner's OK: commit `seed.npz` and the gate change to `main`, then wait for the next nightly | The status release shows the adapter as `improved: true`. The extension re-run passes FB11, pokellector, 3/3 and 22/22 |

```powershell
python -m pytest -q tests\test_degrade.py
python scripts\degrade_report.py --real data\fb-eval\crops --catalog-images ..\pokemon-auto-lister\data\card-catalog\images --out data\reports\degrade-vs-real.png
python scripts\build_seed.py --data-dir ..\pokemon-auto-lister\data --meta assets\meta.json --catalog-images ..\pokemon-auto-lister\data\card-catalog\images --model assets\clip_visual_int8.onnx --out seed.npz --per-card 3 --degrade marketplace --heights 40:200 --dtype float16
python scripts\train_adapter_local.py --seed seed.npz --catalog assets\catalog.bin.gz --meta assets\meta.json --rank 32 --out train\out\adapter-r32.bin
python scripts\eval_small.py --set fb,synth --model assets\clip_visual_int8.onnx --catalog assets\catalog.bin.gz --meta assets\meta.json --adapter train\out\adapter-r32.bin --baseline data\reports\baseline.json --out data\reports\phase1-r32.json
```

### Phase 2: fine-tune the CLIP tower (4–7 days, GPU)

| Step | Do | Check |
|---|---|---|
| 2.1 | Write `train/dataset.py`: clean + degraded views, real crops ×4, the same-art mask and a hard-batch sampler. On Windows, set `num_workers` ≤ cores − 2, use `persistent_workers=True`, and put every entry point under `if __name__ == "__main__":` | One batch renders to `train/out/batch.png` and looks right |
| 2.2 | `train/finetune_clip.py --profile auto --epochs 15` | Synthetic small top-1 rises each epoch; clean catalog self-match stays ≥ 96 % |
| 2.3 | For each α: `train/wise_ft.py` → `train/export_onnx.py` → `train/embed_catalog.py` | int8/fp32 parity ≥ 0.98; one `eval_small` report per α |
| 2.4 | Pick the largest α that passes all of section 7.2 | Gate table written to `data/reports/phase2.md` |
| 2.5 | Re-embed the Phase 1 seed with the new model and retrain the adapter. Refit the thresholds and the hub penalty | All gates pass again with the adapter |
| 2.6 | On a code-repo branch: point `setup.js` ASSETS at `v3.0`, update `pins.json` and the `fusion.js` thresholds, then run the full Chrome harness | 3/3, 22/22, 102/102, FB11, mp and fbo pass; no new console errors |
| 2.7 | With the owner's OK: upload release `v3.0`, merge, update `pins.json` in the data repo, and commit the new `seed.npz` and `regression*.npz` | The nightly publishes a bundle for the new model hash |

```powershell
python train\finetune_clip.py --catalog-images ..\pokemon-auto-lister\data\card-catalog\images --meta assets\meta.json --real data\real-crops --same-art data\same-art.json --profile auto --epochs 15 --out train\out\ft1
python train\wise_ft.py --base openai --finetuned train\out\ft1\last.pt --alphas 0.3,0.5,0.7,1.0 --out train\out\ft1
foreach ($a in "0.3","0.5","0.7","1.0") {
  python train\export_onnx.py --ckpt train\out\ft1\wise-$a.pt --out train\out\ft1\clip-$a-int8.onnx
  python train\embed_catalog.py --model train\out\ft1\clip-$a-int8.onnx --catalog-images ..\pokemon-auto-lister\data\card-catalog\images --meta assets\meta.json --out train\out\ft1\catalog-$a.bin.gz
  python scripts\eval_small.py --set fb,synth,pokellector --model train\out\ft1\clip-$a-int8.onnx --catalog train\out\ft1\catalog-$a.bin.gz --meta assets\meta.json --baseline data\reports\baseline.json --out data\reports\ft1-$a.json
}
```

### Phase 3: detector (3–5 days, GPU; can run in parallel with Phase 2)

| Step | Do | Check |
|---|---|---|
| 3.1 | Collect and review 150–300 lot frames with negatives, plus 5–10 % background images (section 5) | Every label file is drawn once and checked (`ultralytics.data.utils.visualize_image_annotations`) |
| 3.2 | `make_tiles_dataset.py`, then `train_detect.py --epochs 80 --name card_detect_v8` | Validation mAP is not the gate |
| 3.3 | Export at 640 with simplify, then run the Chrome lot harness and the FB sets | Non-card rows drop by 50 %; right names don't drop; wrong (sure) doesn't rise |
| 3.4 | Add `lib/detect.js detectTiled()` behind a flag and measure it on the 50-card lot | +1–2 cards per dense photo; scan time rises by at most 60 %, on dense photos only |

```powershell
cd C:\users\daroo\desktop\repos\cardscanner\pokemon-auto-lister
..\card-scanner-data\.venv-gpu\Scripts\Activate.ps1
pip install ultralytics
python tools\vellum-ai\detect\train_detect.py --epochs 80 --name card_detect_v8
```

### Phase 4 (optional): backbone bake-off or student (1–2 weeks)

- Run `python train\bakeoff.py --models dinov2_vits14,mobileclip2_s0,siglip2_b16 --set fb`.
- Continue to a distilled student (option c) only if one backbone beats fine-tuned CLIP by ≥ 5 points of top-5 under 150 px.

### Phase 5 (ongoing): feeding real crops back in through the self-improvement loop

1. **Collect.**
   - Guess-first turns each small card into a one-click pick from its top 5. A pick becomes a correction (crop + chosen id) stored in IndexedDB.
   - With sharing on, that correction becomes a relay contribution on `inbox`, split into teach or exam by `photoId`.
   - Suggested schema addition: a `readHeight` field (`tools/relay/src/validate.js`, `pipeline/contributions.py`), so small crops can be sorted out.
2. **Nightly (automatic).**
   - Teach rows go through consensus into the memory pack.
   - Promoted rows plus `seed.npz` train the adapter, which then goes through the gate (now with the small slice) and becomes a signed bundle.
   - Exam rows form the community exam, which starts gating once n ≥ 30.
3. **Monthly on the PC.**
   - `harvest_inbox_crops.py` collects teach-split crops that reached consensus or that the owner reviewed on a contact sheet.
   - `import_corrections.py` collects the owner's own exported corrections.
   - Both write to `data/real-crops/`. Rebuild `seed.npz` with real crops first, and the next nightly trains the adapter on it.
   - Exam-split crops and newly labelled listings go to `fb-eval`, never to training.
4. **Backbone refresh.** Re-run Phase 2 when there are at least 1,000 new real crops under 150 px, or once a quarter. Weight real crops ×4 against synthetic ones.
5. **Watch the `status` release.**
   - Today it shows 1 contributor, 0 promoted rows and a 46-byte pack.
   - The loop needs more installs, or owner-reviewed single-install rows, before it teaches much.

### Time summary

| Phase | Owner time | Machine time |
|---|---|---|
| 0 | 1–2 days, mostly labelling | 1–3 h catalog download |
| 1 | 2–3 days | about 1 h of embedding, then minutes of training |
| 2 | 4–7 days | 2–6 h GPU, plus about 2 h CPU for re-embedding and eval |
| 3 | 3–5 days, mostly labelling | 1–3 h GPU |
| 4 | 1–2 weeks | |
| 5 | about 1 h a month | nightly |

---

## 9. Files to add or change

**`fabcrowd/card-scanner-data`** (branch `feat/blurry-training`):

- **Degradation:** `pipeline/degrade.py`, `tests/test_degrade.py`.
- **Seed building:** `pipeline/seed.py` (add `fb-eval` to FORBIDDEN) and `scripts/build_seed.py` (new flags `--degrade`, `--heights`, `--dtype`).
- **Gate:** `pipeline/regression.py`, `pipeline/gate.py`, `pipeline/run.py` (the small slice), plus `tests/test_gate.py` and `tests/test_run.py`.
- **Eval and data scripts:** `scripts/fetch_catalog_art.py`, `build_fb_eval.py`, `build_synth_small.py`, `eval_small.py`, `eval_pokellector.py`, `degrade_report.py`.
- **Real crops and adapter scripts:** `scripts/import_corrections.py`, `harvest_inbox_crops.py`, `build_small_rows.py`, `train_adapter_local.py`.
- **GPU training:** `train/requirements-gpu.txt`, `dataset.py`, `finetune_clip.py`, `wise_ft.py`, `export_onnx.py`, `embed_catalog.py`, `bakeoff.py`, `README.md`, and `distill_student.py` for Phase 4 only.
- **`.gitignore`:** `data/`, `runs/`, `train/out/`, `assets/`, `*.pt`, `*.safetensors`.

**`fabcrowd/pokemon-auto-lister`** (only when a phase ships):

- **Phase 1 option (d):** `lib/search.js`, `lib/bundle.js`, `background.js`, and tests.
- **Phase 2:** `tools/extension-wasm/lib/setup.js` (ASSETS), the `lib/fusion.js` thresholds, the hub penalty, HANDOFF and CHANGELOG.
- **Phase 3:**
  - New scripts: `tools/vellum-ai/detect/mine_hard_negatives.py` and `make_tiles_dataset.py`.
  - `lib/detect.js`: `detectTiled`, and optionally the `not_card` filter.
  - `lib/setup.js`: the detector asset.

---

## 10. Sources

**Small and low-resolution images:**
- Resolution asymmetry in metric learning (WACV 2023): https://openaccess.thecvf.com/content/WACV2023/papers/Suma_Large-to-Small_Image_Resolution_Asymmetry_in_Deep_Metric_Learning_WACV_2023_paper.pdf
- Low-resolution retrieval with resolution-varying contrastive fine-tuning: https://www.mdpi.com/2076-3417/11/15/6783
- Resolution augmentation for low-resolution recognition: https://doi.org/10.48550/arxiv.2302.05621

**Fine-tuning without losing what the model already does well:**
- WiSE-FT: https://arxiv.org/abs/2109.01903 ; https://github.com/mlfoundations/wise-ft
- LP-FT (fine-tuning distorts pretrained features): https://arxiv.org/abs/2202.10054
- LoRA: https://arxiv.org/abs/2106.09685 ; PEFT: https://huggingface.co/docs/peft
- open_clip: https://github.com/mlfoundations/open_clip

**Metric-learning losses:**
- ArcFace: https://arxiv.org/abs/1801.07698
- Sub-center ArcFace: https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123560715.pdf
- pytorch-metric-learning: https://kevinmusgrave.github.io/pytorch-metric-learning/

**Degradation synthesis:**
- BSRGAN: https://arxiv.org/abs/2103.14006
- Real-ESRGAN: https://arxiv.org/abs/2107.10833
- Albumentations: https://albumentations.ai/docs/api-reference/albumentations/augmentations/pixel/compression/ ; https://albumentations.ai/docs/api-reference/augmentations/transforms/

**Other backbones and card scanners:**
- DINOv2: https://arxiv.org/abs/2304.07193 ; https://github.com/facebookresearch/dinov2
- MobileCLIP2-S0: https://huggingface.co/apple/MobileCLIP2-S0 ; https://huggingface.co/plhery/mobileclip2-onnx
- SigLIP 2 browser ONNX: https://huggingface.co/collections/upshift/siglip-2-for-the-browser-onnx-webgpu
- MobileNetV3: https://arxiv.org/abs/1905.02244
- CollectorVision: https://github.com/HanClinto/CollectorVision ; CardLens: https://github.com/alexwing/CardLens

**Detection:**
- SAHI: https://arxiv.org/abs/2202.06934 ; https://docs.ultralytics.com/guides/sahi-tiled-inference/
- YOLO background images: https://docs.ultralytics.com/yolov5/tutorials/tips-for-best-training-results ; https://github.com/ultralytics/ultralytics/issues/12941

**Runtime and setup:**
- ONNX Runtime quantization: https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html
- ORT WebGPU EP: https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html ; int8-on-WebGPU issue: https://github.com/huggingface/transformers.js/issues/1512
- PyTorch install selector: https://pytorch.org/get-started/locally/
