# Handoff: clip v3 recognizer, harvest and pricing audit (2026-10-22)

Overall goal (owner): improve automatic **detection, recognition and pricing** of Pokémon cards from phone photos on any listing site, consumer grade. Opus plans and reviews; Sonnet subagents build and research. Never state a number that was not read from a file.

## Where things stand

- Branch `feat/clip-v3` (this repo), commit `bb2afc8`: recognizer v3 wired in (setup.js pin to release v3.0, EMBEDDING_VERSION 3, card-back vector rebuilt for v3 and stamped, upgrade path keeps the v2.1p cache and downloads only the clip, tests). QA on the final tree: `npm test` 1179/1179, store-build 8/8, shared-data python 183 OK, popup e2e 5/5, lint no new problems (205 on HEAD), dev/store/sealed builds OK, in-extension smoke equals the F rows below.
- **NOT published.** The push and `gh release create v3.0` were blocked by the permission classifier ("Create Public Surface"). Until the release exists a fresh install of this branch gets HTTP 404 on the clip file. Release files are staged at `dist/release-v3.0/` (gitignored: `clip_visual_int8.onnx`, `SHA256SUMS`). Public notes are at `docs/release-v3.0-notes.md` in this repo (copy of the text to paste into the release). Commands:
  - `git push -u origin feat/clip-v3`
  - `gh release create v3.0 dist/release-v3.0/clip_visual_int8.onnx dist/release-v3.0/SHA256SUMS --repo fabcrowd/pokemon-auto-lister --target feat/clip-v3 --title "v3.0 — Recognizer for small, blurry cards" --notes-file docs/release-v3.0-notes.md --latest=false`
  - Then the data repo: update `pins.json` in `fabcrowd/card-scanner-data` to match `tools/shared-data/pins.json` (clip v3.0, sha256 `d15ade1768efb9c395d39fe0f4b513e06ce503116d01a28d7cf2833e5f811e6c`, cropVersion 3) so the nightly signs a bundle for model prefix `d15ade1768efb9c3`. Until then the build runs without the adapter/shared memory (correct and safe).
  - Verify the downloaded asset's sha256 after publishing.
- **Training is blocked on this PC:** Windows Application Control (`WinError 4551`) now blocks `.venv-gpu\Lib\site-packages\torch\lib\c10.dll`. fastC/fastD ran earlier from the same venv. Needs the owner to allowlist `.venv-gpu`. Run E (below) is staged but has not run. Do not try to bypass the policy.

## Models (training repo `C:\repos\projects\card-scanner-data`, branch `feat/blurry-training`, local commit only)

All are query-tower-only distillations against the frozen `catalog.bin` (asymmetric distillation: the frozen original model sees the sharp catalog card, the student sees a degraded copy).

- **B** `train/out/B/raw-final-int8.onnx`: catalog art + synthetic blur only, no real photos.
- **F** `train/out/fastC_real/epoch8-ema-int8.onnx` = clip v3 (shipped on the branch): adds 1300 real Goodwill crops (25% of each batch). sha256 `d15ade17…1e6c`, 88,999,043 bytes.
- **D** `train/out/fastD_real/epoch8-ema-int8.onnx`: + HiBid train crops (1797 real crops). No better than F; dropped.
- **E** (`fastE_all`, not run): F recipe on ALL physical catalog cards (earlier runs excluded ~8k same-name-as-synthetic-eval cards), 16 epochs, final EMA fixed in advance. Opt-in flags were added to `train/train_fast2.py` (`--all-physical`, `--no-epoch-eval`). Commands:
  - `.venv-gpu\Scripts\python.exe train\train_fast2.py --name fastE_all --real --all-physical --exclude-eval --real-cache train\out\cache\real320_e.pt --cards-cache train\out\cache\cards320_all.pt --epochs 16 --batch 128 --w-ce 0.1 --no-epoch-eval`
  - `.venv-gpu\Scripts\python.exe train\train_fast2.py --post fastE_all --epochs 16`
  - then `scripts/run_real_photos.py --photos data/fb-eval-pack/user-saved --model train/out/fastE_all/epoch16-ema-int8.onnx --out data/reports/real-student-fastE-all-ema`, `scripts/score_real_labels_v2.py`, add "E" to `MODELS` in `scripts/cross_source_eval.py` and `scripts/cross_source_tables.py`, back up `data/reports/cross-source/results.json` first.
  - Ship rule for E over F: better on the real photos and cross-source sure-wrong; if E wins, redo the wiring (hash, card-back vector from the v3 embeddings, release notes) and the QA pass.
- Training facts: catalog.bin is exactly fp32 open_clip output; shipped int8 costs ~0.03 cosine; re-exporting pretrained weights with `scripts/export_clip_onnx.py` reproduces the shipped asset byte for byte.

## Results so far (all measured in files; photos 3-7 of the 7 owner-saved Facebook photos = 182 cards, photos 1-2 are lighters and excluded; photo 3 was used in earlier model selection)

Harness: `.tmp/ab/` (gitignored; RESULTS.md, GATES.md, REFIT.md, WIRING.md, run.mjs, run-fix.mjs, score.mjs, scorefix.mjs). Arms: An = shipped model, no adapter/bundle; B; F; shipped A also has the live adapter bundle.

- Right card is the top-1 guess, all cards, shot/src: An 28/31, B 104/115, F 127/131. Without photo 3 (130 cards): An 23/26, B 75/83, F 87/93.
- Sure right / wrong (shot, src) stays ~16/0-1 in every arm because almost every crop is under 150 px (height caps keep reads as guesses). The one sure-wrong is Koffing read as "Koga's Koffing" (photo 6 box 9; same call by B in shot mode).
- Rebuilt Pokellector grid fixtures (`.tmp/pokfix`, my own minimal pages, deterministic): sure right/wrong An vs B vs F: Base 84/8, 93/8, 91/8; Jungle 58/4, 62/2, 61/1; Fossil 51/2, 62/0, 57/0; Mixed 76/6, 85/3, 84/2. F is 1-5 below B on sure-right.
- Cross-source held-out (HiBid eval + Goodwill-pack2 eval, 354 geometry-labelled boxes; `data/reports/cross-source/README.md`): sure-wrong at native/250/200 px: shipped 10/30/26, B 3/7/11, F 3/5/11. Top-1 right at 120 px (of 354): shipped 31, B 229, F 275.
- Card-back detection (held-out 153 backs): v2+old vector P 0.992 R 0.810; v3+old vector R 0.255 (broken); v3+rebuilt vector P 1.000 R 0.915.
- Threshold refit (fit set = 610 id-level pseudo-labelled crops that no model trained on): FAILED for B and F (degenerate fit; sure-wrong rises). Shipped thresholds kept. A refit needs a fit set with look-alike hard negatives.
- More real crops were not the lever: fastC_cat vs fastC_real vs fastD_real top-1 within noise (top-5: C_real 88 vs C_cat 79, D_real 83). HiBid/Goodwill crops are >=300 px (pipeline MIN_HEIGHT), so the blur is still synthetic.

## Known gaps

- Not live-tested in the owner's real Chrome on live Facebook/eBay/Mercari listings.
- The 3/3 Base Set page, 22/22 page and the HiBid lot harness were on the old Linux box and are not rebuilt.
- Facebook small-crop test set is only 7 photos / 182 cards / one run per arm (same build varies ~5 on screenshot-path guesses).
- `data/hub-penalty.bin` (local, gitignored) is built with the old model; search.js checks only row count. Rebuild with `scripts/build-hub-penalty.py` if used.
- Learning bundle/adapter are skipped for v3 until the data repo republishes.
- The extension's price snapshot URL (`prices` release) still 404s (see pricing audit).

## Harvest (other people's listing photos; gitignored, never commit)

`C:\repos\projects\card-scanner-data\data\harvest-20261022\` : 1541 photos / 354 listings (Mercari 410, HiBid 350, ShopGoodwill 309, Craigslist 291, Poshmark 181; eBay 403, OfferUp 403, Whatnot web unusable). Split by listing 60/40 (924 train / 617 eval photos), deduped (sha256 + dHash<=4) against all existing packs. MANIFEST.json has no seller fields. Detector found 9431 boxes; share of boxes under 150 px: HiBid 48%, Craigslist 41%, Mercari 25%, Poshmark 21%, ShopGoodwill 15%. Scripts: `scripts/harvest_market.mjs`, `harvest_goodwill_new.py`, `harvest_finalize.py`, `harvest_probe.mjs` (card-scanner-data).

## In flight when this was written (results are on disk, not in chat)

1. **Extension comparison on harvest eval photos** (An vs F, ~25 photos/site, shot+src): output `.tmp/ab/harvest-eval/` (sample.json, cards.json, contact sheets with numbers only for blind labelling). Next: blind labelling of ~60 cards/site by Sonnet reviewers who see no model output, then per-site top-1/top-5/sure-wrong.
2. **Rendition measurement** (do sites serve the same photo larger/smaller; real CDN downscale vs our synthetic blur): output `data/reports/rendition/README.md` + `data/harvest-20261022/_renditions/`.
3. **Pricing audit** (snapshot freshness/404, printing-variant price spread, lot total vs label-based reference band, ranked defects, no implementation): output `.tmp/pricing-audit/`.

## Plan (novel options, ranked)

1. Fetch the largest rendition on every site (extension already does this for Facebook `ctp=` and srcset); per-site URL rewrite rules. Reading more pixels is the only thing that reliably helped.
2. Paired distillation from real CDN renditions (sharp crop from the large photo as teacher input, the site's own small rendition as student input), no card labels needed.
3. Cross-photo label propagation: label big views geometrically (>=300 px) and propagate to the same card's small views in the listing's other photos (the runtime already links cards across photos).
4. Synthetic lot compositing with measured real degradation for detector and recognizer; any detector change is gated on right/wrong names in the extension (v7b lesson), not boxes.
5. Closed loop from real use via the existing opt-in shared learning (sharp+small pairs); needs privacy design and owner sign-off.
Skip: super-resolution (hurt), blurry catalog copies (hubs), more Goodwill/HiBid-style large real crops (no gain).

## Rules that still apply

Never read `data/sealed-test`. Never stage with `git add -A`. Held-out evals (the 7 FB photos, hibid-pack/eval, goodwill-pack2/eval, harvest eval split, fb-eval-pack) never enter training or checkpoint selection. Memory: `~/.claude/projects/C--repos-projects-auto-card-lister/memory/` (blurry-crop-training, project-goal-detect-recognize-price).
