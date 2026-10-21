# Facebook accuracy and UI pass (2026-10-19 → 21, feat/fb-accuracy-ui)

- [x] Step 1: a sure name with an open printing shows as identified; names from 200 px (899ba40)
- [x] Step 4: drop edge-cut boxes (e48c421)
- [x] Step 2: gallery scan + cross-photo dedupe (b032a2b)
- [x] Step 3: site-access offer (4eeb10f)
- [x] Step 5: overlay tags by verdict; popup follows rescans (49600f0)
- [x] Fix 3: adapter wait on first scans (226ba94)
- [x] Fix 1: Facebook `ctp=` original (2dc8aec)
- [x] Fix 2: title-line second opinion (e554499)
- [x] UI: bigger tags (9377d62); one search link per row (e06cc24)
- [x] Guess-first, lot totals, full-size offer (ba59d38); guesses over $50 kept out of the total (5a02883)
- [x] Training plan doc (4c4aae5)
- [x] Rejected, not committed: step 1b title guard, crop-shift re-rank, Real-ESRGAN / bicubic upscaling, blurry catalog copies, blur adapter bm0.5 (numbers in HANDOFF)
- [ ] Owner: review and merge the PR for `feat/fb-accuracy-ui` (not merged)
- [ ] Owner: re-test live in real Chrome on the two FB listings: site-access prompt, gallery, full-size bar
- [ ] Score the 12 sure cards the full-size tab produced on fbo-photo-1
- [ ] Blurry training per `docs/blurry-training-plan.md`; the gate must include FB-style sure-wrong
- [ ] The eval pack (`/workspace/fb-eval-pack.zip` on the Linux box) stays out of the public repo; copy it to the PC by hand

# Overlay / extension UI smoke (2026-10-19)

- [x] QA auditor: Chromium click-through of popup, settings, overlay; report in `tasks/qa-smoke-report.md`
- [x] QA-1: overlay labels clamped to the card; price-only under 140 px (`content.js`; Chromium `overlay-wide-fixed.png` / `overlay-narrow-fixed.png`)
- [x] PM re-verify QA-1 in Chromium (labels only; live scan still untested)
- [ ] QA-2 deferred: price-snapshot 404 `console.error` on popup open until the data-repo nightly publishes `prices.json`
- [ ] Do not commit Playwright profiles under `tasks/qa-smoke/*-profile-*`

# Daily prices from the data repo (2026-10-18)

- [x] Nightly writes `prices.json` and the sign job publishes it on the `prices` pre-release (not `latest`)
- [x] The extension downloads that one file once a day and overlays TCGdex markets by TCGPlayer product id
- [ ] The live nightly is the copy of `tools/shared-data` on `fabcrowd/card-scanner-data`. Until that copy includes this job, scans still show TCGdex's date

# Extension accuracy pass on grid pages (2026-10-18, fix/extension-only)

- [x] Dedupe rows by page element across layout shifts (a1a93e6); read each grid tile once (bf83b31)
- [x] Always show a best guess + pick-list on grid tiles (2ffb802)
- [x] Soft multi-set page prior (da083e2)
- [x] Re-read unsure grid tiles from the page's own picture, capped, degrades on failure (7f99f35)
- [x] Multi-crop averaging tried and reverted (more confident wrong names, no more right names); see HANDOFF.md
- [x] 108-vs-102 row count discrepancy: caused by ad-shifted layouts counting a tile twice (a1a93e6)
- [ ] Owner's PC: `npm test` and lint on Windows incl. the Windows-only `tests/store-build.test.js`; real Chrome Pokellector run vs the old 97-98 figure
- [ ] Store build: check the optional `<all_urls>` prompt covers source-picture refinement; update privacy text if needed
- [ ] Test refinement on other grid sites
- [ ] `hub-penalty.bin` missing from this checkout; confirm the store build ships it
- [ ] Adapter retraining with small-tile augmentation and a tiles regression slice in the nightly gate (`card-scanner-data`)
- [ ] GPU work: backbone bake-off, fine-tune, detector retrain (docs/improvement-plan.md Phase 8)
- [ ] Self-improvement loop: 1 contributor, 0 promoted rows, 46-byte community pack; needs real contributors (opt-in off, store listing not submitted)

# Store-build debug (2026-10-18)

- [x] Page set hint: set in heading/breadcrumb/title is the best guess for open rows (1536670)
- [x] Overlay labels clamped to card width; price-only under 140 px (restored 2026-10-19 after QA-1)
- [x] Era-restricted search; store build no longer requests variant.onnx
- [x] Site access and toolbar click tested on the unmodified store build via CDP `Extensions.triggerAction` (`--enable-unsafe-extension-debugging`) and Windows UI Automation on the permission dialog (`.tmp/debug-store/plib.mjs`, `p8.mjs`, `accept.ps1`)

- [x] Whole-page scan (d4f8c12): up to 12 screens / 200 cards, dedupe, scroll restored
- [ ] Whole-page scans of big sets take ~3 min for 200 cards and need the popup open throughout: speed up per-card recognition or run the scan without the popup
- [x] Back-to-back whole-page scans found 108 then 102 on Pokellector Base Set: ad-shifted layouts counted a tile twice (a1a93e6)

# Fix corner-as-front photo selection (2026-08-11)

## Plan
- [x] Restore mtime on download; sort flat inbox by IMG_####
- [x] Identify fronts/backs by content; next full-card = back; match closeups by similarity
- [x] Set front reprocesses identity; UI shows extras
- [x] Tests + README
- [x] Inbox front picker (Browse inbox photos)
- [x] Retrain Vellum detector multi-class (full_card / corner_closeup / card_back)

## Review
- Detector classes teach corner≠front; `usable_as_front` requires full_card @ conf≥0.35
- Bootstrap from inbox + 45% synth corners; corner→full rate 0% on val
- Hand-label hard failures in `data/vellum-detect/` for the next retrain

# Multi-card detection improvement (2026-09-06)

## Scope
Make contour multi-card detection reliable enough to split a table photo of 2–6 cards into individual rectified crops.

**Will change:** `tools/vellum-ai/vellum_ai/detect_multi.py`, `tools/vellum-ai/tests/test_detect_multi.py`, `src/photos/splitMultiCard.js` + JS tests if splitter behavior must change.

**Will not:** retrain YOLO, rewrite single-card `detect.py`/`rectify.py` except calling existing `rectify_card` with kept quads.

## Known failures (Claude left these mid-fix)
- [x] Grid tests fail: 5% max-area cap rejects cards that are 9–13% of a tight-grid canvas
- [x] 30°/45° tilt: `_score_quad_multi` used AABB aspect (square at 45°) — minAreaRect patch is in file, unproven
- [x] Contour finds quads then discards them; crops use AABB via `rectify_from_box` (background + no perspective)
- [x] Hardcoded warm-brown table mask (`H 5–35`) fails on other surfaces
- [x] 3-card unit test only requires 2/3; no JS tests for `splitMultiCard.js`
- [ ] Folder inbox path never calls the splitter (flat photos only) — left as-is; folders are already one-card drops

## Plan
- [x] Prove current pytest red: `python -m pytest tests/test_detect_multi.py -v` in `tools/vellum-ai`
- [x] Replace absolute 5% area cap with a scale that allows a single card in a 2–6 card frame (keep merged-blob rejection)
- [x] Keep minAreaRect aspect; keep perspective quads through to `rectify_card`
- [x] Drop or adapt the brown-table mask so it is not a hard dependency
- [x] Tighten tests: 3-card requires 3; grids and 15/30/45° stay required
- [x] Add JS unit tests for splitter (2+ crops → paths; 0/1/error → original)
- [x] Re-run pytest + `node --test` for the new JS file

## Success
- All `test_detect_multi.py` tests pass
- Splitter JS tests pass
- No ONNX / YOLO retrain
- Surgical diffs only

## Review
- `_MAX_AREA_FRAC` 0.05 → 0.35. Grid cards (~9–13%) kept; near-full-frame blobs still rejected. Merged pairs still die on aspect + landscape AABB (`W/H > 1.15`)
- Contour hits keep `quad`; crops use `rectify_card`. ONNX still AABB
- Removed brown `non_table` edge map
- Evidence: pytest 22/22; `tests/split-multi-card.test.js` 4/4
- Not done: folder inbox still does not split (intentional — one folder = one card). No live table-photo eval this pass

# Multi-card identity loop (2026-09-06)

Sequential / safe. Runbook: `.claude/plans/multi-card-identity-loop.md`

**Will change:** `tools/vellum-ai/vellum_ai/eval_score.py`, `tests/test_eval_score.py`, `tests/test_detect_identity.py`, `detect_multi.py` only if a new stage fails, `loop_stages.json`, plan notes.

**Will not:** YOLO, commits, catalog download.

## Plan
- [x] Confirm baseline: `test_detect_multi.py` 22/22; `ECC_HOOK_PROFILE` not disabled
- [x] Identity-weighted scorer (70% ID / 20% IoU / 10% count); wrong ID cannot pass on boxes
- [x] Stages 1–2: 2-card and 3-card verified IDs after detect+crop
- [ ] Stage 3: 2×2 grid IDs
- [ ] Stage 4: 3×2 grid IDs
- [ ] Stage 5: 30° tilt ID
- [ ] Stage 6: live queue/catalog or skip

## Stop
6 ticks, or stage 6 done, or two stalled ticks.

# Photo ID port — qtran pHash + spatial OCR + Didier grid (2026-09-06)

Plan reference: `.cursor/plans/photo_id_port_fdc3c1a5.plan.md` (not present in this checkout; do not rely on it). Full handoff: [`HANDOFF.md`](../HANDOFF.md).

## Plan
- [x] Phase 1: pHash rerank + catalog helper + tests
- [x] Phase 2: HP-anchor name OCR + tests
- [x] Phase 3: verify_grid + identify_multi imageUrl/grid + cycle `officialArtUrl` + worklist dual thumb + unit tests
- [ ] Browser-verify dual thumb on live dashboard (inject mock worklist row; server may already be on :3000)

## Review
- CLIP crop untouched; no commit
- pHash sidecar generation was subsequently completed: `HANDOFF.md` records 21,669 entries in `data/card-catalog/phash.json`. Revalidate that artifact before relying on it in a new environment.
- Tests: pytest phash/ocr_names/verify_grid/identify_multi green; node official-art + ui-markup + cycle green
- Harden pass: local `pokemontcg_hires_url` (no resolve_card for art), clear TCG `identity is None` fallback, grid failures swallowed, dual-thumb DOM-verified
- Full notes: [`HANDOFF.md`](../HANDOFF.md)

# UI Scanner — ID + PRICE (2026-09-06)

## Plan
- [x] `scanAndPrice` shared core + `processCard` reuse
- [x] `POST /api/scan` + Scanner panel UI
- [x] Unit/integration tests
- [x] Live JustTCG pricing smoke (`scripts/scan-pricing-smoke.mjs`)

## Review
- Pricing pulls: JustTCG live $504.11 on Base Charizard #4
- Photo identify via UI needs `PGAI_KEY` set; without it scan returns config error (endpoint still works)
- Does not auto-list; no commit

# Optionals — backfill + phash + Vellum-first scanner (2026-09-06)

## Plan
- [x] Retry failed catalog art (`backfill_coverage.py`) — 401 recovered, 1478 still missing
- [x] Build `phash.json` — 21,669 entries
- [x] Enable Vellum in `.env`; `SCANNER_IDENTITY_MODE=local-only`
- [x] Fix identify `/health` (`__version__`); start server on `:8787`
- [ ] Optional later: re-embed 401 new images into FAISS

Credential note: do not rotate `PGAI_KEY` unless explicitly requested. This is an instruction, not a pending task.

## Review
- Images on disk: 22,070; FAISS still 21,669 (new art not embedded yet)
- `npm run vellum-ai` prefers `.venv312`; `/health` ok + catalog loaded
- Scanner uses local-only resolver
- No commit; PG key unchanged

# Detector: real listing photos (2026-10-10)

Goal: ≥ 0.90 precision and recall on reviewed real photos (binders, single cards) with no sealed-product false positives.

## Plan
- [x] Root cause: 138 harvest frames in `data/vellum-detect/images/train` were labelled as one full-frame box → quarantined to `data/vellum-detect/_quarantine_fullframe_labels/`
- [x] Real eval set `data/detect-real-eval/` (2 binder pages, 3 single-card lots, 12 held-out sealed lots; split by lot) + `detect/eval_real.py` (TDD)
- [x] Stress copies `data/detect-real-eval-stress/` (half, quarter, jpeg30, dark, flip, rot90; labels transformed exactly)
- [x] `detect/synth_binder.py` (TDD): binder pages, flat-lays, single large cards, glare, tilt, 90° rotation, thumbnails
- [x] Reviewed sealed-product negatives from train lots via `label_marketplace.py` → `retrain._ingest_frames_to_dataset` (+ rot90 copies)
- [x] `retrain.py` real-photo gate (F1 ≥ 0.90 and ≥ current model)
- [x] Fine-tune → promote only if real + stress gates pass (v4 epoch 6: real P 0.91 / R 1.00, stress P 0.92 / R 1.00 at conf 0.25)
- [ ] Publish the promoted `card_detect.onnx` to the extension's GitHub release (owner action — outward-facing)
- [ ] Human audit of Claude-reviewed labels (`review_note` in each sidecar)

## Review
- Old model on real photos: P 0.17 / R 0.14. New: P 0.91 / R 1.00 (conf 0.25); P 0.96–1.00 / R 0.99–1.00 at the val-optimal conf 0.55
- Intermediate runs: v2 e2 failed rot90 / thumbnails → added to synth; v3 lost single large cards and boxed edge slivers → added single-card mode and `_MIN_VISIBLE` 0.6
- Tests: test_eval_real 6, test_synth_binder 4, retrain gate 1 — green. Full VellumAI suite: same 11 pre-existing identify-fixture failures as before

# HiBid multi-card lots: find + price ≥ 95% (2026-10-10 → 11)

Goal (user): on multiple HiBid multi-card lots, find the correct card and price it above 95%.
Metrics: *find* = detected (IoU ≥ 0.5) and exact catalog id; *price* = find and JustTCG returned that same product (set + number); `null` ids count for detection only; out-of-catalog cards count as failures.

## Plan
- [x] End-to-end scorer `detect/eval_lots.py` (TDD)
- [x] SIFT/RANSAC verification of CLIP candidates (`vellum_ai/local_verify.py`), Pocket ids filtered, second pass over CLIP ranks 21-40
- [x] Slab labels (`vellum_ai/slab_label.py`): parse PSA text, set years (`catalog/set_years.py`), promo-year exemption, `-HOLO`/`-REV.FOIL` suffixes, set-name variety line; label boxes dropped from results
- [x] Name-OCR candidate path (`vellum_ai/name_candidates.py`) when CLIP candidates fail verification
- [x] Same-art reprints split by OCR'd collector number (`verify-ocr-number`)
- [x] Detector letterbox in the shipped Python path (HiBid F1 0.953 → 0.962)
- [x] `.png` catalog art loaded by verification; pokemontcg.io set-id mapping recovered 368 more cards' art
- [x] JustTCG pricing: strict name+number+set match, set-id-filtered search (`src/pricing/justTcg.js`); `scripts/price-eval-ids.mjs` caches prices per id (100 calls/day quota)
- [x] Blind test set: first photo of 31 test-split lots, 80 boxes / 65 identifiable ids labelled from the cards themselves
- [x] Re-embed CLIP index with backfilled art (22,485 cards)
- [x] Upright crop for tilted cards inside a box (`detect_multi._upright_crop`; `_score_quad` uses minAreaRect)
- [x] Set context: dominant set (>= 2 cards) on a photo re-verifies abstained cards against that set, and flips same-art reprints from another set to the page's set unless the number was OCR-confirmed
- [x] JustTCG set aliases (`justTcgSetName`: Black Star Promos, SM Base Set, Radiant Collection); `normalizeSetName` strips only short code prefixes
- [x] Detector v5 (`models/card_detect_v5`, last.pt): HiBid test R 0.85 -> 0.975 at conf 0.55, but stress negatives get more FPs (14 vs 5). NOT promoted: fails the stress gate. v6 (augmented negatives) rejected: recall dropped, FPs stayed
- [x] Fresh blind set `test2`: 18 lots harvested after all tuning, 130 boxes / 84 determinable ids (`decisions_test2.tsv`); `_is_train_lot` now excludes every named split other than train
- [x] Price test2: JustTCG quota exhausted, so added keyless TCGdex pricing by exact catalog id (TCGplayer USD, else Cardmarket EUR × ECB rate) + pokemontcg.io catalog-id lookup; `/api/price-grid` falls back to TCGdex
- [ ] Remaining: Crystal Guardians stamp reverse holo (Dual Ball), Generations vs BREAKthrough Gengar reprint, washed-out V binder (Regigigas V), Japanese slabs (not in catalog)

## Review
- Dev (18 photos, tuned on): find 0.981, price 0.981 — not a valid accuracy claim
- Blind test v1: find 0.462 → v2 (name path, labels, reprints, letterbox): 0.631 → v3 (upright crop): 0.723. Misses were inspected and fixed against, so this set is now partly tuned on
- **Fresh blind test2 (never tuned on): find 0.964 (81/84)** with the shipped v4 detector and with v5; detect recall 0.969 (v4) / 1.000 (v5)
- **test2 price 0.964 (81/84)** via TCGdex: every correctly found card priced as that exact product. TCGdex vs JustTCG on 57 shared ids: median diff 0%, 52/57 within 15% (outliers = 1st Edition vs Unlimited)

# Deep debugging session (2026-10-12)

## Fixed (tests first; Node 294/294, Python 219 OK)
- [x] `decidePrice` counted string / NaN / 0 comps ('12.50' + 12 gave a $606 auto price). Only finite positive numbers count now.
- [x] `/detect` showed the whole-dollar Mercari list price as `market_price` ($0.46 card showed $0.00). It now uses the unrounded median `market` from `decidePrice` / `scanAndPrice`.
- [x] `/detect` never removed `data/detect-tmp/<uuid>` (264 dirs, ~60 MB). Removed in a `finally` now. The old dirs are still on disk.
- [x] Cardmarket-EUR TCGdex comp was medianed with eBay / Collectr / PokeGrade / PokéWallet USD comps. All US comps now exclude it.
- [x] eBay sales with a missing price were counted as $0.
- [x] Dead `isUnclassifiedDetection` removed; CLAUDE.md now describes the real single-card path. `extension-overlay.spec.js` defines `originalFetch`.

## Open (confirmed by reproduction, not fixed)
Server
- [x] Multi-printing cards go `auto` at the preferred printing. `compsForOnePrinting` now treats any source with more than one priced variant as ambiguous until a printing is chosen.
- [x] Pricing fetches time out (TCGdex, JustTCG, pokemontcg.io, ECB rate).
- [x] TCGdex tries the unpadded and zero-padded id. pokemontcg.io search sends the collector number and escapes quotes.
- [x] JustTCG refuses a name-only match; `/api/price-grid` returns 400 without a set or number. The grid keeps English and the first price per condition.
- [x] Sub-$0.50 cards whose list price rounds to $0 go to needs review. Low PokeGrade confidence still forces review after the printing filter.
Python (tools/vellum-ai)
- [x] Tilted cards are warped from the already-ordered quad. Steep-tilt tests pass (25° through 75°).
- [x] A clearly read slab name is not replaced by another card at the misread number (Venusaur #16 no longer becomes Zapdos). A garbled name still resolves by set + number.
- [x] SIFT feature cache is 512 entries and does not cache missing images.
- [x] `TG06/TG30`, `SV001/SV122`, and `SWSH020` parse, and those tokens are not set codes.
- [x] `identify_lot` dedupes by catalog id. Copies in one photo stay; a second photo keeps the sharper shot.
- [x] A name with no OCR number is no longer cut at 80 prints.
Extension (tools/extension-wasm)
- [x] `printingByNumber` uses TCGdex official set totals (`lib/set-totals.js`), so 001/165 stays 151 instead of Mega Evolution. Prefixed subsets (H01/H32) use their own count.
- [x] Number parser reads each token, so "SVI EN 001/198" parses and "EN001/165" does not.
- [x] `loadPhotoSource` checks each redirect itself and blocks private hosts (`*.localhost`, IPv4-mapped, 100.64/10). Rebuilt into `dist/extension-wasm`. Reload the unpacked extension to pick it up.
- [x] A scan aborts if the tab is no longer active, and the overlay is sent to the tab that was scanned.
- [x] The photo-scan confidence floor is restored to the previous value, not left at 0.25.
- [ ] Offscreen boxes counted and pinned to the top; lazy-load auto-rescan ignores era and overwrites the enriched overlay.
- [x] The lot total follows the enabled condition. A missing condition is not filled with the NM price. Empty graded cells are skipped.
- [ ] Price cache in extension storage still has no eviction.

# Chrome Web Store launch and listing-photo focus (2026-10-16)

Plan: `docs/plans/launch.md`. Nothing is pushed (branch `feat/card-picker-sealed-test`, 22 commits ahead of `main`).

## Done
- [x] Store package: minimal permissions, optional site access, pinned downloads, store vs dev build (ef11ec4)
- [x] Privacy policy, listing copy, original icon (5d4d99c)
- [x] Scan the listing's own photo, not carousels; related-section headings; largest rendition of the photo (6830ccb, 7278b5f, 2c8678b)
- [x] Crop card art the way the catalog was embedded (34bc430)
- [x] Picker ordered by listing title; repeat-name guard; optional look-alike penalty, off (be75912, f1366ba)
- [x] Name and price when only the set is open; "high" earned honestly (a56c0e9)
- [x] Offer full-size photo access after a screenshot-only scan (25adc7e)
- [x] Lookalike versions (ex / V / VSTAR / Dark) with price ranges (ac3d08e)
- [x] Fixes from fresh-context review (a1606f2)
- [x] Shared learning: relay, data-repo template, signed community pack (508e616)
- [x] Security fixes for shared learning (87f2d0e, 58a9c93)
- [x] Real-world runs on 28 dev pages and 30 held-out pages (results in HANDOFF.md)

## Open
- [ ] Sealed test set has no labels yet; collect exam photos from real use
- [ ] Owner: manual store-zip test, contact email, privacy-policy hosting, Chrome Web Store developer account, name and icon approval, push and publish, deploy the relay and data repo (`tools/shared-data/README.md`)

# Self-learning (next) — plan: `docs/plans/self-learning.md`

- [x] 1. Security fixes (87f2d0e, 58a9c93)
- [x] 2. Signed bundle replaces the pack-only manifest (catalog, memory, adapter, check; per-part sha256; hot-load) (1f42193)
- [x] 3. Seed data, the three add-ons (memory, photo adapter, "is this a card?" check), one gate, nightly `STATUS.md` (1f42193, 03db8eb)
- [x] 4. New sets added automatically (1f42193)
- [x] Report a measured gain on the HiBid regression set before anything ships (03db8eb: accepted-right 43 -> 85, accepted-wrong 42 -> 32 on 203 rows)
- [x] Deploy relay and data repo; point the extension at them (c583710)

# Lot value and set confirmation on lots (2026-10-17)

## Done
- [x] Lot value estimate; ask about every unrecognised card (ab122cc)
- [x] Corner number read from the source photo for open-set cards
- [x] Best guess for open-set rows: page prior, then picture score; "?" confirms; Set? menu and confirm save corrections
- [x] Measured before/after on 67 HiBid lot photos and 48 synthetic pages (numbers in CHANGELOG.md 2026-10-17)

## Review
- Corner reads rescue few real lot cards: on HiBid none under 400 source px settled its set, and each try cost about a second (median scan 3.4 s -> 4.4 s, p90 8.3 s -> 15.5 s at a 120 px gate). At a 400 px gate the results are identical and the median is 3.8 s (total 310 s -> 401 s). Most of what remains is about 1.2 s per open card of 400 px or more.
- Picture-only guesses are right about half the time on HiBid (74% on synthetic pages). Shown anyway by the owner's rule: always best-guess; corrections train.
- The page prior also applies across grid tiles of a search page, which are separate listings. Not measured.

## Open
- [x] Popup simplification
  - Review: popup shows one price per card (in the row head) and one est. value; filters come only from Settings.
  - Pills, API-key hint, ms/cards stats, condition grid and warning sentences are gone (tooltips instead). Verified: npm test, eslint, popup e2e 5 of 5.
- [~] Detection learning: shape-filter part done (boxes up to 1.82 wide/tall kept; on 67 HiBid lot photos +9 cards found, +6 right names, wrong names 13→14, no losses, 0 extra boxes on sealed-product negatives)
- [x] Detector misses ~18 heavily tilted cards: tried, not shipped (2026-10-18). Retrain of v4e6 + tilted synthetic pages (`models/card_detect_v7b`) offline found 284→302/305, F1 .977 = shipped; but in Chrome on 67 lot photos found 195→203, right names 106→107, confident wrong names 14→21. Detection is no longer the bottleneck; recognising tilted cards is

