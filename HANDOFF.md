# Handoff

Last updated: 2026-10-18 (evening). Workspace: `C:\Users\daroo\Desktop\Repos\cardscanner\pokemon-auto-lister`. A new session can continue from this file alone. The previous handoff is in git history (`git log -- HANDOFF.md`).

State: `main` includes the extension accuracy pass below (branch `fix/extension-only`, merged 2026-10-18; the commit list is in "Extension accuracy pass"). Before it, `feat/card-picker-sealed-test` and `main` were both at `b6c6749`. Nothing is uncommitted except the untracked detector candidates `tools/vellum-ai/models/card_detect_v7/` and `card_detect_v7b/` (parked; do not commit weights). `dist/extension-wasm-store.zip` was last rebuilt before the accuracy pass: rebuild it from `main` before any store upload.

## Done 2026-10-17/18

Commits since `9c1cb1e` (details in `CHANGELOG.md`):

| Commit | What | Key number |
|---|---|---|
| 4c5e4eb | Popup simplified (one price per card, est. value in the action bar, chips in Settings); shape window widened to 1.82 so tilted/sideways cards keep boxes | 67 HiBid lots: +9 found, +6 right names, wrong 13 to 14 |
| a8f9246 | Tilted-card detector retrain parked (v7b), reason in `tasks/lessons.md` | 7 confident wrong names for 1 right (14 to 21 wrong) |
| 2e72d3d | Store contact email; name and icon approved | n/a |
| 1536670 | Page set hint: set named in heading, breadcrumb or title is the best guess | Pokellector Base Set grid: Base Set rows 10 to 33 |
| 654a132 | Overlay labels clamped to card width; price-only under 140 px | n/a |
| c2790bb | Era search: only the chosen era's cards; store build drops `variant.onnx` | Era 1999-2003: 3 to 47 identified, no out-of-era suggestions |
| c118fe5 | Overlay frames and prices stay on cards while scrolling and after resize | n/a |
| 9a4b98f | Rescan hides the overlay before capture | Grid identified 47 then 13 before, 47 and 47 now |
| d4f8c12 | Whole-page scan: up to 12 screens, 200 cards, dedupe, scroll restored | Base Set 102 found, 97-98 identified, ~48 s; S&V 151 and Paldea Evolved hit the cap, 191-193 identified, ~3 min |
| 5d321a2, 69c592c, b6c6749 | Docs-only: changelog and handoff records | n/a |

## Extension accuracy pass (2026-10-18, branch `fix/extension-only`, written on a Linux box)

Why: whole-page scans of grid pages (Pokellector Base Set, 102 tiles) showed duplicate rows, 56-77 of 102 identified, and many "Unknown" rows. The full diagnosis and plan are in `docs/improvement-plan.md`. Only `tools/extension-wasm` and its tests changed; the manifest, permissions, thresholds in `lib/fusion.js` and the store build lists are untouched.

Commits, in order:

| Commit | What |
|---|---|
| 4ba6689 | Lint cleanup in `tools/extension-wasm`: unused vars, params and an empty catch removed, no behavior change (repo lint 47 -> 41 problems; `tools/extension-wasm` is clean) |
| a1a93e6 | Whole-page scan keeps one card per page element (by DOM identity) when the page shifts between screens. Live ads move the layout, so the same tile used to be counted as a new card: 102-120 rows became 102 |
| bf83b31 | Each grid tile is read once. A tile is two DOM candidates (the `<img>` and its slot); both were read, doubling the work (82 s -> 51 s on the fixture) |
| 2ffb802 | Always a best guess: a grid tile the gate would call Unknown is shown as its best guess (floor 0.60 catalog similarity), marked unsure, pre-selected in the "Which card is this?" pick-list with the closest cards after it. Accept thresholds unchanged |
| da083e2 | Soft multi-set page prior (`lib/set-prior.js`): +0.03 cosine bonus, scaled by each set's share of the page's settled cards, re-orders only the unsure guesses. A boost, not a filter, so pages mixing sets work |
| 7f99f35 | Source-image refinement (`lib/refine.js`, `refineFromSource` in `background.js`): an unsure grid tile is re-read from the page's own picture, fetched by the service worker with the host access the extension already has. At most 40 tiles and 30 s per scan; stops after 3 failed fetches or when site access is missing; picture must be card-shaped and at least 1.15x the crop's pixels; failures leave the tile as it was. Only https public hosts (existing `publicHttpsUrl` rules) |

Measured (1100x700, DPR1, Xvfb Chromium, shipped models; ground truth is the page's own tile titles; "sure" = named without the pick-list, "guess" = named and asked):

| Page | Before (main d4f8c12 code) | After the whole pass |
|---|---|---|
| Local Base Set fixture, 102 tiles | 82 s, 77 identified (right/wrong not scored), 25 Unknown; after the two dedupe commits 51 s then 32 s, 77 named (65 right, 12 wrong) | 77 sure (65 right, 12 wrong) + 25 guesses (13 right, rest wrong but flagged unsure), 0 Unknown, 35-45 s. The fixture is http, so refinement cannot run there |
| Mixed 3-set fixture (Base, Jungle, Fossil), 90 tiles | n/a | 65 sure (57/8) + 25 guesses (14 right; 10 without the prior), 30-39 s |
| Live pokellector, 102 tiles | 102-114 rows, 56-66 identified, 215-230 s (7 scans); after the dedupe fixes 73 and 68 identified (64/9 and 58/10 right/wrong), 35-40 s | Named right (sure + guess) 88-94 of 102 with refinement vs 73-78 with it off, in the same page layout; wrong shown (sure + guess) 24-31 -> 8-15; 37-40 tiles refined per scan, 0 fetch failures, +6-16 s |

Honest caveats:
- **The old "97-98 of 102 identified" (CHANGELOG 2026-10-18, d4f8c12) did not reproduce here.** On this box the same code identified 56-77 of 102 (68-77 after the dedupe fixes), the same at DPR1 and DPR2. The tile is a 140x196 thumbnail shown at about 95x130 CSS px, so the matcher reads about 130 px cards, where the gate declines roughly 25 of 102. The 97-98 figure probably came from the owner's real Chrome (HiDPI Windows, different capture); this was not tested. "Identified" counts wrong names too, so use the right/wrong columns above.
- Live pokellector alternates between two layouts on this box: the DOM finder returns 24 images (page focus "grid") or 12 ("unknown, no main photo"), independent of the build (the same build gave both within minutes). Live numbers swing by several rows run to run (sure-wrong 6-13) for that reason, so compare only within one layout. The fixtures are deterministic.
- Sure-wrong names (first-pass accepts) are unchanged by the accuracy pass: 12 on the fixture, 8 on the mixed page, 9-10 live. Newly shown guesses are flagged unsure, and most wrong guesses are now right after refinement. Offline on the 101 real tiles, the 18 tiles the crop could not settle all came out right from the source picture (0 wrong); the source picture alone names 99 of 101 right.
- Refined reads often stay in the pick-list because the printing is open (Base Set vs Base Set 2 vs Legendary Collection share art), so the user still confirms the set.
- Tests: 3/3 Base Set cards and 22/22 on the 22-card page after every step; no popup, page or service-worker console errors on the unpacked dev build. Unit tests: 1090 pass, 5 fail on the Linux box (Collectr CSV and TCGdex price tests, which need the gitignored Collectr export and network; unrelated). `tests/store-build.test.js` is Windows-only and was skipped (8 of 8), so it must be run on the owner's PC.

Reverted experiment: multi-crop averaging (plan item c). Averaging 5 shifted crops looked good offline on the 101 real tiles (accepted-right 73 -> 83, accepted-wrong 10 -> 3 when applied to every tile). As the extension would use it, re-reading only unsettled tiles and accepting the re-read only when it names the card the single crop already ranked first (offline +4 right, 0 wrong), the browser run gave more confident wrong names (fixture 12 -> 15, mixed 8 -> 9, live 9 -> 11-13) with no more right names shown (78 -> 78, 71 -> 71, 78 -> 76/72) and 5x embeddings on unsettled tiles. Reverted per the "no more wrong names" rule. Lesson: offline tiles are not the browser's tiles; the gain did not transfer. Not in git; to retry, shift the 224 px art crop by (0, +-0.05, +0.10) of its side and average the normalised embeddings (about 1 s per unsettled tile).

Self-improvement loop (checked read-only against the public `fabcrowd/card-scanner-data`): live but has learned almost nothing. Releases `pack-20261017-1` and `pack-20261018-2` are published; the `status` release shows 1 contributor (0 earlier), 0 promoted rows, exam n=0, and the HiBid regression top-1 0.3645 -> 0.5074 from the seed adapter. `community-pack.bin` is 46 bytes (empty). `adapter.bin` (32,829 bytes) is seed-trained (synthetic photo-like variants + owner crops), identical in both releases. A row is promoted only when 2 or more installs on 2 or more server days agree, or the id is in the crop's catalog top-20 (at most 10% of rows per install, 5 per card). The nightly gate scores HiBid listing crops, not grid tiles, so an adapter that fixes tiles could register as no gain; seed augmentation has no downscale-upscale step. Details: `docs/improvement-plan.md` sections 2 and 4.3.

## Next

1. Whole-page scan speed: about 3 min for 200 cards and the popup must stay open. Consider running the scan without the popup, or pushing the overlay from the background worker. See `tasks/todo.md`.
2. Check the 108-vs-102 discrepancy: a first Base Set scan found 108 cards and the back-to-back one found 102 (lazy images?).
3. Open items from the accuracy pass: see the list under "Owner to-do (extension accuracy pass)".
4. Recognising heavily tilted cards. Detector retrain is parked (`card_detect_v7b`, not shipped); see `tasks/lessons.md` (a wide box is a tilted card; gate detectors on right/wrong names in the Chrome lot harness, not box counts).

## Owner to-do

- Revoke the Cloudflare setup token and the GitHub fine-grained token pasted into chat on 2026-10-17. They are not in the repo; never copy them into a commit or this file.
- Create a Chrome Web Store developer account (chrome.google.com/webstore/devconsole, $5, fabcrowd@gmail.com) and upload `dist/extension-wasm-store.zip` with the listing from `docs/store/listing.md` and the privacy policy URL https://github.com/fabcrowd/pokemon-auto-lister/blob/main/docs/store/privacy-policy.md. Name and icon are approved; contact email is set.

## Owner to-do (extension accuracy pass)

Needs the owner's PC, keys or real Chrome; none of it could be done on the Linux box:
- Run `npm test` and `npm run lint` on Windows, including the 8 Windows-only tests in `tests/store-build.test.js`, then rebuild the dev and store packages. Nothing in this pass touched the manifest, but the store test is the gate.
- Real Chrome run: scan Pokellector Base Set and the 22-card page on the owner's display (HiDPI) and compare with the 97-98 figure; record DPR and Chrome version.
- Store build: source-image refinement uses the `<all_urls>` host access, which is optional in the store build. Check the permission prompt wording and that refinement only runs after the user grants site access (without it the tile stays as the crop read it). Update the privacy text if reading page pictures needs a line.
- Test refinement on other grid sites (only Pokellector was tried; the `.thumb.png` pictures there are 140x196, the page also has 570x795 originals).
- `data/hub-penalty.bin` is missing from this checkout (the service worker logs "hub penalty not available"); it is built from owner-only data with `scripts/build-hub-penalty.py`. Confirm the store build ships it.
- Adapter retraining with small-tile augmentation (downscale-upscale to about 100-140 px, `pipeline/augment.py` in `card-scanner-data`) plus a `tiles` slice in the nightly regression set, so a tile gain can register. Needs the catalog art and labeled crops.
- GPU work (plan Phase 8): backbone bake-off (DINOv3 vs MobileCLIP2), fine-tuning, detector retrain. Parked; the cheap wins above came first.
- Community loop: real contributors (opt-in is off by default and the store listing is not submitted), the trusted-corrector rule for the owner's own corrections.

Decisions for the owner (full wording in `docs/improvement-plan.md` section 11):
1. Keep "always show a best guess" on grid tiles at the 0.60 similarity floor (the default as built), or raise it.
2. Keep reading source pictures on grid pages with the current budget (40 fetches, 30 s, 4 s each, https public hosts only) and accept the optional-permission hint; allow generic thumbnail-to-original URL rewrites in `lib/full-size.js`, or only same-`src` fetches (as built).
3. Soft set prior strength (0.03; the plateau was 0.03-0.08) and whether the page's own plaque text should also count as a prior (default yes, as a prior only).
4. Adapter retraining: add the `tiles` regression slice and relax "improved" to "no worse on HiBid and not worse on tiles"? Run it on this box or the owner's PC?
5. When to switch opt-in on and submit to the store so real users contribute.
6. Is `hub-penalty.bin` in the store build? If not, build it and add it.
7. Appetite for GPU work and the app size budget (about 38 MB model plus 45 MB catalog today).

## Owner decisions this session

- Measure without manual labeling: the sealed test is dormant and the owner will not label. Do not propose labeling chores.
- Simplicity first: scan a page, see the cards and market price, always a best guess; corrections train.
- The scanner is for all Pokémon cards; Base Set is just the hardest reprint case.
- Opus plans, Sonnet subagents edit (every code and file change, even one-liners).

## Testing notes

- Debug harness: `.tmp/debug-store/` (Playwright Chromium; real Chrome 155 refuses `--load-extension`). Reused profiles need `Service Worker/ScriptCache` and `Database` deleted.
- Toolbar click: CDP `Extensions.triggerAction` with `--enable-unsafe-extension-debugging`. The site-access prompt is accepted via Windows UI Automation (`accept.ps1`).
- HiBid lot harness: `.tmp/lots/run.mjs` (env `EXT`, `JOBS`, `OUT`) and `.tmp/lots/analyze2.py <results.json> [jobs.json]`. Latest baseline `.tmp/lots/whole.json`. `.tmp/` is gitignored.

## Reference: lot value and set confirmation (2026-10-17)


Why: on the 67 HiBid lots, 71% of found cards had the right name but about half left the set open, so lot ranges were wide. The owner wants a best guess of the printing, never shown as "high", with the Set? menu kept. A wrong guess is fine; the user corrects it and that trains.

What it does:

- Corner number read (`lib/corner-read.js`, `lib/set-codes.js`, `readSourceCorner` in `lib/ocr.js`, `settleFromCorners` in `background.js`). When a card's set is still open and it is at least 400 source px tall, both bottom corners of the source photo are cut at native resolution (34% width, from 86% down) and scaled so the number text is about 100 px. A read settles the set only when it matches one of that row's own choices: the number (with its total fitting the set size), or a printed Scarlet & Violet code (SVI, PAL, ...).
- Best guess (`lib/page-prior.js`, `withBestGuesses` in `background.js`). After a photo is read, each still-open row takes the set that most evidence-settled cards on the page share. With none, it takes the printing the picture matched best. It is priced as that printing and capped below "high" (`BEST_GUESS_CAP`). The Set? menu stays, preselected. A "?" next to the name confirms it, and the reason is in its tooltip. Confirming saves a correction (`guess-confirmed`). So does picking from the Set? menu (`set-menu`). Both go to shared learning as `pick`.
- The lot estimate counts a best guess at its single price.

Measured in Chrome on 67 reviewed HiBid lot photos, HEAD `c583710` vs this commit, same boxes, 186 matched cards. HiBid was used for earlier tuning, and the 400 px gate was set from these runs.

| | before | after |
|---|---|---|
| Set confirmed by evidence, exact | 48 | 51 |
| Set open | 94 | 0 |
| Best guess right / wrong | – | 49 / 43 |
| Exact card incl. guesses | 48 | 100 |
| Wrong confirmed set | 3 | 3 |
| Wrong name / not named | 13 / 28 | 13 / 27 |
| Scan median / total | 3.4 s / 310 s | 3.8 s / 401 s |

- Page-prior guesses were right 6 of 6. Picture-only guesses were right 43 of 93 (46%).
- 48 synthetic binder pages (catalog scans, 6 per era plus promos, glare, ±8° tilt, 432 cards; `.tmp/lots/mksynth.py`). Exact card 155 → 391. Page prior right 38 of 42, picture guesses 86 of 117. Wrong confirmed set 0 → 0.
- Corner reads help little on real lot photos. Nothing under 400 source px settled, and at a 120 px gate each try cost about 1 s (median 4.4 s, total 477 s, same results), hence 400. Most of the remaining time is about 1.2 s per open card of 400 px or more.
- Not done: contrast boost on the corner strip (`for (const enhance of [false])`). The page prior also runs across the grid tiles of a search page, which are separate listings; that was not measured.
- Harness: `.tmp/lots/run.mjs` (env `EXT`, `JOBS`, `OUT`; profile is a fresh copy of `data/extension-live-profile` at `.tmp/lots/profile`, deleted after) and `.tmp/lots/analyze2.py <results.json> [jobs.json]`. Results: `head-c583710.json`, `after5.json`, `synth-old.json`, `synth-new.json`. `.tmp/` is gitignored.
- Verified: `npm test` 1033 pass, 0 fail. Popup e2e 5 of 5, including a new best-guess test. ESLint on touched files shows only the two older `background.js` errors (lines 65 and 193, from 8358db5). The dev build and `dist/extension-wasm-store.zip` were rebuilt from this tree.

## Build

Run from the repo root in PowerShell.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup_vendor.ps1              # once: fetches onnxruntime-web into tools/extension-wasm/vendor (hash-checked against scripts/vendor-hashes.json)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-wasm-extension.ps1          # dev    -> dist/extension-wasm
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-wasm-extension.ps1 -Sealed  # sealed -> dist/extension-wasm-sealed (scorer only)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-wasm-extension.ps1 -Store   # store  -> dist/extension-wasm-store and .zip
```

`dist/` is generated and gitignored; never hand-edit it. The build stops if `tools/extension-wasm/vendor` is missing or a file's hash differs. Dev build: localhost dashboard hosts, test-photo collection, test hooks. Store build: none of those, `<all_urls>` optional only; `tests/store-build.test.js` pins its permissions and hosts.

## Verify

- `npm test` on the Linux box after the accuracy pass: 1090 pass, 5 fail (Collectr CSV and TCGdex price tests, environment-dependent and unrelated), `tests/store-build.test.js` 8 skipped (Windows only). `npm run lint`: 41 problems (down from 47). Run both on Windows before relying on them.
- `npm test`: 1033 pass, 0 fail at the set-confirmation commit (2026-10-17, exit 0); not rerun for this doc-only update. Capture the real summary lines; do not pipe through `tail` (hides the exit code).
- `npm run lint`: 47 problems (46 errors, 1 warning), all pre-existing (unused variables and browser globals, e.g. `tools/extension-wasm/photo-detection.js:74`). Do not add new ones.
- Python, VellumAI: `cd tools/vellum-ai; .venv/Scripts/python.exe -m unittest discover -s tests` (about 11 minutes; `tests` is not a package, so `unittest tests.x` fails). Last run at ac3d08e: "Ran 279 tests ... OK" (exit 0).
- Python, shared learning: `python -m unittest discover -s tools/shared-data/tests`. Last run at 58a9c93: "Ran 101 tests ... OK".
- Popup e2e: rebuild dev first, then `npx playwright test tests/e2e/extension-wasm-popup.spec.js --project=extension` (headed, real Chrome; loads `dist/extension-wasm`). Last run at 58a9c93: 3/3 passed.
- Sealed score: `node scripts/sealed-score.mjs`, only when the user asks (see working rules).

## Real-world harness

`scripts/realworld-run.mjs` scans public marketplace pages with a built extension, twice per page (site access on and off), and records rows, stripes, prices and screenshots.

```powershell
Copy-Item -Recurse data/extension-live-profile .tmp/realworld-profile    # PROFILE must exist; this is a copy of the live profile
$env:EXT_DIR = 'extension-wasm'                                          # folder under dist/ (default extension-wasm)
$env:OUT_DIR = 'data/realworld/<name>'                                   # default data/realworld/2026-10-16
node scripts/realworld-run.mjs data/realworld/2026-10-16-p1/pages.json
```

Other env: `SCAN_ONLY=id1,id2`, `DELAY_MIN`/`DELAY_MAX` (seconds between pages), `PROFILE`. `--local` checks the harness on a local photo; `--discover <url> <linkRegex>` lists links. It stops a site on the first challenge page and never touches `data/sealed-test`.

- **Always pass the pages file.** An agent that starts it without one can end up on the held-out file.
- Dev pages (28): `data/realworld/2026-10-16-p1/pages.json`.
- Held-out pages (30): `data/realworld/fresh-pages.json`. Used once, at a56c0e9, and **no longer blind**. Do not tune against it or read it again for that purpose.
- Results are under `data/realworld/2026-10-16-*` (gitignored).

## Key results (real-world runs, 2026-10-16)

Dev pages, 28 pages, off mode ("off" = harness `forceScreenshotPath` off, the normal full-size-photo path; "on" = forced screenshot path):

- High-confidence rows: 22 -> 3 (none visibly wrong) after the "high" rule was refit (a56c0e9). Rows with a name and a price: 33 -> 89 ("useful" = a row showing a name and a price or price range).
- On mode (forced screenshot): high 0, 63 useful rows of 110.
- Calibration of the high stripe (fit on HiBid dev + 612 listing crops, evaluated on HiBid test and test2): wrong names among high 5/164 -> 0/84 on fit, 0/10 on each held-out split. Accepted reads stay 9.8% wrong name on fit (7.5% test, 4.1% test2). Rule: similarity >= 0.82 and lead >= 0.025 (`HIGH_TIER_SIM` / `HIGH_TIER_GAP` in `lib/fusion.js`). Reprint window 0.03 -> 0.05 (`lib/set-choice.js`).
- Crop fix (34bc430): on 190 reviewed HiBid boxes, exact card 26.3% -> 43.2%, right name 57.4% -> 70.5%; eBay listing crops 60.1% -> 72.9% by title. Clean catalog images match themselves at #1 54.7% -> 96.7%.

Held-out, 30 pages (HEAD a56c0e9), all reachable, 0 scan errors:

- 0 high rows in either mode. Useful rows: 37 of 95 (off), 22 of 87 (on). Median scan about 2.3 s (off) and 1.5 s (on).
- "Useful" counts rows with a name and a price even when the name is wrong, so accuracy is weaker than that count suggests.

Known weak spots (held-out):

- Wrong variants at medium: Pikachu ex read as Pikachu V, Drapion VSTAR as Drapion V (addressed in ac3d08e with the "Other version?" menu; not rerun on the held-out set).
- Japanese cards get wrong names (Charizard read as Raichu, Vaporeon as Gible); Japanese slabs are not in the catalog.
- Lot and binder photos in screenshot mode identify almost nothing (an 18-box eBay binder page: 15 named with full-size photos, 0 with the screenshot). The popup now offers site access after such a scan (25adc7e).
- A 50-card fan photo gave 0 rows; dead listings scan the "items we think you'll like" grid; Mercari's h1 is a cookie banner, so name-in-title is meaningless there.
- Sealed and non-card pages still produce a few false picker rows (Onix, Plusle).
- eBay search grids can return an eBay error page, which is a site block, not a code bug.
- Repeated names in one photo (glare) are sent to the picker (f1366ba).

## Shared learning (deployed 2026-10-17)

- Opt-in "Help improve recognition for everyone" is still off until the user turns it on. `tools/extension-wasm/lib/shared-config.js` is filled in (`c583710`): relay `https://card-scanner-relay.fabcrowd.workers.dev/v1/contributions`, manifest `https://github.com/fabcrowd/card-scanner-data/releases/latest/download/manifest.json`, and the pack public key. The store package adds those two hosts.
- The relay is deployed (KV, R2, both secrets). Allowed extension ids: the dev build and the unpacked store build. It writes only to the data repo's `inbox` branch. `main` there is admin-only by ruleset. The nightly job is split into a no-secrets build job and a signing job. Manifests carry `seq` and `issuedAt` (58a9c93, 87f2d0e).
- `fabcrowd/card-scanner-data` is public and no longer empty. The first nightly published a signed bundle (adapter + new sets). One test correction is on `inbox` (`contributions/2026-10-17/eea8a8e8889cd4d4-60054b19-1.json`). Leave it or delete it.
- Templates still live in this repo at `tools/relay/` and `tools/shared-data/`. Owner setup notes: `tools/shared-data/README.md`. Plan: `docs/plans/self-learning.md` (steps 2–4 are in `1f42193`).
- Revoke the Cloudflare setup token and the GitHub fine-grained token that were pasted into the Claude chat on 2026-10-17. They are not in the repo. Do not copy them into a commit or into this file.

## Sealed test set and exam photos

`data/sealed-test` has no labels yet: `scripts/sealed-score.mjs` prints "No fully labeled photos yet". The agreed approach is exam photos collected from real use. The look-alike penalty stays off until a score shows a gain (on 190 held-out HiBid boxes it raised right-name 70.5% -> 75.8% but wrong-name accepts 8 -> 10 and the test split fell 69% -> 66%). Saved-correction ranking is also off by default.

## Working rules

- Simplicity first (owner, 2026-10-17): scan a page, see which cards are there and their market price. Always show a best guess. A wrong guess is fine; the user corrects it and that correction trains. Do not withhold an answer behind an accuracy gate. An unpicked unrecognised card counts as $0 in the lot value, never as "bulk". Put explanations in tooltips, not extra sentences.
- Opus (the main session) researches, writes plans and briefs, reviews, verifies and commits. Sonnet subagents (`model: sonnet`) execute the plans: every code and file change, even one-liners. This is a token-saving measure: don't have Opus edit files or Sonnet invent plans. If a Sonnet agent hits a design decision not covered by its brief, it stops and reports instead of choosing.
- Never read, list or search `data/sealed-test`. Never tune to per-photo results. Run `node scripts/sealed-score.mjs` only when the user asks.
- A Cursor agent may commit concurrently; 87f2d0e was a Cursor commit. Run `git status` first and stage specific files, never `git add -A`.
- TDD; fresh-context review of every package; user's global floors apply (no committed secrets, security review for signing code).
- Refit `lib/fusion.js` thresholds when the model, crop or catalog changes. Check train/serve preprocessing parity first when accuracy is poor.
- Don't kill all `chrome.exe`; stop only processes you started.
- Update `tasks/todo.md` and `CHANGELOG.md` (date headers; Added / Changed / Fixed / Removed) before pushing.

Self-learning steps 2-4 are already in `1f42193` and live as of `c583710`. Do not start them again.
