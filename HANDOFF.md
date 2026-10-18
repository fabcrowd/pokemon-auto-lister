# Handoff

Last updated: 2026-10-18. Workspace: `C:\Users\daroo\Desktop\Repos\cardscanner\pokemon-auto-lister`. A new session can continue from this file alone. The previous handoff is in git history (`git log -- HANDOFF.md`).

State: branch `feat/card-picker-sealed-test` and `main` are both at `b6c6749` and pushed. Nothing is uncommitted except this file and the untracked detector candidates `tools/vellum-ai/models/card_detect_v7/` and `card_detect_v7b/` (parked; do not commit weights). `dist/extension-wasm-store.zip` is rebuilt from HEAD.

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

## Next

1. Whole-page scan speed: about 3 min for 200 cards and the popup must stay open. Consider running the scan without the popup, or pushing the overlay from the background worker. See `tasks/todo.md`.
2. Check the 108-vs-102 discrepancy: a first Base Set scan found 108 cards and the back-to-back one found 102 (lazy images?).
3. Recognising heavily tilted cards. Detector retrain is parked (`card_detect_v7b`, not shipped); see `tasks/lessons.md` (a wide box is a tilted card; gate detectors on right/wrong names in the Chrome lot harness, not box counts).

## Owner to-do

- Revoke the Cloudflare setup token and the GitHub fine-grained token pasted into chat on 2026-10-17. They are not in the repo; never copy them into a commit or this file.
- Create a Chrome Web Store developer account (chrome.google.com/webstore/devconsole, $5, fabcrowd@gmail.com) and upload `dist/extension-wasm-store.zip` with the listing from `docs/store/listing.md` and the privacy policy URL https://github.com/fabcrowd/pokemon-auto-lister/blob/main/docs/store/privacy-policy.md. Name and icon are approved; contact email is set.

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
