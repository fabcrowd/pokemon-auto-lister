# Handoff

Last updated: 2026-10-16. Workspace: `C:\Users\daroo\Desktop\Repos\cardscanner\pokemon-auto-lister`. A new session can continue from this file alone. The previous (stale) handoff is in git history (`git log -- HANDOFF.md`).

## Product and branch state

The product is the Chrome extension in `tools/extension-wasm/` (Pokémon card finder and price overlay; recognition runs in the browser with CLIP + YOLO via onnxruntime-web). The Node dashboard and the Python VellumAI sidecar are the older server side and still work.

- Branch `feat/card-picker-sealed-test`, HEAD `58a9c93`, 22 commits ahead of `main` (`e2ab17b`). **Nothing is pushed.** The remote has `main` and an older `origin/feat/card-picker-sealed-test`.
- Other local branches: `wip/cursor-variant-goal-2026-10-15` (Cursor's variant-detection work, snapshot) and `wip/p1-listing-focus` (stopped mid-edit; superseded by the commits below).

Branch commits, newest first (`git log --oneline main..HEAD`):

| Commit | Summary |
|---|---|
| 58a9c93 | Keep the signing key away from untrusted uploads; reject replayed packs |
| 87f2d0e | Stop one install or a forged crop from entering the community pack (a Cursor commit) |
| 508e616 | Share corrections across users through a relay and a signed community pack |
| a1606f2 | Fix review findings: version swaps, photo fetch bounds, page caches |
| ac3d08e | Offer look-alike versions (ex / V / VSTAR / Dark) without hiding the price |
| 25adc7e | Offer full-size photo access after a screenshot-only scan |
| a56c0e9 | Show name and price when only the set is open; earn "high" honestly |
| f1366ba | Ask when one photo repeats a name; add an optional look-alike penalty |
| be75912 | Use the listing title to order the picker's choices |
| 34bc430 | Crop card art the way the catalog was embedded |
| 2c8678b | Read the largest rendition of the listing photo the page offers |
| 7278b5f | Find related-item sections from their headings; adds the real-world harness |
| 6830ccb | Scan the listing's own photo, not the page's carousels |
| 94a576b | Popup: fold unrecognised cards into one row, count only real identifications |
| ef11ec4 | Chrome Web Store package with minimal permissions |
| ea5f9b6 | Remember corrected cards to rank them first next time (off by default) |
| 5d4d99c | Store docs: privacy policy, listing copy, original icon |
| feb0a3b | vellum-ai: keep splits stable as data grows; guard degenerate hashes |
| c579a0a | vellum-ai: split training photos by near-duplicate group |
| bda78c3 | Labeler: draw missed-card boxes without dragging |
| deb1f77 | Sealed marketplace test set: collect, import, label, score |
| bdedbe2 | Ask which card it is when unsure, and keep the answer |

The doc changes from the session that wrote this file (this file, README.md, CLAUDE.md, CHANGELOG.md, tasks/, docs/plans/self-learning.md, docs/plans/launch.md) are uncommitted.

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

- `npm test`: 955 tests, 955 pass, 0 fail (run 2026-10-16 at 58a9c93, exit 0). Capture the real summary lines; do not pipe through `tail` (hides the exit code).
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

## Shared learning (built, not deployed)

- Extension: opt-in "Help improve recognition for everyone" (off). `tools/extension-wasm/lib/shared-config.js` has `RELAY_URL`, `PACK_MANIFEST_URL` and `PACK_PUBLIC_KEY` all empty, so the feature is inert ("Not available in this build").
- `tools/relay/` is a Cloudflare Worker template; `tools/shared-data/` is the data repo's template (nightly pipeline, consensus, exam, regression gate, signing). Neither is deployed from this repo; the owner copies them.
- Data repo `fabcrowd/card-scanner-data` exists, is public, and is empty.
- Security fixes are done (87f2d0e, 58a9c93): the relay writes only to an `inbox` branch, `main` is admin-only by ruleset, the nightly job is split into a no-secrets build job and a signing job, manifests carry `seq` and `issuedAt`.
- Owner checklist: `tools/shared-data/README.md` ("Owner setup"): copy templates to the data repo, add the branch rulesets, fine-grained token, Cloudflare R2/KV, `wrangler.toml` values, secrets, deploy, generate the signing key, build `regression.npz` once, then fill `lib/shared-config.js`.
- Next plan: `docs/plans/self-learning.md`.

## Sealed test set and exam photos

`data/sealed-test` has no labels yet: `scripts/sealed-score.mjs` prints "No fully labeled photos yet". The agreed approach is exam photos collected from real use. The look-alike penalty stays off until a score shows a gain (on 190 held-out HiBid boxes it raised right-name 70.5% -> 75.8% but wrong-name accepts 8 -> 10 and the test split fell 69% -> 66%). Saved-correction ranking is also off by default.

## Owner decisions outstanding

- Manual test of the store zip (`dist/extension-wasm-store.zip`), including the site-access permission prompt.
- Contact email for the privacy policy and listing.
- Where to host the privacy policy (public URL).
- Chrome Web Store developer account.
- Approve the extension name and the icon.
- Push and publish (nothing is pushed).
- Deploy the relay and data repo (see above).

## Working rules

- Opus (the main session) researches, writes plans and briefs, reviews, verifies and commits. Sonnet subagents (`model: sonnet`) execute the plans: every code and file change, even one-liners. This is a token-saving measure: don't have Opus edit files or Sonnet invent plans. If a Sonnet agent hits a design decision not covered by its brief, it stops and reports instead of choosing.
- Never read, list or search `data/sealed-test`. Never tune to per-photo results. Run `node scripts/sealed-score.mjs` only when the user asks.
- A Cursor agent may commit concurrently; 87f2d0e was a Cursor commit. Run `git status` first and stage specific files, never `git add -A`.
- TDD; fresh-context review of every package; user's global floors apply (no committed secrets, security review for signing code).
- Refit `lib/fusion.js` thresholds when the model, crop or catalog changes. Check train/serve preprocessing parity first when accuracy is poor.
- Don't kill all `chrome.exe`; stop only processes you started.
- Update `tasks/todo.md` and `CHANGELOG.md` (date headers; Added / Changed / Fixed / Removed) before pushing.

## Next step

Self-learning plan step 2: the signed bundle replacing the pack-only manifest (catalog, memory, adapter, check, each with a sha256; hot-load only changed parts; keyed to the CLIP model and crop version). See `docs/plans/self-learning.md` (build order: 2 signed bundle, 3 seed + three add-ons + gate + STATUS.md, 4 new sets). Report a measured gain on the HiBid regression set before anything ships.
