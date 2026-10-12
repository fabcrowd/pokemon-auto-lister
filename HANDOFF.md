# Handoff — UI Scanner + Photo ID port + catalog embeddings

Last recorded implementation update: 2026-10-11 (era choice, card backs, collector-number reader). Older sections below are historical and need revalidation before acting.
Workspace: `C:\Users\daroo\Desktop\Repos\cardscanner\pokemon-auto-lister`

## Era choice, card backs, collector-number reader — 2026-10-11, overnight (newest)

Steps 2 and 3 of the plan, done overnight. Nothing was committed or pushed. With the user's approval, the number reader's models were published as release [v2.2](https://github.com/fabcrowd/pokemon-auto-lister/releases/tag/v2.2) (tag at remote `main` `f0d0f83`, not Latest; v2.0 and v2.1 unchanged).

- **Era choice (replaces step 2's neighbour nudge).** Popup has an "Era" select (`lib/era.js`, saved as `scanEra`; changing it rescans). The name still comes from the full-catalog search; the printing is then ranked only among that name's printings in the chosen era (lead ≥ 0.04 picks it, otherwise up to 4 choices within 0.02). If the name was never printed in that era, the card becomes "Unknown card". Neighbour voting and automatic era detection were measured and failed (lessons 22).
  - Measured offline (40-card tuning set): exact set 4 → 15, truth offered 10 → 26. Holdout lot `279630564` photos 01–10: 2 → 8 of 10. Unseen WotC lot `279630487`: 6 → 10 of 31, wrong single answers 3 → 0.
- **Card backs** (`lib/card-back.js`): a crop whose embedding is ≥ 0.84 similar to the mean of six back crops, and closer to that than to any catalog card, shows as "Card back" instead of "Poké Ball". Holdout backs 0.891/0.922; 90 fronts at most 0.788.
- **Collector-number reader** (`lib/ocr.js`, pure parts in `lib/card-number.js`): RapidOCR PP-OCRv4 text detector + recognizer run in WASM on the bottom 12% of the card, then the bottom 20% if no number was found. It runs only when the card is ≥ 600 source pixels tall (below that almost nothing reads; see the follow-up below). "88/132" picks the printing with that number in a set whose catalog count is 0.95–1.5× the printed total. Printings of the recognized name are tried first, then the 20 closest-looking cards (this fixes unnamed cards like Lickitung). A total over 400 is treated as misread.
  - Speed in Chromium WASM, 1 thread: detector 47 ms on a strip, recognizer ~78 ms per text line; ~0.15–0.3 s per large card. Whole-lot photos are skipped by the size gate, so their scan time is unchanged.
  - Live (`LOCAL_OCR=1`): close-ups of lot `279630564` (01–04): 12 exact printings, 0 wrong (was 1 confirmed set). WotC lot `279630487` (01–04): 10 exact printings, all match the truth list. Test lot `279427892` cards are too small or cut off; one read (Vileplume δ Holon Phantoms 17/110), correct.
  - Models: `ocr_det.onnx` (= `ch_PP-OCRv4_det_infer.onnx`, 4,745,517 bytes) and `ocr_rec.onnx` (= `ch_PP-OCRv4_rec_infer.onnx`, 10,857,958 bytes) from `tools/vellum-ai/.venv312/Lib/site-packages/rapidocr_onnxruntime/models/`. They are `OPTIONAL_ASSETS` in `lib/setup.js` with release `v2.2` and sha256 pinned. They are not part of setup: after the main models load, the service worker fetches them in the background and verifies them (`getOptionalAsset`). If they cannot be fetched, the log says "number reader not available" and scans work as before (checked live before v2.2 existed).
  - v2.2 assets downloaded back from GitHub match the pinned sizes and sha256. Live, with a profile that had no OCR files: the extension fetched both from v2.2 in the background, logged "number reader loaded" 3 s after the popup opened, and the next scan read all four numbers on `279630564/04`. Users download ~15.6 MB more, once, in the background.
  - Release notes source: `data/release-v2.2-notes.md`.
  - Follow-up (2026-10-12): the size gate is **600** source px, not 700. On lot `279427892/01` (cards 485–636 px), reads come only from the ≥ 609 px cards: Cyclone Energy 90/108 (was unknown) and Boost Energy Dragon Frontiers 87/101. That photo scans in 4.0 s (6.0 s with a 450 px gate). A letter misread for a digit ("B7/101") is retried as digits (`DIGIT_LOOKALIKES` in `lib/card-number.js`) when the number as read matches nothing.
  - Measured and **not** built: ranking every catalog card with the read number by picture, for cards nobody could name. It rescues only Squirtle dp3-112 on our lots, and would pick Duosion for Sunflora (lead 0.036) and Mawile for Vileplume δ (lead 0.004). See lessons 26.
- Diagnoses with no code change (2026-10-12):
  - Koffing→Gible and Cyclone→Boost Energy on the whole-lot photo `279427892/00` (cards ~300 px) are near-ties. The true card is the #1 hit by 0.016 and 0.001, and the name vote tips them; the same vote is what makes Sunflora right. On the 9-card photo, Koffing is named right and the number reader fixes Cyclone.
  - Magneton's true printing ex11-48 ranks 1,263rd by picture, so only its number can fix it (its card is 504 px on `279427892/01`, under the gate).
  - Scans are deterministic: three scans of `279427892/00` gave identical boxes, scores, and names. Earlier "flip-flops" (Fearow, Ivysaur) were differences between builds, not run-to-run noise.
  - The live harness serves photos from `http://127.0.0.1`, so `loadPhotoSource` (https, public hosts only) refuses them and the scan crops the screenshot (1350×1800 here instead of the 1500×2000 original). Real https listing pages use the original photo, so real cards are larger than in these measurements.
- `tests/e2e/live-scan.mjs`: `SCAN_ERA=<id>` picks an era; `LOCAL_OCR=1` copies the local OCR models into the profile's model cache (in a separate browser launch, because the extension only loads the reader at startup). The temporary `[DBG-EMB]` embedding dump is removed.
- Tests: `tests/card-number.test.js` (12), `tests/era.test.js` (10), `tests/card-back.test.js` (4), `tests/search-score.test.js` (1), three new optional-asset tests in `tests/extension-setup.test.js`. All 69 extension unit tests and popup e2e 2/2 pass.
- Truth corrections (from attack text via TCGdex): lot `279630564` "Shellder" is **Shelgon dp3-64**; the Sleepy Ball Squirtle is ex6-82; Loudred is ex5-39. Lot `279427892`: Palkia is dp4-26 (Great Encounters), Mew is pop4-4, `02/00` is Vibrava δ ex13-54; Unown is not in the catalog.
- Still wrong or open: Magneton gets a confident wrong set (ex16-16, truth ex11-48); Koffing is named Gible; Cyclone Energy is named Boost Energy; Fearow and Ivysaur flip between named and unnamed across runs (detector-box jitter). An unnamed card whose true card is not among the 20 look-alikes (Squirtle dp3-112, Shelgon dp3-64) is not rescued by its number.

## "Set not sure" picker + TCGdex prices — 2026-10-11 (earlier)

Step 1 of the user-approved plan: (1) set picker, (2) nudge toward neighbouring cards' sets, (3) read the card number on large single-card images.

- When close same-name matches span sets (`lib/set-choice.js`), the card is not priced. The popup shows "Set not sure" with a set dropdown. Picking a set sends `priceCard` to the service worker, which prices exactly that catalog card. The card stays out of the total until a set (and, if needed, a printing) is chosen.
- Prices come from TCGdex first (`getTcgdexCard` in `lib/pricing.js`, `fromTcgdexPayload` in `lib/condition-pricing.js`), because keyless pokemontcg.io timed out (lessons 21). TCG Pocket ids are filtered from hits (`physicalHits` in `lib/search.js`).
- Tests: `tests/condition-pricing.test.js` (5), `tests/search-physical.test.js` (2), `tests/set-choice.test.js` (6). All 39 extension unit tests and popup e2e 2/2 pass.
- Live, ShopGoodwill lot `279427892/00` (`node tests/e2e/live-scan.mjs data/detect-marketplace/goodwill/279427892/00.jpg`): 13 found, 9 named, ~7 s. Picking Power Keepers #64 for Snorunt shows Normal $0.46 / Reverse Holo $9.99 and asks for a printing. Vibrava δ is correctly Holon Phantoms #54. Seven cards still say "Set not sure"; this is what step 2 should reduce.
- Known wrong: Unown came back as **Unown V Silver Tempest** ($0.89, counted in the total). The real card is from Unseen Forces, which is not in the embedded index. Step 2 should cover this case.

## Card finder published as release v2.1 — 2026-10-11

With the user's approval, the local finder was published as its own release: [v2.1](https://github.com/fabcrowd/pokemon-auto-lister/releases/tag/v2.1), asset `card_detect.onnx` only, sha256 `5e17ae58b25843be1ee19f5dce4e0e5981a23411564a69eb633bb0694d582ac5`, 10,606,263 bytes. Downloaded back from GitHub, the length and hash match. v2.0 was left unchanged and is still marked Latest. v2.1 is not Latest, because it holds only one file. The tag points at remote `main` (`f0d0f83`). No code was pushed.

- `tools/extension-wasm/lib/setup.js`: each model file names its release. The finder comes from v2.1 and everything else from v2.0 (`assetUrl`). The finder download is checked against the sha256 above and is not stored if it differs. The cache name stays `cardscanner-models-v2.1`. Files are cached by URL, so someone with the v2.0 files sees **Download models** once and fetches only the ~10 MB finder.
- The bundled-finder workaround described below was removed. `build-wasm-extension.ps1` no longer copies a model, and `background.js` loads the finder from the cache like the other files. `dist/extension-wasm/models/` was deleted.
- `INSTALL.md` explains the one-time re-download after updating.
- Tests: `tests/extension-setup.test.js` (5): finder URL is v2.1, a cache with only the v2.0 finder is not ready, a wrong-hash finder is rejected and not stored, only the missing file is fetched, sha256 hex format.
- Live upgrade on `data/extension-live-profile` (v2.0 files already cached): the popup asked to download, fetched the finder, then scanned the ShopGoodwill lot: **15 found, 13 named**, ~8.5 s. Extension unit tests 24/24 and popup e2e 2/2 pass.

When the finder changes again, publish a new release (v2.2, …) and update `release`/`sha256` for that one entry in `ASSETS`. Do not overwrite an asset in place; cached copies would never refresh.

## Extension consumer pass — 2026-10-11

**Goal:** make `tools/extension-wasm` (manifest name "Pokémon Card Scanner") reliable enough for a non-developer: detect, name, and price the cards on a real page. Nothing was committed, pushed, or published. The local `card_detect.onnx` was **not** uploaded to GitHub release `fabcrowd/pokemon-auto-lister` v2.0. `PGAI_KEY` was not rotated.

The server/detector plan below (Phases 2 remainder, 3, 4, and the v4/v5 threshold sweep / v5 promotion) was paused for this and is still paused. Do not resume it unless the user leaves the extension. The "upload the new ONNX" note in the 2026-10-10 detector section is superseded: the extension build now bundles the local finder, and publishing it still requires an explicit ask.

### What was wrong

The extension downloaded `card_detect.onnx` from the v2.0 release into Cache API `cardscanner-models-v2.1`. That file is 10,606,263 bytes, sha256 prefix `930c9875e218f83a`. The finder that works on this machine is `tools/vellum-ai/models/card_detect.onnx`, same length, sha256 prefix `5e17ae58b25843be`. On the ShopGoodwill lot photo, Python on the local file scored class 0 at 0.932 (137 anchors above 0.5). The extension, running the release file, scored 0.0804 and returned 0 boxes. The portrait photo is card-shaped, so the page was then priced as one unknown card.

Rejected while chasing that: popup captured instead of the listing, blank canvas crop, RGB channel order, flips and 180° rotation, anchor-major output layout, JPEG recompress, ORT Web 1.17 vs 1.18 vs 1.21, and `ort.env.wasm.simd = false`. Input letterbox pixels matched Python. `simd = false` was reverted; it only slowed the scan. A `[detect] layout` console log used during the diagnosis was removed.

### What changed

- `scripts/build-wasm-extension.ps1` copies `tools/vellum-ai/models/card_detect.onnx` into `dist/extension-wasm/models/card_detect.onnx` when the local file exists. `dist/` stays gitignored.
- `tools/extension-wasm/background.js` `getDetectorBuffer()` fetches that bundled file first and logs `[BG] using bundled detector` plus the byte length. The release download remains the fallback. Detector load errors include the buffer length.
- `tools/extension-wasm/manifest.json` version is `2.0.1`.
- `tools/extension-wasm/INSTALL.md` tells the user to keep `models/card_detect.onnx` next to the extension. Without it, photos of several cards come back as one unknown card.
- `tools/extension-wasm/lib/fusion.js` adds a fourth accept rule: among the top 3 hits within 0.02 of the best score, if one name appears more often than the others, accept that name (`name_vote`). Hits past the top 3 do not vote. Tests in `tests/fusion.test.js`.
- `tools/extension-wasm/popup.js` shows the printing range once (on the printing menu, not again under it) and labels the source with `sourceName()` (`TCGPlayer` / `JustTCG` / `Price Tracker`).
- `tools/extension-wasm/popup.html` empty price dashes use `#8b92ab` so they are readable on the dark cells.
- Vendor stays onnxruntime-web **1.17.3** (`scripts/setup_vendor.ps1`, imported as `./vendor/ort.wasm.min.js`). Do not mix 1.18 or 1.21 files into `dist/extension-wasm/vendor/`.

Already in the tree from the same extension pass, before the model-hash fix:

- Several printings are not quoted and are left out of the lot total until the user picks one (`lib/card-display.js`, `tests/card-display.test.js`). Overlay and popup show `N printings · $low–$high` and a source/age footer. Stale means older than 7 days.
- Scan stays disabled until models are ready, and is enabled again in the same popup when the download finishes.
- `checkReady` reloads models from the Cache API after the service worker is killed, so the setup wizard does not return on every cold start. `loadModels` shares one in-flight promise.
- Card images that have not finished loading are counted as `pending`. The scan waits 800ms and asks again, or tells the user to scan again in a moment.
- Popup window is 500×680 and the body is `width: 100%`, so a 420px-wide window does not clip the status pill.
- Photo crops use `createImageBitmap(bitmap, sx, sy, sw, sh)`. Letterbox, rectify, and embed canvases use `willReadFrequently: true`.
- Class score prefers class 0, then the best other class, matching the Python relax path.
- `loadPhotoSource` still rejects non-HTTPS and private hosts, so a `127.0.0.1` test page uses the viewport crop.

### Evidence

Live scan: `node tests/e2e/live-scan.mjs`. Profile `data/extension-live-profile` (gitignored). Photo `data/detect-marketplace/goodwill/279630564/00.jpg` served locally, viewport 900×1200. The worker log showed `using bundled detector 10606263`, then YOLO **15 boxes**, scores 0.90–0.93, **13 named**. Message: `Found 15 cards (13 identified). Choose a printing on 13 before the total includes them.` About 10 seconds after models were already cached. The lot total stayed `—`.

Against the photo: Sunflora is named (name vote). PlusPower and the second Squirtle stay unknown. Shellder is called Shelgon because the top three catalog hits were all Shelgon. Sets are the closest visual match. OCR is still passed as `null` into `fuseResults`.

Also passed after the rebuild: `node --test tests/fusion.test.js tests/card-display.test.js` (10) and `npx playwright test tests/e2e/extension-wasm-popup.spec.js --project=extension` (2). Playwright loads `dist/extension-wasm`, not `tools/extension-wasm`. Rebuild before those tests. `extension-chrome.spec.js` and `extension-visual.spec.js` still target `dist/extension` (the older dev UI), not this package.

Reusable notes are in [`lessons.md`](lessons.md) lessons 16–20.

### How to reload the unpacked extension

Chrome's persistent profile keeps the old service worker. Delete `Default/Service Worker/ScriptCache`, `Extension Scripts`, and `Code Cache` under `data/extension-live-profile`, then launch. Do that in a **separate** command from the launch. Do not delete `CacheStorage` — that is the downloaded CLIP/catalog cache. The first launch after a wipe often reports the extension as not running; the next launch compiles the new worker. Confirm the new worker with `[BG] using bundled detector 10606263`.

### Left on purpose

- Shellder → Shelgon, and any set that is only a visual neighbor. Fixing that needs OCR or a better embedder. Do not publish a new ONNX to paper over it.
- Backend and PokemonPriceTracker grids still do not copy `updatedAt`. The pokemontcg.io grid does.
- `popup.js` `renderResults` still writes `innerHTML` and re-renders on every printing change, which drops focus.
- A dist folder built on a machine without `tools/vellum-ai/models/card_detect.onnx` still falls back to the weak v2.0 download.

## NEXT-AGENT PLAN — 2026-10-11 (paused; extension pass above is newer)

Execution began on 2026-10-11. Phase 0 items F1–F4 and F6 are implemented; F5 now uses real Base Set catalog images and its identification checks are running. The full Python suite is still in progress. Node tests pass (225/225). `npm run lint` still reports existing unused-variable and browser-global issues after generated files were excluded. No changes have been committed or pushed. Do not push (user said: not yet). Follow the session's TDD/review workflow, lint + tests green before each commit, one logical change per commit, and create `CHANGELOG.md` before any push.

### User decisions (final)
1. **Graded / per-condition source:** save ONE real JustTCG response as a test fixture first (1 quota call; quota may be exhausted, retry later), then use the best available source. `extractPriceGrid` in `src/pricing/justTcg.js` has only been tested on invented fixtures. Alternatives already in code/keys: PokeGrade `extractGradedComps` (psa8/9/10), PokemonPriceTracker. Pick on real data coverage.
2. **Variants: ask on every card** (holo / reverse holo / other). Most variants can be determined from the number at the bottom right of the card, so use the OCR'd number plus set first, and ask only for what remains ambiguous. Choice is per-session.
3. **Detector v5:** recommended promote, but only after the threshold sweep (item 4). Back up `tools/vellum-ai/models/card_detect.onnx` first. v5 weights: `tools/vellum-ai/models/card_detect_v5/weights/last.pt`; ONNX was at scratchpad `ckpt/v5e5` (may be gone; re-export from the .pt).
4. **Detector threshold:** sweep v4 and v5 over conf thresholds on `data/detect-real-eval/`, `data/detect-real-eval-stress/` and the HiBid test sets with `detect/eval_real.py --conf X`. Choose the best F1 that keeps 0 sealed-product false positives. Report the numbers before changing `_CONF_THRESHOLD` (`vellum_ai/detect_multi.py`) and `CONF_THRESH` (extension `lib/detect.js`).
5. **Do not push.** Do not publish the ONNX to the GitHub release (`fabcrowd/pokemon-auto-lister` v2.0) without asking.
6. **More real photos:** user OK with harvesting HiBid/Facebook listing photos (`scripts/harvest-hibid-photos.mjs`, `data/*-chrome-profile`). Keep all photos of one lot in one split; boxes must be reviewed (`"reviewed": true` sidecars). Real photos are the best lever for the detector. A human should spot-check the labels.

### Status at hand-off (2026-10-11, previous agent hit its usage limit; not committed)
Done in the working tree, uncommitted:
- F1 `package.json` test script restricted to `tests/*.test.js`; Node suite 225/225.
- F2/F3 dead queue imports and the obsolete listing-defaults smoke test removed.
- F4 eBay error message aligned.
- F6 wasm extension source (popup, options, manifest, icons, `lib/`) now tracked under `tools/extension-wasm/`; build script copies the whole tree; a Node test checks byte-for-byte parity with a temp build.
- F5 `detect/make_card_fixtures.py` now builds lots from real Base Set catalog scans; identification check compares returned set + number to each lot's known cards. Rounds 1-3 and 6-10 passed; **one earlier round failed the stricter known-ID check** and the aggregate test was still running. Investigate that round first (fixture vs real identification miss).
Not done: `npm run lint` still has unused-variable and browser-global errors (generated/browser debug files, `dist`, the Python venv were being traversed; excluded but residue remains); F7 commits; CHANGELOG.md; Phases 1-4.

Detector threshold sweep result (from the prior agent's run; not re-verified). "Found" = HiBid cards found on test / test2; FP = sealed-product false-positive images.
- v4 @ 0.55: 44/45, 100/112; 0/12 real negatives and 0/72 stress negatives flagged. Combined F1 0.967 over four sets (290 TP, 6 FP, 14 FN). Best qualifying setting.
- v4 @ 0.70: also 0 negative FPs but 42/45, 98/112; F1 0.963.
- v5 @ 0.75: 44/45, 105/112 but sealed products flagged in 2 stress images -> fails the zero-FP gate.
- v5 @ 0.85: negatives clean but 32/45, 76/112.
- v5 @ 0.55 (earlier measurement): 14 FPs on 3/72 stress images.
- Previous agent applied **0.55** to `vellum_ai/detect_multi.py` (`_CONF_THRESHOLD`) and the extension `lib/detect.js` (`CONF_THRESH`), kept **v4** shipped, did **not** promote v5. Note: v4 and v5 were compared at different thresholds and v5 rows at 0.60-0.70 were not reported; re-run if the choice matters.
- **Open user question:** how costly is a false box on sealed product? If it only yields abstain/needs-review, v5 @ ~0.75 (+5 cards) may be worth it; if it yields a bogus price, stay on v4 @ 0.55.

### Detector background (answers given to the user)
- v4/v5/v6 are the same stack: the YOLO11n detector fine-tuned on different data, exported to ONNX. v4 = shipped (binder/flat-lay/single synth + reviewed sealed negatives). v5 = v4 + tilted binders + 57 HiBid train photos (higher recall, more sealed-product FPs). v6 = v5-style with augmented negatives, rejected (recall dropped, FPs remained).
- Nothing in the repo benchmarks YOLO against alternatives; `detector-upgrade-handoff.md` is a plan. The earlier failure was bad data (138 full-frame mislabeled marketplace frames), not architecture. Stay on YOLO; improve data first.
- Optional upgrades listed in the plan, none built: YOLO11-OBB rotated boxes (relevant for tilted binders; needs `rectify.js`/`detect.js`/`content.js` polygon support), Grounding DINO server-side zero-shot fallback (`/api/zero-shot-detect`, ~440 MB, too big for the extension), DINOv3 behind a benchmark gate.
- Best next detector step: retrain from v5 with many more **real, reviewed sealed-product negatives** and tilted-binder photos from HiBid/Facebook (split by lot, reviewed sidecars), then gate with `retrain.py` (real-photo F1 >= 0.90 and no worse than current). Try OBB only if tilted binders are still missed.
- Priorities: detection is already 0.964 find on the fresh test2 set, so **pricing correctness (Phase 2) and the Phase 0/1 fixes matter more than further detector work**. Retraining is only the detector track; Phases 0-4 are not retraining.

### Stale claims in older docs (verified by a planning pass, re-check quickly)
- Much of root `todo.md` sections 0 and 3 is already built in `dist/extension-wasm/` (`lib/condition-pricing.js` returns variants/graded/defaultVariant/spreadRatio; `content.js` draws set+number badge and spread warning; `popup.js` has per-session variant choice and condition/grade filter chips). Missing: freshness flag, source footer, "N printings" chip with confirm link, edition-aware defaults.
- Most of the wasm extension is NOT in git (`dist/` is gitignored). Only `content.js`, `background.js`, `photo-detection.js` are tracked in `tools/extension-wasm/`. `lib/*.js`, `popup.*`, `options.*`, `manifest.json` exist only in `dist/`.
- "Re-embed 401 images" is done (22,485 embedded). But `data/card-catalog/phash.json` still has 21,669 entries, so ~816 cards get no pHash rerank.
- Node failures: `npm test` is bare `node --test` and picks up root `test-*.js` / `load-and-test.js` browser scripts. `tests/identity-status.test.js` and `tests/scan-api.test.js` import `src/queue/queue.js` (deleted in commit fff8965). `tests/smoke.test.js` reads deleted `config/listing-defaults.json`. `tests/ebay-solds.test.js` expects `/eBay auth failed/` but `src/ebay/auth.js` throws `eBay OAuth failed`.
- "Defaults to Unlimited" is accidental: key order in TCGdex `PRINT_PREFERENCE`; JustTCG `extractNearMintUsd` ranks unknown printings at 99; `decidePrice` can median a 1st Edition and an Unlimited comp together.
- `CLAUDE.md` / `HANDOFF.md` still describe listing/inbox/sniper/queue modes removed in fff8965.
- No `CHANGELOG.md` exists. Working tree has lots of uncommitted work and `main` is 5 commits ahead of origin.

### Phase 0 — green, committable baseline
- F1 `package.json` test script: run only `tests/` (use a glob, `node --test tests/*.test.js`; `node --test tests/` did not work as a dir argument on this Windows shell, verify).
- F2 Remove the dead queue imports/usages from `tests/scan-api.test.js` and `tests/identity-status.test.js` (keep the /api/scan coverage).
- F3 Delete or rewrite the obsolete listing-defaults smoke test in `tests/smoke.test.js`.
- F4 Align eBay error message (`src/ebay/auth.js` vs the test regex).
- F5 Python `tests/test_stress_detect.py`: 10 failures from `hibid_card_lot_*` placeholder fixtures (blank art). Rebuild fixtures from real catalog art for known ids (`detect/make_card_fixtures.py`) or `skipUnless` data exists. The test must prove identification, not OCR.
- F6 Move wasm extension `lib/`, `popup.*`, `options.*`, `manifest.json` into `tools/extension-wasm/`; extend `scripts/build-wasm-extension.ps1`; add a test that tracked source equals dist output.
- F7 Commit the existing uncommitted HiBid/TCGdex work in logical commits; create `CHANGELOG.md`.
Verify: `npm test` 0 failures, `npm run lint`, `npm run test:vellum`.

### Phase 1 — reviewer bugs (Python, `tools/vellum-ai/vellum_ai/`)
- B1 `slab_label.py` `resolve_label` returns a made-up `label:{code}-{n}` for any parsed set code when nothing matches, and `identify_multi.py` (~lines 346-349) lets it override a verified match. Fix: emit `label:` only for known Classic codes (`LABEL_SET_NAMES`), else `None`; a `label:`/`outOfCatalog` slab must never override a non-abstained verified identity (only add grading fields). Tests: unknown code + year mismatch -> None; verified identity survives with grading attached; CLV still yields a label id.
- B2 `pipeline.py` cuts name candidates with `named[:_MAX_NAME_PRINTS]` (80) in name/catalog order. Rank before the cut: OCR'd-number match first, then CLIP similarity from `deep_hits`, then catalog order. Test: 120-print fixture with the true print at position 100.
- B3 `_catalog_set_years` is `@lru_cache` and caches `{}` when `set_years.json` is missing. Only memoize a successful load. Test: missing -> `{}`, write file, next call returns years.
- Verify: `python scripts/eval_lots.py` style eval on test2 must stay at >= 81/84 find and price.

### Phase 2 — variant correctness (decision 2)
- A1 Each pricing client (`src/pricing/tcgdex.js`, `justTcg.js`, `pokemonTcgApi.js`) returns its `printing` plus a full `variants` map. `scanAndPrice` takes an optional chosen `printing` and passes only same-printing comps to `decidePrice`. Keep median, `MIN_COMP_SOURCES=2`, 15% rule. Test: 1st Ed and Unlimited comps are never medianed together.
- A2 Ask on every card: return `variants` from `/api/scan`; a card with more than one priced printing is `needs_review` with reason `printing ambiguous` until the user confirms. Use set + OCR'd number to resolve what can be resolved without asking.
- A3 Extension overlay: "N printings" chip with confirm link to the popup row, freshness flag (>7 days stale), "source · updated Nd ago" footer. Files: `content.js`, `popup.js`, `condition-pricing.js` (after F6). Verify with `tests/e2e/extension-visual.spec.js` plus a manual Base Set Charizard check.
- A4 Shadowless: user-picked printing only; no source separates it reliably.
- Then root `todo.md` sections 1-2 (condition grid, graded) using the source chosen in decision 1.

### Phase 3 — identification gaps
- Generations vs BREAKthrough Gengar: red test with the real crop; try extending `_split_reprints` / set-context.
- Crystal Guardians stamped reverse holo abstains: try a lower inlier threshold for set-context verify only.
- GG08 / TG06 priced from Cardmarket only: mark `needs_review` when the only comp is `cardmarket-eur`.
- Rebuild `phash.json` to 22,485 entries.

### Phase 4 — older tasks and cleanup
- `tasks/todo.md` multi-card stages 3-5 (2x2, 3x2, 30° tilt): marked deferred in `loop_stages.json`; run on the current pipeline first, binder work may already cover them.
- Browser-verify the dual thumbnail on the live dashboard (`:3000`).
- Update `CLAUDE.md` and `HANDOFF.md` to drop listing/inbox/queue references.

### Detector track (parallel, needs decisions 3-6)
Threshold sweep is done (see "Status at hand-off"). Remaining: get the user's answer on false-box cost -> promote v5 only if it wins (back up `models/card_detect.onnx` first) -> more reviewed real photos and sealed negatives -> retrain -> `retrain.py` gate (real-photo F1 >= 0.90 and no worse than current). Publishing the ONNX is outward-facing: ask first.

### Suggested order for the next agent
1. Finish Phase 0: diagnose the one failing stress round, fix lint, run `npm test` + `npm run test:vellum`, then F7 commits and `CHANGELOG.md` (no push).
2. Phase 1 (B1-B3), test first.
3. Phase 2 (A1-A3), then save a real JustTCG response fixture and do graded/condition pricing.
4. Phase 3, Phase 4.
5. Detector track whenever the user answers the open question or provides more photos.

### Known risks
- Phase 0 F5 changes what the stress test means; keep it identification-based.
- JustTCG daily quota (100/day) may be exhausted; TCGdex (no key) is the fallback for pricing work.
- Reviewer-agent rules in global CLAUDE.md: run `typescript-reviewer`/`python-reviewer`, `silent-failure-hunter`, `pr-test-analyzer` and `code-reviewer` before claiming done.

## HiBid multi-card lots: find + price — 2026-10-11

**Goal (user):** on multiple HiBid multi-card lots, find the correct card and price it above 95%.
Metrics: *find* = detected (IoU >= 0.5) and the exact catalog id; *price* = find and JustTCG returned that same product (set + number). `null` ids (exact print not determinable) count for detection only.

| Set | Find | Price | Notes |
|---|---|---|---|
| **test2** — fresh blind set, 18 lots, 130 boxes / 84 ids, harvested after all tuning | **0.964 (81/84)** | **0.964 (81/84)** | every correctly found card priced as that exact product (TCGdex) |
| test — 31 lots / 65 ids | 0.723 | 0.723 | misses were inspected and fixed against: partly tuned on |
| dev — 18 photos / 54 ids | 0.981 | 0.981 | tuned on; not an accuracy claim |

**Pricing without JustTCG (added while its 100/day quota was exhausted).**
- **Source:** `src/pricing/tcgdex.js` prices the *exact catalog id* from TCGdex: no key, no daily quota, prices refreshed daily.
- **Basis:** TCGplayer USD market price, by printing preference (holofoil > normal > reverse).
- **Fallback:** when TCGdex has no TCGplayer row (Trainer Gallery, Galarian Gallery, Radiant Collection, many promos), it uses the Cardmarket base trend × the ECB EUR→USD rate from `api.frankfurter.dev`. The result is marked `basis: 'cardmarket-eur'`.
  - Spot check: Meowstic XY48 is $7.88 via Cardmarket and $8.27 via TCGplayer on pokemontcg.io.
- **Cardmarket is a last resort.** It priced 14 of the test2 cards. On the 12 that also have a TCGplayer price (pokemontcg.io), only 4 are within 15% and 8 within 30%; Dragonite SIT 131 is $15.45 vs $1.34. So `scanAndPrice` drops a `cardmarket-eur` TCGdex comp whenever a US-based comp exists (`justtcg`, `tcgplayer`, `pokemontcgapi`). Effect on test2: 79/81 priced cards rest on TCGplayer data, and 2 (GG08, TG06) are Cardmarket-only with no reference.
- Raw pokemontcg.io Cardmarket EUR no longer enters the USD comps median (`cardmarket` comp is now null; it was EUR mixed into USD).
- **Review fixes (fresh-context reviewer):**
  - TCGdex also checks set and number when the identity states them.
  - pokemontcg.io no longer falls back to a name search when the exact catalog id misses.
  - The FX rate keeps the last good value and backs off for 10 minutes.
  - The price grid returns "no data" rather than a 5xx when JustTCG errors and TCGdex has nothing.
- **Agreement with JustTCG** on the 57 ids both priced: median difference 0%, 52/57 within 15%.
  - The outliers are vintage 1st Edition vs Unlimited. JustTCG picked 1st Edition, TCGdex picks Unlimited.
  - The pipeline cannot see the 1st Edition stamp yet, so Unlimited is the safer default. The grid shows both.
- **Server wiring:**
  - TCGdex is a new comp in `scanAndPrice`/`decidePrice` (`tcgdex`). TCGdex + pokemontcg.io make 2 keyless sources, enough for auto pricing.
  - `/api/price-grid` = `chainPriceGrids(justTcg, tcgdex)`. Verified on a live server with JustTCG returning 429: the grid came from TCGdex.
- **pokemontcg.io:**
  - `pokemonTcgApi.js` now looks up the exact card from the catalog id (`sv03.5-071` → `sv3pt5-71`) with a name check, and retries 5xx.
  - Its keyless tier was returning 500/502s most of the time on 2026-10-11, so it is only a secondary comp.
- **Scoring:**
  - `scripts/price-eval-ids.mjs --source=tcgdex|pokemontcg|justtcg` writes `prices-<source>.json`.
  - To rescore saved reports offline, see `scratchpad/rescore.py`, or pass the price file to `eval_lots.py --prices`.

The JustTCG retry loop may still be running. JustTCG remains the only source with per-condition and graded prices.

**What changed**
- **Identification** (`tools/vellum-ai/vellum_ai/`):
  - SIFT verification second pass over CLIP ranks 21-40.
  - Name-OCR candidates (`name_candidates.py`).
  - Same-art reprints split by OCR'd number.
  - Slab labels (`slab_label.py`, `catalog/set_years.py`).
  - Upright crop for tilted cards (`detect_multi._upright_crop`).
  - Set context (`identify_multi._apply_set_context`): re-verifies abstained cards against the photo's dominant set, and moves a same-art reprint to the page's set only when it verifies about as well against that print (>= 80% of the inliers).
- **Pricing** (`src/pricing/justTcg.js`):
  - Strict name + number + set match.
  - The set id is resolved from one `/sets` call.
  - Exact set-name equality after normalisation: series codes, EX / XY - / SM - prefixes, & vs and, Base Set suffix.
  - Aliases (`justTcgSetName`): Black Star Promos, SM Base Set, 151, Radiant Collection.
  - 155/158 catalog sets map to a JustTCG set.
  - `scripts/price-eval-ids.mjs` caches each priced id. Neither HTTP errors nor network errors are cached.
- **Catalog:** 415 more cards' art backfilled (pokemontcg.io set-id mapping); index re-embedded (22,485).

**Detector:** not changed. The shipped model is still v4.
- **v5** (`tools/vellum-ai/models/card_detect_v5/weights/last.pt`; ONNX at scratchpad `ckpt/v5e5`), fine-tuned with tilted binders + 57 HiBid train photos:
  - HiBid test recall at conf 0.55 is 0.975 (v4: 0.85). On test2 it detects all 130 cards with 3 FPs (v4: 126 with 9).
  - On the stress negatives it has 14 FPs on 3/72 images (v4: 5 FPs, 0 images), so it fails the stress gate.
  - Your call: promote it (back up `models/card_detect.onnx` first) if missed cards in angled binders cost more than boxes on sealed product.
- **v6** (augmented negatives) was rejected: recall dropped and the FPs remained.

**Known gaps**
- Identical-art reprints with unreadable numbers (Ultra Ball BRS/CRZ, Morpeko V SSH/SHF, vintage Base/Base 2/LC) — labelled null.
- Generations vs BREAKthrough Gengar picked wrong.
- Crystal Guardians stamped reverse holo abstains.
- Japanese cards are not in the catalog.
- Reviewer notes not yet addressed:
  - A slab label whose year filter empties the catalog match returns a made-up `label:` id that overrides a verified match. It is needed today for Trading Card Game Classic slabs.
  - The name-candidate list is cut at 80 prints in catalog order.
  - A missing `set_years.json` is cached for the process lifetime.

**Tests:** Python 197 (10 failures, the known `test_stress_detect` placeholder fixtures). Node 179/188 (same 9 failures as before).
Nothing is committed. The new ONNX is not published.

## Detector retrained for listing photos — 2026-10-10 (evening)

**Result.** The shipped detector (`tools/vellum-ai/models/card_detect.onnx`) now finds every card in reviewed real listing photos. It was promoted through a new real-photo gate. Scores use the shipped Python path at the current threshold (`_CONF_THRESHOLD = 0.25`):

| Set | Old model | New model |
|---|---|---|
| Real held-out (`data/detect-real-eval/`, 17 images, 21 cards, 12 sealed negatives) | P 0.17 / R 0.14 | **P 0.91 / R 1.00**, 0/12 negatives with an FP |
| Stress copies (`data/detect-real-eval-stress/`: half, quarter, jpeg30, dark, flip, rot90) | P 0.14 / R 0.13 | **P 0.92 / R 1.00**, 1/72 negatives with an FP |
| Same sets at conf 0.55 (the F1 optimum on synthetic val; not tuned on test) | — | P 0.96–1.00 / R 0.99–1.00, 0 negative FPs |

The WASM extension's letterbox preprocessing scores equal or higher (`eval_real.py --preprocess letterbox`). The 2 remaining FPs at 0.25 are thin slivers on photo edges.

**Root cause.** 138 marketplace frames in `data/vellum-detect/images/train` were labelled as one full-frame box. The model learned that a listing photo is one card, while synthetic val still read mAP50 0.995. Those labels are now in `data/vellum-detect/_quarantine_fullframe_labels/`.

**What changed**
- `detect/eval_real.py` (+ tests): P/R/F1 and negative-image FPs on reviewed real photos. Runs the shipped `detect_multi` path. Supports `--preprocess letterbox` and `--conf`.
- `detect/synth_binder.py` (+ tests): binder pages, toploaders, flat-lays and single large cards from catalog art, with glare, tilt, 90° rotation and thumbnails. 700 train / 150 val written into `data/vellum-detect`.
- Reviewed sealed-product negatives from 25 training lots (plus rot90 copies) were imported through `label_marketplace.py` → `retrain._ingest_frames_to_dataset`. 12 other lots are held out for test (lot id % 3 == 0).
- `detect/retrain.py`: promotion also requires real-photo F1 ≥ 0.90 and no worse than the current model (`_passes_real_gate`, tested).
- Training: fine-tuned from the old weights, CPU only, ~8 min/epoch. Final = run `models/card_detect_v4` epoch 6 (`last.pt`). That epoch was fixed before scoring; `best.pt` (epoch 5) scored worse on stress. The previous model is kept at `models/card_detect_archive_pre_binder.onnx`.

**Caveats (read before relying on this)**
- The real test set is small: 5 positive photos (2 binder pages, 3 single metal novelty cards) and 12 sealed lots. The stress copies are transforms of the same photos, not new scenes. Treat ≥0.90 as verified **on this set**, not in general.
- Labels were reviewed by Claude by drawing overlays (`review_note` in each sidecar), not by a human. Please spot-check `data/detect-real-eval/positive/*.json`.
- `data/` is gitignored, so the eval set, synthetic data and model are local only.
- The extension downloads `card_detect.onnx` from the GitHub release `fabcrowd/pokemon-auto-lister` v2.0 (`lib/setup.js`). Upload the new ONNX there for the extension to use it. Not done: it is outward-facing.

**Pre-existing failures (unchanged by this work)**
- VellumAI: 11 `test_stress_detect` identify tests fail on the `hibid_card_lot_*` placeholder fixtures (blank art; 2/40 identified, identical before and after).
- Node `npm test`: 166/175. Failures: missing `config/listing-defaults.json`, `identity-status`/`scan-api` tests, and the ad-hoc root `test-*.js` / `load-and-test.js` browser scripts that `node --test` picks up.

**Next**
1. Collect more real listing photos (binders, single cards, slabs, piles) and review labels, so the test set means more.
2. Consider `_CONF_THRESHOLD` 0.55 in `vellum_ai/detect_multi.py` and `CONF_THRESH` in the extension's `lib/detect.js`. Val and test both favour it.
3. Publish the new ONNX to the extension release.

## Marketplace photo detection — 2026-10-10

### Implemented

- `tools/extension-wasm/content.js` now includes source URLs plus CSS rendering details for large `<img>` and background-image candidates.
- `tools/extension-wasm/background.js` attempts to read a public HTTPS source image (bounded by response size and dimensions), detects in its original pixels, and maps boxes through `object-fit` or supported background sizing/positioning into viewport coordinates. If source access or geometry mapping fails, it uses the existing visible-tab screenshot crop. Source URLs are not used for non-HTTPS or private/local hosts.
- `tools/extension-wasm/photo-detection.js` contains the coordinate transforms and retains the existing geometry/area rejection that prevents near-full-image boxes from being treated as individual cards.
- `tools/vellum-ai/detect/label_marketplace.py` and `retrain.py` now require `reviewed: true` sidecars. Empty reviewed box lists are retained as negative images. This stops unreviewed detector output from becoming training truth.
- `scripts/build-wasm-extension.ps1` syncs the tracked extension source into the ignored `dist/extension-wasm/` output.

### Evidence and limitations

- The actual saved HiBid binder photo (`.tmp/hibid-binder-hero.jpg`, 540×720) still produces one detector box `[1, 0, 541, 720]` at confidence 0.932 instead of nine card boxes. The geometry filter rejects it, avoiding bogus card IDs, but **the cards are not detected**.
- The local marketplace image set contains 138 photos; `python detect/label_marketplace.py --dry-run` found zero reviewed sidecars. The base validation split is synthetic, so its score cannot certify performance on casual listing photos. No model was trained or promoted in this change.
- A live HiBid app run could not be performed: the Playwright browser bridge reported an extension connection timeout and no connected browser surface was available. Local page-candidate E2E tests ran successfully.

### Verification

- `node --test tests/photo-detection.test.js` — 8 passed.
- `npx playwright test tests/e2e/screen-card-detection.spec.js` — 5 passed.
- `.venv312\Scripts\python.exe -m unittest tests.test_reviewed_marketplace_labels -v` from `tools/vellum-ai/` — 2 passed.
- `node --check` passed for the three modified extension source files; extension build completed.
- Commit: `eb040fa fix(detection): preserve marketplace photo geometry`.

### Next work

1. Add reviewed boxes for real HiBid photos, including binder pages, single loose cards, difficult lighting/angles, and sealed-product negatives. Sidecar format and import command are in the [README](README.md).
2. Split by lot, not by individual image, and create a held-out photo validation set with negatives. Evaluate both missed cards and false card detections before promoting a model.
3. Re-test slicing only after that photo-trained model exists; current experiments showed the shipped model can classify an entire tile as a card.

See [`tasks/lessons.md`](tasks/lessons.md) for reusable data, capture, and evaluation lessons. The earlier detector-upgrade plan remains a proposal and is not a report of completed phases.

## Catalog embeddings (done)

- Python **3.12** venv: `tools/vellum-ai/.venv312` (torch 2.14 CPU + open-clip + faiss-cpu)
- Ran `catalog/embed_all.py` → **21,669** vectors
- Artifacts in `data/card-catalog/`:
  - `embeddings.faiss` (~42 MB)
  - `embeddings.npy` (21669 × 512)
  - `meta.json` (aligned to embedded cards only)
  - `meta.full.json` (full TCGdex metadata backup, 23,548 rows)
  - `images/` (**22,070** webp after backfill; **401** recovered, **1,478** still missing — mostly Pocket/unpublished)
  - `phash.json` (**21,669** entries, aligned to embedded meta)
  - `coverage-report.json` (backfill summary)

## Vellum-first Scanner (done)

- `.env`: `VELLUM_AI_ENABLED=true`, `SCANNER_IDENTITY_MODE=local-only`, `IDENTITY_MODE=dual` (listing/inbox still dual)
- `src/index.js` uses a separate `scannerIdentityResolver` for `POST /api/scan` only
- Start identify: `npm run vellum-ai` (prefers `.venv312`) or `tools/vellum-ai/.venv312/Scripts/python identify_server.py`
- Start dashboard: `npm start` → http://127.0.0.1:3000
- **PGAI_KEY left as-is** (do not rotate unless asked)

## UI Scanner

- `POST /api/scan` + dashboard Scanner panel
- Local path uses Vellum + catalog above; PokeGrade still used for listing dual / sniper photos

## Not done yet

- Re-embed the **401** newly recovered images into FAISS (the 2026-09-06 review says they were on disk only; recheck current catalog state)
- Sniper photo ID was recorded as PokeGrade-only; recheck before changing it
- Multi-card identity loop: stages 3–5 were still pending in `tasks/todo.md` (2×2 grid, 3×2 grid, and 30° tilt); stage 6 was optional/decision-gated
- Photo ID port: browser verification of the dual thumbnail was still pending in `tasks/todo.md`

See [`tasks/todo.md`](tasks/todo.md) for task-level history. The pHash sidecar was completed after the earlier photo-ID review; do not use its earlier “pHash no-ops” note as current status.
