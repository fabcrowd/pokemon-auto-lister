# Card Scanner: accuracy improvement plan (low-resolution grid tiles)

> **Status (2026-10-18, end of the box session).** Plan items (a)-(d) were built on branch `fix/extension-only`: (a) best guess +
> pick-list, (b) soft multi-set prior and (d) source-image refinement are kept; (c) multi-crop averaging was tried and reverted
> (it raised confident wrong names without raising right names; see HANDOFF.md "Extension accuracy pass"). Retraining, the
> tile regression slice, GPU work and the hub penalty are still open for the owner's PC. Measured results are in HANDOFF.md.
> Paths such as `/workspace/...` and the eval scripts named below lived on the box where this was written and are not in the repo;
> the numbers are kept, the scripts would need rebuilding (a small onnxruntime script: embed 102 labeled thumbs with the shipped
> int8 CLIP, search `catalog.bin`, apply `adapter.bin`, replay the `lib/fusion.js` gate).

Written 2026-10-18 (America/Indianapolis). Research only: no code changed, nothing pushed. Everything below that is a
number was measured on this box with the shipped models; scripts are in `/workspace/eval/`.

## 0. Summary (read this first)

1. The misses on Base Set grids are mostly a **pixel problem and a gate problem, not a model problem.**
   The page serves 140x196 thumbnails, shown at ~95x130 CSS px. The extension reads a screenshot of that, so
   the matcher sees ~130 px tall cards. The same cards at native 196 px are named right **100%** of the time; at the
   screenshot size 80% (with the live adapter); the extension's own gate then turns some of those into "Unknown".
2. The cheapest wins need **no training**: (a) read the source image instead of the screenshot (the page has a
   570x795 original behind every `.thumb.png`), (b) always show the best guess plus a pick-list instead of
   abstaining, (c) a soft per-page set prior, (d) multi-crop averaging on unresolved tiles.
3. The self-improving loop **is deployed and live, but has learned almost nothing from real users yet**
   (1 install, 0 promoted rows, exam n=0). The adapter that ships today is trained on seed data (synthetic
   "photo-like" variants + owner crops), not on community corrections. It already helps a lot (66% -> 89% at 137 px).
   Retraining it on low-res tiles is cheap on CPU, but the nightly gate can't see tile accuracy (see 4.3).
4. Fine-tuning CLIP / swapping to DINOv3 / retraining the detector are expensive, need the owner's PC (GPU), and are
   not where the gain is today.

## 1. How the system works end to end (as built)

| Stage | Where | What it is |
|---|---|---|
| Page -> candidate boxes | `content.js` DOM finder; `photo-detection.js`; `lib/detect.js` (YOLO11n `card_detect.onnx`) | Grid pages use DOM `<img>`/CSS-background rects; photos use YOLO. |
| Pixels | `background.js` per-screen `captureVisibleTab` crop | Grid tiles are read from the **screenshot**, not the source image. |
| Embedding | `lib/embed.js` | Stock OpenAI CLIP ViT-B/32, int8 ONNX (`clip_visual_int8.onnx`, ~38 MB), top 45% of card, centered square, 224x224. `EMBEDDING_VERSION=2`. WASM, 1 thread (`ort.env.wasm.numThreads = 1` in `background.js`). |
| Catalog | `catalog.bin.gz` (22,070 rows x 512 float32) + `meta.json`; brute-force dot product (`lib/search.js`) | Fine at this size (11M MACs per query); no ANN index needed. |
| Learned parts (optional, signed) | `lib/bundle.js`, `lib/adapter.js`, `lib/references.js` | `adapter.bin` (rank-32 residual map applied to query and catalog rows), `community-pack.bin` (promoted reference rows), `check.bin`, `catalog-extra.bin` (new sets). |
| Hub penalty | `data/hub-penalty.bin` via `scripts/build-hub-penalty.py` | Per-row int8 penalty (CSLS-style). **Missing in this checkout** ("hub penalty not available: Failed to fetch" in SW log); built from owner-only data. Confirm the store build has it. |
| Decision | `lib/fusion.js` | `MIN_ACCEPT_SIM .72`, `CLEAR_GAP .02`, `HIGH_SIM .85`, name-match, name-vote else `ambiguous`; `capAdapterChange`, small-source cap. Grid pages skip the small-size cap. |
| Ask the user | `lib/card-picker.js`, `popup.js` | "Which card is this?" with "Closest matches" + "Not listed? Search"; "Set?" menu for printings (`lib/set-choice.js`). |
| Corrections out | `lib/contribution.js`, `lib/sharing.js` (opt-in, off by default) | 320 px JPEG crop + chosen card id + scanner's guess; relay at `card-scanner-relay.fabcrowd.workers.dev`. |
| Relay | `tools/relay` (Cloudflare Worker + R2 + KV) | Validates, writes only to the `inbox` branch of `fabcrowd/card-scanner-data`. |
| Nightly | `card-scanner-data/.github/workflows/nightly.yml` (03:17 UTC), `pipeline/run.py` | build job (no secrets) reads `inbox` as data -> consensus -> memory pack + adapter (`train_adapter.py`, numpy, <=8 min) + check + catalog-extra -> gate (`gate.py`) -> unsigned manifest; sign job (environment `pack-signing`) signs ECDSA P-256, publishes `pack-YYYYMMDD-N` (pre-release if the gate says not improved) and the `status` release. |
| Apply | extension `checkBundle` (<=1/day, public GET, no user data), signature + model/crop tag + seq + age checks | **Fetched for every user, not only opt-in users.** My harness log: `[BG] bundle live: adapter, new cards`. |

Training facts: CLIP is **never fine-tuned**; `scripts/export_clip_onnx.py` only exports it. Detector training lives in
`tools/vellum-ai/detect/` (ultralytics YOLO11n; `train_detect.py`, `retrain.py` with real-photo F1 >= .90 gate,
synthetic generators). Recognizer-side learning = adapter + memory pack only.

## 2. Is the learning loop live? (checked read-only via the public API)

- Releases `pack-20261017-1`, `pack-20261018-2` (both non-pre-release = shipped), plus rolling `status`.
  Branches `main` and `inbox` both protected. Workflow runs nightly; downloads per asset ~30-46 (people/devices are fetching it).
- `community-pack.bin` = **46 bytes** (empty). `adapter.bin` identical in both releases (sha256 `f2c315c1...`, 32,829 B):
  seed-trained. `catalog-extra.bin` adds sets 30th, B1, P-A.
- STATUS: contributors 0 then 1, promoted rows 0, exam n=0, regression (203 HiBid crops) top-1 0.3645 -> 0.5074, shipped yes.
- `inbox` holds one test contribution (2026-10-17).
- Why it will stay quiet until there are users: a row is promoted only if **>=2 installs on >=2 server days agree**, or the id is in the
  crop's catalog top-20 (capped at 10% of rows per install, <=5 rows per card). One owner = almost nothing promotes.
  The adapter retrains on promoted rows + seed, and ships only if it beats the live bundle on the fixed regression set,
  `wrongHigh` does not rise, and (n_exam >= 30) the exam is no worse.
- What's missing: (1) real contributors (opt-in is off by default; HANDOFF says store listing not yet submitted); (2) the gate's
  regression set is **HiBid listing crops**, not grid tiles, so an adapter that fixes tiles can't register as improved (and could
  even be rejected); (3) seed augmentation (`pipeline/augment.py`) has tilt/blur/glare/sheen/noise/JPEG but **no downscale-upscale**;
  (4) no tile-sized eval or status line; (5) `hub-penalty.bin` not in the dev tree.
- Would it help low-res tiles? Yes in principle, in two ways: users' tile crops (~130 px) become reference rows
  (Tip-Adapter-style cache, `memory`) and adapter training sees tile-like inputs. Not before (1)-(3) are addressed.

## 3. Where the misses come from (evidence)

Eval = 102 pokellector Base Set thumbs/originals with ground truth from page titles; shipped CLIP int8 + shipped catalog +
the live `adapter.bin`; same crop as `embed.js`. ("name" = right Pokémon/trainer name; exact printing is lower because Base Set,
Base Set 2 and Legendary Collection share art. Set prior = +0.03 to rows of sets holding >=10% of the page's top-1 picks.)

| Input to the matcher | name top-1 raw | name top-1 +adapter | right name in top-5 | name top-1 +adapter +soft set prior |
|---|---|---|---|---|
| 570x795 original | 100% | 99% | 100% | 98% |
| 300 px tall | 100% | 99% | 100% | 98% |
| 140x196 thumb (native) | 98% | 100% | 100% | 99% |
| 137 px (downscale) | 66% | 89% | 97% | 93% |
| 114 px | 37% | 61% | 82% | 68% |
| 137 px + 5-crop shift TTA | 73% | 94% | 98% | 94% |

Real screenshot tiles (Playwright, 1100x700, DPR1, img element 95x130): raw 52%, +adapter 80%, top-5 90%, +prior 84%.
DPR2 changes nothing (the thumb only has 196 px of detail); this matches the earlier 77/102 at DPR1 and DPR2.

Current gate replayed on the same inputs (`evalfuse.py`; name_vote ignored):

| input | accepted by gate | right name among accepted | always show top-1 | pick-list top-3 | top-5 |
|---|---|---|---|---|---|
| real screenshot tiles | 82% | 87% | 80% | 86% | 90% |
| 137 px downscale | 81% | 95% | 89% | 95% | 97% |
| native thumb | 100% | 100% | 100% | 100% | 100% |

Reading: (a) resolution is the dominant cause; (b) the adapter already recovers a lot; (c) the gate abstains on ~18% of tiles whose
top-1 is right about half the time, so "always best guess + pick-list" would name ~15 more cards right on this page (and
flag them unsure); (d) the true card is in the top-5 90-97% of the time, so a pick-list nearly always contains it;
(e) detector and catalog are not the cause (all 102 boxes found; Base Set is fully in the catalog; native thumbs hit 100%);
(f) the extension's real run (65 right / ~12 wrong / 25 "Unknown") is below the offline 80% because the extension crops the
slot and rounds sizes, and the gate declines; the offline harness is the way to separate these.

## 4. Goals and metrics

Primary metric (per page type, per tile size): **right-name rate over all tiles** (best guess), with these companions:
accepted-right rate (right name among reads shown without a pick), wrong-high rate (must stay <= 3%, as `fusion.js`
documents), pick-list recall@5, abstain rate, scan time. Targets for the 102-card pokellector page at 1100x700:

| Metric | Today | Phase target |
|---|---|---|
| Right name (any shown guess) | ~64% (65/102) | >= 90% (source image) / >= 85% (screenshot only) |
| Rows | 102 (stable after the dedupe fixes) | 102 |
| Pick-list recall@5 | 11 of 25 "Unknown" rows | >= 95% of unresolved rows |
| Wrong shown as sure ("high") | 0 | 0 |
| Scan time | 32-51 s | <= 60 s even with refinement |

### 4.1 Eval harness design (build first, run here)

Layers, cheapest first:
1. **Offline embedding eval** (exists: `/workspace/eval/evalq2.py`, `evalfuse.py`, `evaltiles.py`, `tileshot.mjs`). Takes labeled images, embeds with the
   shipped ONNX, searches the shipped catalog, optionally applies `adapter.bin`, a set prior, a candidate gate. No browser. ~35 s for 102 cards x 7 sizes.
   Extend with: `--adapter PATH`, `--gate-json` (so thresholds from `fusion.js` are read from one place), pick-list recall, per-size sweep 90-200, DPR 1/2,
   JPEG q 60-90, 5-crop TTA, CSV output.
2. **Labeled sets** (embeddings + ids may be committed; images stay on disk, rights-respecting):
   - Pokellector Base Set 102 (have: thumbs + originals + titles; `/workspace/pokfix`).
   - **Multi-set pages** (needed for the soft prior): build 3 fixtures from pokellector/TCGdex listings: (a) a mixed "Base Set + Jungle + Fossil" page, (b) a
     "Charizard across sets" page (same art, many sets; exact-printing stress), (c) a page of Scarlet & Violet (151 cards, at the 200-card cap).
     Labels come from page titles (same regex as `evalq2.py`).
   - Existing: 3-card, 22-card (must stay 22/22) and `mixed.html`.
   - Never mix HiBid dev/sealed data into tile tuning (existing rule in `build_seed.py`).
3. **In-browser check** (exists: `e2e2.mjs`, `tC.mjs`, `tR.mjs`): 3/3, 22/22, fixture x2, live page x2 at 1100x700; report rows, right-name count, time.
   Record the offline-vs-browser gap; it should shrink to < 5 points as the crop/gate matches.
4. **Gate replay in the data repo**: add a `tiles.npz` regression slice (embeddings+ids only, produced from the offline harness) and report it as its own
   column in `STATUS.md`; keep HiBid as the "must not regress" slice.

Rules: tune on a dev split, report on a held-out page; never tune on the same 102 cards you report (split by set number, e.g., even/odd, or hold out a second
set); log every threshold with the data it was fit on (`fusion.js` style comment).

## 5. Roadmap

Each phase is independent and ends with the standard verification block (V): `node --test` (unit), `npx eslint tools/extension-wasm`, 3/3 Base Set,
22/22, fixture x2 + live pokellector x2 at 1100x700 (rows, right names, time), and the offline harness table. All code stays in `tools/extension-wasm` unless noted;
no manifest permission changes except where stated.

### Phase 0 - Baseline and harness (1 day, here)
Files: `scripts/` (new `eval-tiles.py`, `eval-tiles.mjs`), fixtures dir. Output: the table in section 3 for all fixtures. Risk: none. Decision needed: where fixtures live (a
new `tests/fixtures/tiles/` of ids + embeddings only, not images).

### Phase 1 - Best guess + pick-list instead of "Unknown" (0.5-1 day, here) **Gain: ~+15 right names on the 102 page; risk: wrong guesses shown (always flagged "unsure", never "high")**
- Matches the owner rule in HANDOFF ("always a best guess; do not withhold an answer behind an accuracy gate; a wrong guess is fine, the correction trains").
- Files: `lib/fusion.js` (new reason `best_guess` instead of `ambiguous`/`low_sim` when top-1 sim >= a floor, e.g. 0.60, `unsure: true`, confidence capped below `BELOW_HIGH_CONFIDENCE`), `lib/page-prior.js` (`BEST_GUESS_CAP` already exists for set guesses), `lib/card-display.js` (classify as `pick`, keep the lot-value rule that unpicked unknown = $0), `popup.js`.
- Calibrate, don't guess the floor: choose the floor/margin where the right-name rate of "guess" rows beats the cost of a wrong pick on the offline set (see 6.4).
- V + check `scanStatus` counts ("N need your pick").

### Phase 2 - Soft, multi-set page prior (1-2 days, here) **Gain: +4-7 points at 114-137 px (measured 89->93, 61->68); risk: low if soft**
- Design (not a hard filter): pass 1 reads all tiles; the set histogram comes from **confident reads only** (clear_gap or sim >= .85) plus any set the page text names
  (`page hint`, `lib/page-focus.js`, `title-prior.js`). Pass 2 re-ranks only unresolved rows: `rank = cosine + beta * log(p_set)` where `p_set` = smoothed share of
  that set on the page (Laplace + a small floor so unseen sets keep a chance). Hard filter only on explicit user action ("this page is Base Set").
- Multiple sets, era-spanning pages, binder photos: a set is in the pool if it holds >= 10% of confident picks **or** is named in the page; beta swept 0.01-0.05 on the multi-set fixtures.
  Reprints (same art in several sets) are tie-broken toward in-pool sets, which is the printing the page almost certainly shows.
- Files: new `lib/set-prior.js` (pure, unit-tested), `background.js` (second pass after the screen loop, before `finalize`), `lib/search.js` (`searchCatalog` option `prior`), tests in `tests/`.
- Risk: pages that mix an unseen set with a dominant one; mitigated by the floor and by never changing a clear-gap read.

### Phase 3 - Read the source image for grid tiles (2-4 days, here; one owner decision) **Gain: up to ~+20 points (80% -> 98-100% on this page)**
Findings on permissions (section 7): it is **not a blocker**. The fetch machinery, size/time/redirect caps and host allow-list already exist for photos
(`loadPhotoSource`, `canReadPhotoSource`, `lib/photo-fetch.js`, `lib/full-size.js`); grid tiles simply never use it.
- Progressive, not blanket: scan from screenshots as today (fast), then **refine only unresolved tiles** (gate-abstained or low-margin) by fetching a larger rendition.
  The page's tile image is `.../Alakazam.BS.1.thumb.png` (140x196, 65 KB); removing `.thumb` gives the 570x795 original (1 MB; HTTP 200 verified). Fetching the
  thumb's own `src` (65 KB) is enough for the first refinement: 196 px is already 98-100% on this page.
- Files: `lib/full-size.js` (generic "strip `.thumb`/`_thumb`/`-small`/`_150x200`" rewrites, plus `srcset` largest, already partly there), `content.js`
  (send each card's `src`, `srcset`, `naturalWidth/Height`, `currentSrc`; keep the stable anchor id so the result maps to the row), `background.js` (new refine pass using the existing
  budget: e.g., <= 40 fetches, 6 in flight, 4 s each, 25 MB total, `credentials: "omit"`), `lib/page-scan.js` (budget helper). Store only the embedding, never the image.
- Gate refinement on: `naturalWidth` >= 1.25x displayed (already `MIN_GROWTH`), same host list as the page loaded images from, public https only (already enforced by `publicHttpsUrl`).
- Fallback is the current screenshot path; the row never gets worse than today.
- Store build: `<all_urls>` is **optional** there; the popup already offers "site access" after a screenshot-mode scan (commit 25adc7e). Add a one-line hint on grid pages
  ("Read sharper images from this site"), requested from the click. The dev/unpacked build already has `<all_urls>` granted, which is why my harness could have used it.
- Risk: bandwidth (cap above), hosts that block hotlinking/need cookies (omit credentials; fallback), animated/webp/avif decode (use `createImageBitmap(blob)`), privacy copy
  (images fetched from the site you are already viewing; nothing sent anywhere). Update the store privacy text accordingly.

### Phase 4 - Multi-crop / multi-scale embedding on unresolved tiles (1 day, here) **Gain: +3-5 points at 137 px (89->94); cost 5x embed time on those tiles only**
- Average L2-normalised embeddings of 5 shifted centre crops (+-4% shift) and optionally two resize scales; apply only to rows still unresolved after Phase 3.
- Files: `lib/embed.js` (`embedCardMulti`), `background.js` (call site), unit tests. Keep `EMBEDDING_VERSION` unchanged (catalog side stays single-crop).
- Risk: runtime (WASM single-thread, ~0.3 s/embedding now); cap at 40 tiles per scan.

### Phase 5 - Retrain the adapter for tile-like inputs (2-3 days, CPU ok) **Gain: unknown, plausible +3-8 points at 114-137 px; risk: regressions on listing photos**
- Why: the seed adapter (HiBid-fit) already lifts 137 px from 66% to 89%, so there is real headroom with in-distribution augmentation.
- Steps: (1) `card-scanner-data/pipeline/augment.py`: add `downscale_upscale` (target heights 90-200 px, bicubic/area down, bilinear/nearest up, random JPEG) with p~0.6;
  (2) `scripts/build_seed.py --per-card 3 --max-synthetic 8000` (embed on CPU: roughly 0.1-0.2 s per image => ~40-80 min on this 8-core box; needs catalog art from `data/card-catalog/images`,
  which is on the owner's PC, or re-download from `https://assets.tcgdex.net/...` using `meta.json` `imageUrl`); (3) `train_adapter.train(...)` (numpy Adam, softmax over the whole catalog, <= 8 min);
  (4) score with the Phase 0 harness on **held-out sets** (not the 102 Base Set cards used for tuning).
- Gate change in `pipeline/gate.py`/`run.py`: add a `tiles` regression slice and require "no worse on HiBid and better or equal on tiles".
- Do not ship if HiBid regression (0.5074 now) or `wrongHigh` (2.46%) moves the wrong way. Candidate is just a new `adapter.bin`; no extension release needed (the bundle path is signed by the owner's key in the sign job).
- Alternatives measured in the literature: linear-probe / CLIP-Adapter / Tip-Adapter are the same family as what exists; only gain is data, not architecture.

### Phase 6 - Make the community loop actually learn (ongoing; owner actions + small pipeline edits)
- Verify opt-in UX and the relay end to end with a second device/profile; get >= 2 installs on 2 different days (the promotion rule) before expecting promoted rows.
- Decide a "trusted corrector" rule for the owner's own corrections (e.g., one trusted install can promote when the id is in the top-20), otherwise the owner's
  corrections will never become rows. This weakens the 2-install protection, so it is an owner security decision.
- Add a `tiles` slice and a status line "tile top-1" to `STATUS.md`; add a weekly `workflow_dispatch` with a `--dry-run` that posts the numbers in the summary.
- Active-learning angle: the pick-list rows are the most informative corrections (smallest top-1/top-2 margin first). Use margin sampling to order the "needs your pick" list
  so the user's first picks are the most valuable ones; add a "Confirm all as shown" button for rows whose guess is right (cheap to produce data).
- Never auto-train on unreviewed detector output (existing lesson in `tasks/lessons.md`).

### Phase 7 - Calibrated abstention and pick-list size (1-2 days, here, after Phase 0)
- Replace hand thresholds by a calibrated top-k: fit a temperature on the labeled sets, convert top-k cosines to probabilities with softmax(tau), show the **smallest list whose cumulative
  probability >= 90%** (a conformal-style prediction set; with split-conformal on a calibration set for a coverage guarantee), capped at 5. Auto-accept when the top-1 probability >= p_hi.
- Keep current thresholds as the fallback; refit whenever model, crop, or catalog changes (existing warning in `fusion.js`).
- Files: `lib/fusion.js` (new `calibratedRead`), `lib/card-picker.js` (list size), `scripts/` (fit script).

### Phase 8 - Bigger model changes (owner's PC with GPU; 1-3 weeks; only if Phases 1-5 leave a gap)
- 8a. Re-embed the catalog at multiple resolutions (e.g., 3 augmented low-res views per card, mean/max aggregated) - **no model change**, CPU feasible overnight (22k x 3 x ~0.15 s = ~2.7 h here), but doubles/triples `catalog.bin` (45 MB -> up to 135 MB); mitigate by keeping one mean-vector per card.
- 8b. Fine-tune a small recognizer with metric learning (ArcFace with multi-task illustration/set labels as CollectorVision does), heavy low-res/JPEG/glare augmentation, on catalog art for 22k classes. Needs GPU, PyTorch, 1-2 days of tuning; produces new `clip_visual_int8.onnx`/`catalog.bin`/`meta`, new `EMBEDDING_VERSION`, refit `fusion.js`/hub penalty/adapter/`pack`, and invalidates stored corrections (versioning exists).
- 8c. Backbone swap (DINOv3 ViT-S/B, MobileCLIP2-S0, SigLIP2-B/16): DINOv3 beats CLIP on instance retrieval by large margins in published benchmarks; at 22k classes with a 224 px input it is unproven for 130 px cards, so run a **zero-training bake-off** on the Phase 0 harness first (export to ONNX, embed the 102 tiles and the catalog art). Size/latency tradeoff in WASM matters (ViT-B CLIP int8 is 38 MB; MobileCLIP2-S0 vision ~43 MB, 256 px).
- 8d. Detector retrain: not indicated by any data here (all 102 boxes found); the v7b lesson says gate on right/wrong names end to end.
- 8e. Performance: ORT Web WASM is single-thread in the service worker (`numThreads = 1`); multi-thread needs cross-origin isolation or an offscreen document with a sandboxed iframe (fragile); WebGPU EP in an offscreen doc is possible but int8 op coverage is incomplete. Defer until accuracy work is done; the 5x TTA budget is the first thing that would need it.

### Hybrid verification (small, opportunistic)
OCR + embedding: the card number "NN/102" and set symbol are already read where the crop is large enough (`lib/card-number.js`, `corner-read.js`, `set-symbol*.js`, `set-totals.js`).
For grid tiles with 130 px height numbers are unreadable, but after Phase 3 the 196-570 px source makes them readable: use the number + set total to break reprint ties
(the page's own plaque text "#1 - Alakazam" is even cheaper: the DOM text beside the image is ground truth on many sites; treat it as a strong prior with the soft-prior mechanism, never as the only evidence).

## 6. Sequencing and expected effect (102-card page, name rate; estimates from section 3, to be re-measured)

| After phase | Estimated right-name rate |
|---|---|
| Today | ~64% (65/102) |
| 1 (best guess + pick-list) | ~80% of tiles shown with a guess, 90% of unresolved rows have the right card in the list |
| 1+2 | ~84% |
| 1+3 | 95-100% on sites with larger sources |
| 1+2+3+4 | ~97-100% (sources), ~88-92% (screenshot only) |
| +5 | +3-8 points at small sizes |

## 7. Permissions / CORS research for reading source images in MV3

- **Service worker fetch with host permissions bypasses CORS** (extension origin; content scripts do not). Bytes -> `createImageBitmap(blob)` -> `OffscreenCanvas` -> **no tainted canvas**,
  because the blob comes from the extension's own fetch. This is exactly how `loadPhotoSource` works today.
- `<all_urls>` is granted in the dev manifest; the **store build only declares it as `optional_host_permissions`** (HANDOFF; `scripts/lib/store-package.mjs`), so users must grant "site access"; `lib/site-access.js` already checks `permissions.contains`
  per site and `requestAllSites` must be called from a click. The popup already offers it after a screenshot-mode scan.
- `declarativeNetRequest` is not needed (no header rewriting; only for hosts that require a Referer, which we can't assume). `credentials: "omit"` and `publicHttpsUrl()` already keep it low-risk.
- **Offscreen document is not needed for fetch/decode** (service worker has `fetch`, `createImageBitmap`, `OffscreenCanvas`). Only needed for DOM parsing, multi-thread ORT workers, or WebGPU.
- SVG is the only image type a worker cannot rasterize; irrelevant for cards.
- Preflight still applies to non-simple requests; a plain GET of an image does not preflight.
- Chrome Web Store: broad host access invites deeper review; keeping `<all_urls>` optional + a clear in-product reason is the documented route.
- Practical caveat for the plan: HTTP-only sites are rejected by `publicHttpsUrl` (my local fixture is `http://127.0.0.1`), so the Phase 3 browser tests need either an https local fixture or a dev-only allowance (dev-only blocks exist in `background.js`).

## 8. Pick-list UI: what exists and the design

Exists today: `classifyCard` -> `identified | pick | unrecognised`; unknown rows say "Which card is this?" with "Closest matches" (up to 5 from `closestMatches`/`candidatesFor`) and
"Not listed? Search"; the "Set?" menu handles printings (`set-choice.js`, near 0.05 cosine); corrections go through `correctionRecord` and, if opted in, to the relay.
Gaps: (1) candidates are ranked by raw hit order, so they include cross-era junk (Donphan, Deoxys for a Base Set Hitmonchan); (2) abstain rows show no best guess; (3) no batch
actions; (4) no thumbnails of candidates (verify in `popup.js`); (5) 102 rows is a long list.
Design:
- Each unresolved row shows the **best guess pre-selected** (grey "unsure" stripe) with the next 2-4 candidates as small thumbnails (catalog `imageUrl`), ordered by calibrated probability (Phase 7) and the page set prior (Phase 2). Tap a thumbnail = pick; tap the guess = confirm.
- List size = smallest set with >= 90% cumulative probability, 2..5 entries; always "Not listed? Search".
- Sort unresolved rows by smallest margin first; header "Confirm all N likely correct" for rows whose probability >= p_hi; keyboard 1-5 to pick.
- Lot value counts only confirmed or high-probability picks (current rule: unpicked unknown = $0 stays).
- Every pick/confirm is a contribution when opted in (`source: pick | confirm | wrong-card`), which is the active-learning stream.
- Files: `lib/card-picker.js` (rank + size), `lib/card-display.js` (classification, counts), `popup.js`/`popup.html`/css (thumbnails, batch confirm), `lib/contribution.js` (unchanged schema).

## 9. Best-practice notes feeding the plan (with sources)

- Instance retrieval: self-supervised DINOv3 CLS cosine retrieval leads CLIP/SigLIP on Oxford/Paris/Met/AmsterTime by large margins; DINOv2 vs OpenCLIP on Paris-Hard: 83.5 vs 60.2. -> bake-off, not assumption.
- Card-specific prior art: CollectorVision (MobileViT-XXS, ArcFace on illustration_id + set_code, 128-d, 448 px input, corner detect + dewarp, <100 ms CPU); corner detector 4.2 MB. Shows a small purpose-built embedder is feasible, and a dewarp step matters.
- Resolution: FixRes shows train/test apparent-object-size mismatch hurts and multi-scale averaging helps -> multi-crop/multi-scale averaging, and low-res augmentation at train time.
- Adapters: CLIP-Adapter (residual feature adapter), linear probe, Tip-Adapter (training-free cache; fine-tuned keys in ~20 epochs). The existing adapter + memory pack is this family.
- Metric learning: ArcFace (s=64, m=0.5) / sub-center ArcFace for noisy labels; relevant only for Phase 8b.
- Hubness: CSLS (2cos - r_T - r_S) reduces hub rows; the repo already has a penalty list; re-fit it for any model/catalog change; verify it is present in the shipped build.
- Selective prediction: max-softmax/top-k thresholds calibrated on held-out data; temperature scaling for calibration; conformal prediction gives sets with coverage guarantees -> pick-list sized by calibrated coverage.
- Active learning: margin sampling (smallest p1-p2) is the standard correction-prioritisation signal.
- ORT Web: int8 is 2-3x faster than fp32 on WASM SIMD; multi-thread needs cross-origin isolation; WebGPU needs an offscreen document in MV3 and has incomplete int8 coverage; service workers can't spawn the ORT worker threads.
- Vector search at 22k x 512 is brute-force territory (~11M multiply-adds per query); ANN adds nothing.

## 10. What runs where

| Task | This box (8 cores, 15 GB, no GPU, no torch) | Owner PC |
|---|---|---|
| Offline eval harness, set prior, gate/pick-list logic, TTA, unit tests, browser verification (Playwright/Xvfb) | yes | optional |
| Source-image refinement (dev build has `<all_urls>`) | yes (https fixture needed) | final check on the store build's optional permission prompt |
| Adapter retrain (numpy) with new augmentation | yes, if catalog art is downloaded (hours of embedding) | faster, and has `data/card-catalog/images` + labeled crops |
| Catalog re-embed at multiple scales | possible overnight, slow | yes |
| Fine-tune / ArcFace / DINOv3 / detector retrain | no (needs GPU + PyTorch + data) | yes |
| Signing key, relay deploy, Cloudflare/GitHub settings, store submission, `hub-penalty.bin` build | no | yes (owner-only) |

## 11. Owner decisions

1. Approve "always show a best guess" for abstained tiles (Phase 1), and the minimum similarity floor.
2. Approve reading source images on grid pages; accept the optional-permission hint and the privacy text update; set the fetch budget (default: 40 fetches, 25 MB, 4 s each).
3. Allow generic `.thumb`-style URL rewrites in `lib/full-size.js` (site-agnostic) vs only same-`src` fetches.
4. Soft set prior: OK to also use the page's own plaque text as a prior? (default yes, as a prior only)
5. Adapter retraining: OK to add a `tiles` regression slice and relax "improved" to "no worse on HiBid and not worse on tiles"? Who runs it, here or on your PC?
6. Community loop: trusted-corrector rule for your own corrections; when to switch opt-in on; when to submit to the store so real users contribute.
7. Is `hub-penalty.bin` in the store build? If not, build it (owner data) and add it to the package.
8. Appetite for Phase 8 (GPU work): which backbone to bake off first (DINOv3 vs MobileCLIP2), and the app size budget (currently ~38 MB model + 45 MB catalog).

## 12. Sources

- MV3 network/CORS: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- Permissions (host, optional): https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions ; https://developer.chrome.com/docs/extensions/reference/api/permissions
- Fetch + createImageBitmap + OffscreenCanvas pattern (no taint): https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Gf7jRvba7Nc ; https://github.com/wpelliss/image-converter ; https://extension.js.org/docs/implementation-guide/cross-origin-requests
- Offscreen documents: https://developer.chrome.com/docs/extensions/reference/api/offscreen ; https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3 ; multi-thread ORT in extensions: https://github.com/xenova/transformers.js/pull/462
- WebGPU in extensions: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/ZEcSLsjCw84 ; https://github.com/mlc-ai/web-llm/tree/main/examples/chrome-extension-webgpu-service-worker (treat third-party summaries as leads; verify on a Chrome build)
- ORT Web deploy / env flags / performance: https://onnxruntime.ai/docs/tutorials/web/deploy.html ; https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html ; https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html ; https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/
- Web Store review of broad hosts: https://developer.chrome.com/docs/webstore/review-process ; https://developer.chrome.com/docs/webstore/troubleshooting
- DINOv3: https://arxiv.org/html/2508.10104v1 ; DINOv2/OpenCLIP Paris-Hard table: https://www.wizwand.com/sota/instance-level-recognition-on-paris-hard ; GLDv2 leaderboard: https://www.sota2.com/research/sota/image-retrieval-on-gld-v2-public-private-evaluation ; fine-grained retrieval with foundation models (linear adaptation, DINOv3/SigLIP2): https://openaccess.thecvf.com/content/CVPR2026W/FGVC13/papers/Liu_Efficient_Fine-grained_Image_Retrieval_with_Vision_Foundation_Models_for_Industrial_CVPRW_2026_paper.pdf
- Card recognition prior art: https://github.com/HanClinto/CollectorVision ; https://huggingface.co/HanClinto/milo ; https://huggingface.co/HanClinto/cornelius ; https://github.com/prateekt/pokemon-card-recognizer ; https://github.com/SandeepSawhney2015/Pokemon-Card-Identifier
- Resolution / multi-scale: https://arxiv.org/html/1906.06423v4 ; https://github.com/facebookresearch/FixRes
- Adapters: https://arxiv.org/html/2110.04544 (CLIP-Adapter) ; https://arxiv.org/abs/2207.09519 (Tip-Adapter)
- ArcFace / metric learning: https://arxiv.org/abs/1801.07698 ; https://kevinmusgrave.github.io/pytorch-metric-learning/losses/
- Hubness / CSLS: https://arxiv.org/pdf/1710.04087 ; https://pmc.ncbi.nlm.nih.gov/articles/PMC7327987/
- Selective prediction / conformal / calibration: https://deepwiki.com/aangelopoulos/conformal-prediction/2.1.3-selective-classification ; https://mapie.readthedocs.io/en/stable/content/conformal-prediction/classification/ ; https://proceedings.mlr.press/v267/dabah25a.html ; https://arxiv.org/html/2402.04344v2
- Active learning from corrections: https://link.springer.com/article/10.1007/s10462-022-10246-w ; https://khoury.northeastern.edu/home/vip/teach/MLcourse/4_boosting/materials/settles.activelearning.pdf ; https://www.mdpi.com/2227-7390/11/4/820
- Small models: https://huggingface.co/felixhrdyn/mobileclip2-s0-onnx ; https://huggingface.co/plhery/mobileclip2-onnx ; https://huggingface.co/exposure-app/siglip2-b16
- Live data repo (read-only): https://github.com/fabcrowd/card-scanner-data/releases ; https://github.com/fabcrowd/card-scanner-data/releases/tag/status

## Appendix A - Reproduce the numbers

```
cd /workspace/eval            # copies of the scripts; originals in /workspace
python3 evalq2.py             # size x adapter x set-prior table (needs /workspace/models, /workspace/pokfix/{img,full}, /workspace/loop/adapter.bin)
node tileshot.mjs 1           # real screenshot tiles of the fixture (server on :8766) -> /workspace/tiles
python3 evaltiles.py          # embed those tiles
python3 evalfuse.py           # gate replay: accepted / right-among-accepted / pick-list recall
```
Fixture server: `python3 -m http.server 8766 --directory /workspace/pokfix`. Live catalog art URLs come from `meta.json` `imageUrl` (tcgdex).
