# Review of docs/blurry-training-plan.md and revised training recommendation (2026-10-21)

Status: research recommendation from an Opus read-only review; parity and synthetic baselines are measured (see sections 3b, 3j, 9), while training results and real Facebook photo results are not. Numbers from papers are cited; numbers marked (estimate) are not measured.

Summary: The old plan diagnoses the problem correctly (small, blurry crops lose detail the recognizer needs) and its eval and gating rules are sound. Its training design is riskier than it needs to be. It re-trains a whole model with a 22,070-way ArcFace head, which would force a re-embed of catalog.bin and invalidate every threshold, adapter and stored correction built on the current embeddings. This review recommends freezing the catalog and training only the query tower toward it, using asymmetric distillation. With WiSE alpha = 0 the new model equals today's, so the change is reversible. It also drops several options that repeat failed experiments, adds checks for the exact resize kernel and the sure/guess rule, and gives a concrete run for the RTX 4080 16 GB on this PC.

## 1. Hardware

- This PC has an NVIDIA RTX 4080 16 GB (driver 617.14). The plan's "16 GB" row applies.
- The existing tools/vellum-ai/.venv has CPU-only torch 2.13.0. A GPU venv is needed.
- The GPU venv is set up outside the repo at C:\repos\projects\card-scanner-data\.venv-gpu.

## 2. What in the old plan is sound

- The resolution-gap diagnosis.
- Building the eval set first: at least 300 boxes under 150 px, split by listing, with fb-eval banned from training.
- Calibrated high-order degradation: match Laplacian variance and JPEG blockiness to real crops (KS < 0.15).
- A clean-view anchor, a WiSE-FT alpha sweep, and gating on int8 numbers.
- Detector rules: reviewed labels, and gate on right/wrong names in the lot harness, not on mAP.

## 3. Changes recommended

### a. Freeze catalog.bin and train only the query tower

- Use asymmetric distillation (Suma and Tolias, WACV 2023, arXiv 2210.05463). At 158 px queries against a 448 px database, the distilled student reached 71.3 R@1 on Cars196 versus 32.3 for the teacher as-is. On CUB it was 63.7 versus 47.6.
- Re-embedding the catalog moves every threshold, the hub penalty, the adapter, regression*.npz, community pack rows and stored corrections at once. Freezing avoids that.
- With WiSE alpha = 0 the new model equals today's.

### b. Replace the ArcFace head with a softmax over frozen catalog rows

- The old plan uses a 22,070-way learnable sub-center ArcFace head. With one clean image per class, learnable proxies memorise. Budnik & Avrithis, as summarised by Suma, found that label losses hurt asymmetric alignment (this is not Suma's own result).
- Loss:
  L = 1.0*(1-cos(S(deg(aug x)), T(aug x)))^2   [coupled distillation: the frozen teacher T sees the same geometric augmentation of the large view that the student sees; the student additionally gets degradation]
    + 0.5*(1-cos(S(deg), c_y))^2   [secondary anchor to the frozen catalog row; weight is an (estimate); pilot starts at 0, see below]
    + 0.1*CE_multi-positive(S(deg)·C^T/tau, same-art group)   [small weight (estimate); this is a label loss, so ablate it, because Suma cites Budnik & Avrithis finding that label losses hurt asymmetric alignment]
    + 1.0*(1-cos(S(large), T(large)))^2.
- The main term is coupled to the teacher. A loss that targets only a fixed, un-jittered catalog row c_y is the uncoupled setup Suma & Tolias show fails.
- tau is fixed at 0.04.
- The pilot starts with the 0.5 weight on the fixed catalog-row term c_y at 0 and the CE term at 0, and ablates CE at 0.1. Reason: c_y comes from different preprocessing than the student path, and using it brings back the uncoupled target.
- S is the student. T is the frozen teacher: the same OpenAI ViT-B/32 weights. Verify these are the weights clip_visual_int8.onnx was exported from.
- C is the stored catalog.bin: float32 (22,070 x 512). Per the reviewer it was produced by tools/vellum-ai/catalog/embed_all.py with fp32 PyTorch open_clip and PIL preprocessing (resize short side to 224 bicubic, then centre crop), not by the shipped int8 ONNX model.
- Measured parity (scripts in C:\repos\projects\card-scanner-data\scripts, seed 9001, 300 random catalog cards, run 2026-10-21):
  - fp32 open_clip (ViT-B-32/openai, embed_all.py preprocessing: top 45% crop then open_clip transform) vs stored catalog.bin rows: cosine min/median/mean = 1.0000, fraction >= 0.999 = 1.0000, top-1 self-match over all 22,070 rows = 1.0000. So catalog.bin is exactly fp32 open_clip output.
  - Shipped int8 ONNX vs fp32 torch on the same tensors: median 0.9720, mean 0.9690, min 0.9007. Dynamic int8 quantisation alone accounts for the whole 0.97 gap seen earlier (shipped int8 with the extension crop vs stored rows: median 0.9700, min 0.9063, p1 0.9117, none >= 0.99, top-1 self-match 0.9833).
  - Re-exporting the pretrained fp32 weights with scripts/export_clip_onnx.py settings (legacy exporter dynamo=False, opset 14, quantize_dynamic QUInt8) in .venv-gpu (torch 2.11.0+cu128, onnx 1.23.2, onnxruntime 1.31.0, open_clip 3.3.0) reproduces the shipped asset: size 88,999,043 bytes identical, same SHA-256 as the shipped asset (77538aad...), cosine vs shipped int8 min/median/mean = 1.0000. So "alpha = 0 equals today's model" holds.
  - Warnings seen (no errors): open_clip QuickGELU mismatch notice (config quick_gelu=False vs 'openai' tag quick_gelu=True) in both the catalog-building call and the export call; torch legacy TorchScript exporter deprecation; onnxruntime suggests pre-processing before quantisation.
- Freezing the catalog as target is still viable: the extension already compares int8 queries against this fp32 catalog today. But the teacher/student fp32 path should match open_clip preprocessing when producing c_y, and the int8 deployed path is what must be evaluated.

### c. Coupled augmentation

- Apply the same geometric transform (box jitter +-6% per side) to teacher and student input.
- Apply degradation on the student side only.
- Suma found uncoupled augmentation dropped mAP from 37.7 to 20.9-31.3.

### d. Same-art groups

- Group by name + artist + art dHash. Use cosine only as a check.
- A cutoff of cos >= 0.95 would merge look-alikes that differ only when small.

### e. Training upscale kernel

- Training upscale must match the extension's real path. Do not assume PIL bicubic.
- Real path: artSourceRect = centred square of the top floor(0.45*h) rows (fractional sx, sy), then OffscreenCanvas drawImage(..., 224, 224) with imageSmoothingQuality='high'.
- That kernel is defined by Chrome/Skia, not by a spec. After the resize, RGBA is quantised to uint8, divided by 255, then normalised with CLIP mean/std.
- Training must either render its 224 inputs with headless Chrome, or match a Python kernel to canvas output by measuring PSNR.
- Degradation must be applied at card level, before the art crop.
- The frozen targets c_y stay on the PIL/open_clip path.
- This is the same class of bug as the crop-parity lesson (54.7% vs 96.7% self-match).

### Prerequisite parity tests

- Export path: scripts/export_clip_onnx.py uses legacy dynamo=False, opset 14, input pixel_values, L2-normalised output, quantize_dynamic QUInt8 with per_channel off. Its own docstring says ~38 MB, which is stale (the shipped asset is about 89 MB).
- Risk: torch 2.11 / onnxruntime 1.31 may quantise differently from the environment that made the v2.0 asset. So "alpha = 0 equals today's model" only holds if re-exporting the pretrained weights reproduces the shipped asset (cosine >= 0.999 on sample crops). Measured: it does (identical size, cosine 1.0000; see 3b).
- onnxruntime in .venv-gpu has only CPU/Azure providers (no CUDA EP), so per-epoch int8 evaluation runs on CPU.

### f. Offline eval must match the shipped decision rule

- Port the lib/fusion.js sure/guess classification into the offline eval.
- Report sure-wrong per height bucket.
- Reason: the blur adapter won offline, but FB sure-wrong went from 4 to 7.

### g. Drop or defer

- Drop option (d), multi-resolution catalog rows, and the degraded-adapter merge. They repeat failed experiments: blurry rows became hubs, and top-1 went from 22 to 14 at 150-200 px.
- Drop super-resolution.
- Drop crop-shift averaging.
- Drop the learnable ArcFace head.
- Drop the backbone bake-off and the distilled student. They break the same-graph ~89 MB constraint.
- Defer the Phase 1 adapter-only ship. Any tower change invalidates the adapter.

### h. Weak points of the old plan

- "Clean self-match >= 96%" is near-guaranteed when catalog art is both anchor and target. It proves little.
- The 17-33% small-crop gain is an unmeasured estimate.
- At n = 46, a paired test cannot detect small changes. It needs the >= 300-box set.

### i. The detector is not the small-crop bottleneck

- A 120 px card in a 720x960 photo is about 80 px at the detector's 640 input.
- Measured losses are 10% non-card boxes and loose or off-aspect boxes (40 of 138; top-1 40% vs 52%).
- Tiling adds only 1-2 cards per 50-card photo.

### j. int8 quantisation is itself a 0.03 cosine loss

- The deployed int8 model already loses about 0.03 cosine (median 0.972, worst 0.90) versus fp32 on clean full-size catalog art.
- The loss is probably larger on blurry small crops. QuantTune attributes about 65% of transformer int8 error to activation outliers; that figure was not checked by the senior review.
- Consequence: evaluate every candidate with the int8 export, not fp32.
- Experiments to measure (not decided, all untested):
  - Quantisation-aware fine-tuning (fake-quant in the forward pass).
  - Tighter activation ranges via a short distillation toward fp32 outputs.
  - Per-channel or static QDQ quantisation, checked to load in ort-web 1.17.3 WASM.
  - An fp16 model (about 176 MB, over the size budget).

### k. Hubness is the dominant failure on small crops

- At H=60 the 199 accepted reads name only 9 distinct cards. 5 cards take 98%: swshp-SWSH161 Mewtwo V-UNION 133, swshp-SWSH289 and swshp-SWSH290 Morpeko V-UNION 28 each, pl3-125 Seel 4, pop5-2 Lugia 2.
- Over all 1000 cards, SWSH161 is the top-1 for 612.
- Median top-1 similarity is 0.804 (0.818 among accepted), while median cosine to the true card is 0.62. Accepts pass because gaps of about 0.02-0.03 satisfy CLEAR_GAP.
- Consequences:
  - Training must reduce hub attraction (negatives matter).
  - Every eval must report hub concentration: share of top-1 taken by the single most frequent id and by the top 5.
  - A CSLS-style hub penalty (the extension already supports one; data/hub-penalty.bin is missing from this checkout) should be measured offline as a cheap baseline before and after training.

## 4. Concrete run for RTX 4080 16 GB

All numbers are (estimate) unless stated.

### Order of work

- Phase 0 first: grow the FB eval set, port the fusion rule, build a regression-small slice.
- GPU work can start in parallel, but only with train/eval leakage excluded (see "Eval hygiene" below); it needs catalog art minus the eval cards and their same-art groups. Make no ship decision before the eval set exists.

### Eval hygiene

- BLOCKING pilot condition, train/eval leakage: the synthetic eval cards (Random(9001).sample of cards with images, 1000 cards) and their same-art groups (same name as proxy) must be excluded from training. Otherwise synthetic gains only show memorisation.
- 119 of the 1000 eval cards are digital-only TCG Pocket ids (prefixes like A1-, B1-). The extension filters these out of results (physicalHits filter, not ported), so reports should also give numbers excluding them.

### Pilot first gate (int8 export, held-out synthetic set)

- No drift: clean-card int8 median cosine to catalog >= 0.970, self-match >= 0.983, large-view cos(S,T) >= 0.98.
- H=150 top-1 from 0.26 to >= 0.40.
- Hub share of H<=120 top-1 well below today's 61% (SWSH161 alone).
- Accepted-wrong at H=150 and H=200 not above 204 and 178.

### Model and views

- Student: fp32 OpenAI ViT-B/32.
- Views per card: 2 degraded + 1 large (photo-like >= 250 px, or clean).

### Run A: full tower

- Layer-wise LR decay 0.7, peak 2e-5 on the last block.
- Patch and position embeddings frozen.
- Weight decay 0.01, or L2-SP.

### Run B: LoRA

- r = 16 on qkv, out and MLP in all 12 blocks. LR 2e-4. Merge after training.
- The idea that LoRA quantises more gently is unverified.

### Shared settings

- AdamW, bf16 autocast.
- 500-step warm-up, then cosine.
- 12 epochs, EMA 0.999.
- Batch 256 cards x 3 views = 768 images. Fallback: 128 cards with 2 accumulation steps.

### Data

- Pre-generate about 16 degraded small-size PNGs per card (about 350k files).
- Upscale on the fly with the extension kernel.
- num_workers 8-10. Keep entry points under `if __name__ == "__main__":`.

### Degradation

- Card height from a reweighted mixture: log-uniform over 48-320 px plus an extra log-uniform component over 70-180 px, to reach about 60% of samples in 70-180 px. Plain log-uniform 48-320 gives only about 50% there. The exact mix is an (estimate) to be tuned against real crop heights.
- Keep at least 25% of student views at >= 250 px or clean.
- JPEG phone save at q85-95, then a misaligned re-encode at q40-85.
- Blur sigma 0.3-1.2, or 2-5 px motion blur.
- Sleeve and glare as in the old plan.
- Calibrate against real crops.

### Per epoch

- Export int8 with the existing exporter.
- Report FB top-1/5, sure-wrong, the synthetic small set, and drift on 2k large views (median cos(S,T) >= 0.98).
- Then run the WiSE alpha sweep {0.25, 0.5, 0.75, 1}.

### After a winner

- Retrain the adapter on the new query embeddings.
- Refit lib/fusion.js thresholds on held-out data.
- Rebuild regression*.npz and pack rows.

### Optional experiment (unverified idea)

- For crops under 150 px, feed the whole card instead of the ~54 px art square. Still distill to the art-crop catalog row.
- This changes the small-crop path in lib/embed.js.

### Detector (Phase 3, cheap, can run in parallel)

- Fine-tune card_detect from current weights at imgsz 640, 100-150 epochs, batch=-1.
- mosaic 1.0, scale 0.5, close_mosaic 10.
- 5-10% background images.
- Reviewed hard negatives: sleeves, inserts, piles.
- Prioritise tighter upright boxes over recall.
- Tiling stays behind a flag, for dense photos only.
- Gate on right/wrong names in the lot harness.

## 5. Biggest risk per gate, with a cheap test

| Gate | Biggest risk | Cheap test |
|---|---|---|
| Large-crop gates (pokellector 102/102, 3/3, 22/22, HiBid >= 0.5074) | Student drift | Per-epoch median cos(S,T) on 2k clean and photo-like >= 250 px views; int8 HiBid re-embed |
| FB sure-wrong (<= 3 src, <= 5 shot) | Similarity and margin rise for 200-299 px crops, so more wrong reads pass the thresholds | Ported fusion rule offline; compare right/wrong similarity and margin histograms in the 200-299 px bucket at old and refit thresholds before any Chrome run |
| Small-crop targets | Synthetic gains do not transfer; n too small | Track FB top-5 vs synthetic top-1 across alpha; stop if synthetic rises and FB is flat; require >= 300 crops plus McNemar |
| int8 parity >= 0.98 | Fine-tuning widens weight and activation ranges | Export int8 every epoch; if the drop is > 1 point, use qdq_loss_debug and per-channel with reduce_range, and confirm it loads in ort-web 1.17.3 WASM |
| Detector | Confident wrong names (v7b: +7 wrong for +1 right) | Lot harness only |
| Nightly gate | A HiBid-only gate hides gains | regression-small slice, with acceptedWrong checked on both sets |

## 6. Other supporting evidence

- WiSE-FT (arXiv 2109.01903): +4-6 points under distribution shift, +1.6 on ImageNet.
- LP-FT (arXiv 2202.10054): plain fine-tuning is -7% OOD versus a linear probe. LP-FT is about +10% OOD versus plain fine-tuning.
- GUIE 2nd place (CLIP + ArcFace): a backbone LR 1000x lower than the head was the largest gain (+0.027). It trained for <= 15 epochs at 224 px.
- ONNX Runtime docs: dynamic quantization is recommended for transformers. Per-channel may need reduce_range on AVX2/AVX512.
- QuantTune: about 65% of transformer int8 error comes from activation outliers.
- SAHI (arXiv 2202.06934): +6.8 AP inference-only, +12.7 AP with slicing in fine-tuning. This is on aerial data, so it is not directly transferable.
- Card prior art: CardLens uses zero training (MobileCLIP2-S0 + OCR bonus 0.35, thresholds 0.80 confidence / 0.05 margin). The CollectorVision README gives no training details or accuracy numbers.

## 7. Unverified / open

- Epoch times, VRAM fit and the LoRA-quantisation benefit are estimates.
- The Real-ESRGAN numeric degradation ranges were not read.
- The MDPI resolution-varying contrastive paper and the WACV CVF PDF returned 403. Suma was read via alphaXiv.
- The old plan's claim that ArcFace was trained on illustration/set labels (improvement-plan.md) could not be traced to a primary source.
- The FB eval pack (11 photos, truth.json, replica scripts) is still on the Linux agent box and not on this PC.
- Whether catalog.bin matches the shipped int8 model: answered no. It is exactly fp32 open_clip output; the int8 model differs from it by about 0.03 cosine (see 3b and 3j).
- The Opus senior review did NOT check the GUIE, QuantTune, CardLens and SAHI figures.

## 8. Sources opened

- https://arxiv.org/abs/2210.05463
- https://arxiv.org/abs/2109.01903
- https://arxiv.org/abs/2202.10054
- https://arxiv.org/abs/2302.05621
- https://arxiv.org/abs/2202.06934
- https://arxiv.org/abs/2403.06497
- https://arxiv.org/abs/1906.06423
- https://arxiv.org/abs/2107.10833
- https://arxiv.org/abs/2210.09296v1
- https://ar5iv.labs.arxiv.org/html/2210.08735
- https://github.com/HanClinto/CollectorVision
- https://github.com/alexwing/CardLens
- https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html
- https://docs.ultralytics.com/yolov5/tutorials/tips-for-best-training-results

## 9. Status and next steps (2026-10-21)

Environment verified: torch 2.11.0+cu128, RTX 4080 16 GB, asset SHA-256 matches pins.json and setup.js. Nothing committed.

Not done:
- The eval pack (11 photos, truth.json, replica scripts) is not on this PC.
- FB re-download: the two public Cincinnati listings yielded one usable photo (a single-card toploader shot, 600x799 served / 1537x2048 original); the other redirects to login. The real lot photos need the Linux box pack or a logged-in browser.
- No training has run.
- The offline Facebook replica and the regression-small slice do not exist yet.

Done (numbers in 3b):
- Catalog parity: catalog.bin is exactly fp32 open_clip output; shipped int8 sits about 0.03 cosine below it.
- Export parity: re-exporting the pretrained weights reproduces the shipped asset (identical size, cosine 1.0000).

Done (fusion rule and scorer): the fusion-rule port and scorer now exist in card-scanner-data: scripts\fusion_rule.py, tests\test_fusion_rule.py (11 passing tests), scripts\score_synth_fusion.py, results data\reports\synth-fusion-baseline.json.

Ordered next steps:
1. Canvas-kernel parity test: Chrome output vs Python resize (remaining).
2. LoRA / full-tower distillation pilot, with int8 eval and the first gate in section 4.
3. Facebook photo pack (the real lot photos).

### Baseline: synthetic, not a ship gate

From scripts/eval_synth_small.py (card-scanner-data): 1000 cards, seed 9001, shipped int8 model. Each card is downscaled to height H with a random filter, JPEG q 40-85, then the extension art crop. Results file: data\reports\synth-baseline.json in card-scanner-data.

| H (px) | top-1 | top-5 | median cos to true row |
|---|---|---|---|
| 60 | 0.001 | 0.002 | 0.6178 |
| 90 | 0.005 | 0.009 | 0.6538 |
| 120 | 0.025 | 0.071 | 0.7047 |
| 150 | 0.260 | 0.416 | 0.7668 |
| 200 | 0.722 | 0.906 | 0.8423 |

Median cosine to the true row is below the int8 parity median (0.972) even at H=200. int8 costs about 0.03 cosine and blur about 0.13 at H=200, so blur dominates.

### Baseline: synthetic fusion (accepted reads)

From scripts/score_synth_fusion.py (card-scanner-data): synthetic, 1000 cards, seed 9001, k=5, shipped int8 model. "Accepted" = fuseUntiered would accept, view a, no height caps. Results file: data\reports\synth-fusion-baseline.json.

| H (px) | top-1 | accepted | right | wrong | high-pre-cap |
|---|---|---|---|---|---|
| 60 | 0.001 | 199 | 1 | 198 | 44 |
| 90 | 0.005 | 126 | 3 | 123 | 29 |
| 120 | 0.025 | 192 | 15 | 177 | 25 |
| 150 | 0.260 | 412 | 208 | 204 | 79 |
| 200 | 0.722 | 853 | 675 | 178 | 349 |

Below 200 px the extension's height caps (view c) turn every accepted read into a guess, so sure-wrong is 0 by construction there. Use accepted-wrong (view a) as the offline measure.
