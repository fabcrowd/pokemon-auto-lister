# Handoff

Last updated: 2026-10-21 (afternoon, America/New_York). The newest work is the Facebook accuracy and UI pass on `feat/fb-accuracy-ui`, directly below. Older sections follow unchanged. Owner workspace: `C:\Users\daroo\Desktop\Repos\cardscanner\pokemon-auto-lister`. The previous handoff is in git history (`git log -- HANDOFF.md`).

## Facebook accuracy and UI pass (2026-10-19 → 2026-10-21, branch `feat/fb-accuracy-ui`)

The branch is based on `main` 232a9d3. All work is in `tools/extension-wasm` and `tests/`, with no manifest or permission changes. It was tested unpacked in headed Chromium (Playwright) on a Linux box with no GPU. The numbers come from the box's run log; the evaluation photos are not in the repo (see "Eval pack" below).

**Why.** The owner smoke-tested two Facebook Marketplace lot listings, and most cards came back "not recognized". The research found the cause is resolution, not thresholds: Marketplace serves 720×960 copies, so a 50-card lot leaves each card under 150 px. At that size the name is right about 1 time in 25. From 200 px and up it is right 89% of the time. The pass therefore does three things:
- reads more pixels wherever it can;
- names a card only when the evidence supports it;
- shows everything else as a clearly marked guess, so a lot can still be priced quickly.

### Commits (oldest first) and why

| Commit | Change | Why |
|---|---|---|
| 899ba40 | A sure name whose printing is still open shows as identified, priced as a range, with "pick printing". `MIN_NAME_HEIGHT` is 200 px. | Accepted reads from 200–299 px crops named the right card 75 of 84 times (89%); 120–199 px was 35/69, under 120 px 4/25. Asking about a card whose name is already sure wasted the user's time. |
| e48c421 | Drop detector boxes that are pieces of cards cut off by the photo edge. | A half card reads as some other card. FB wrong names 29→24 (shot) and 21→18 (src), with no right name lost. |
| b032a2b | Scan every gallery photo of a listing (≤8 photos, 45 s, ≥300 px, site access only) and keep a card seen in several photos once (mutual nearest neighbours, CLIP ≥0.8, never two from one photo). | Lots are photographed across several pictures. On the Marketplace-style fixtures, right names went 14→38 and wrong 11→14; precision of named rows went 36%→73%. |
| 4eeb10f | When a scan fell back to the screenshot for lack of access, the popup offers "Allow on <site>" (only the photo origins it wanted, ≤6), "All sites", or "Not now" (remembered per site). | Without access, the gallery and the original photos can't be read. |
| 49600f0 | Overlay tags are coloured by the list's verdict: green identified, blue printing to pick, amber asked, grey not recognised. They are placed without overlap. A rescan the page starts (late-loading pictures) now updates the popup, unless the user is mid-pick. | The overlay and the list disagreed, and late images never reached the list. |
| 226ba94 | On a fresh install, the first scans wait up to 8 s for the bundle, and the log says when the photo adapter is in use. | The adapter was live in the harness but could be missing on the first scans after install. |
| 2dc8aec | On fbcdn hosts, try the og/src URL with `ctp=` dropped first (up to 2048 px) and fall back on any failure. "Sure" is still judged on the shown photo's pixels. | Dropping `ctp=` returns the 1537×2048 upload instead of 720×960. fbo-photo-1 went 3 (0) / 10 (0) / 41 → 12 (0) / 9 (0) / 34. Judging "sure" on the original's pixels raised sure-wrong 0→8, so that part was rolled back. |
| e554499 | Title line as a second opinion: OCR of the name box, crops ≥150 px only. If the title agrees, a capped small-crop read may show as identified. A different catalog name in the title reranks within CLIP's top 20 (shown as asked), else the read is demoted. | Offline (138 FB cards), when CLIP's top-1 name appeared in the title it was right 42 of 43 times; the title is unreadable under 150 px (0 of 46). FB11 src: 69 (46) / 18 (5) / 65 → 73 (58) / 17 (2) / 62. |
| 9377d62 | Overlay tags 13–16 px (were 10–13), more padding, bolder text, soft shadow, state-coloured outline. | The owner asked for tags that stand out on busy photos. |
| e06cc24 | One search link per popup row: asked rows keep "None of these? Search" under the picks, identified rows keep "Wrong card?". `data-via` values are unchanged. `focusOpener` falls back to the row's opener, then its first button. | Both links opened the same search. The correction and teach data depend on `data-via`. |
| ba59d38 | Guess-first: a nameless card with candidates shows its top guess with that card's price, e.g. "Pikachu? ~$1.20". It is lighter amber with a dashed outline, and clicking the tag focuses its picks in the popup. There is a "small photo" chip under 150 px read height. New lot totals: Sure / Guesses ~ / Together. When ≥ half of a photo's cards were read under 200 px and a known-larger rendition was not read (a srcset `w` entry or a Facebook `ctp` original), an "Open full-size photo for better results" bar and overlay pill ask for that host's access, open the photo and scan it. `readHeight` is added to cards. | The owner prices whole lots and prefers a marked guess to "not recognized". What counts as identified or sure is unchanged: sure numbers were identical before and after. "Not recognised" is kept only for card backs and cards with no candidates. |
| 5a02883 | A guess priced over $50 is listed "to check" instead of being added to the total. | On photo-1, two rare look-alikes ($400 + $350) made up $750 of an $820 guesses total. |
| 4c4aae5 | `docs/blurry-training-plan.md`. | Plan for training the recognizer on small, blurry crops (see Next). |

### Before / after (main 232a9d3 → branch)

Format: right (shown as sure) / wrong (sure) / unknown or guess. Scored against hand-labelled card lists.
- "shot" = screenshot path (no site access).
- "src" = source image read with access (the harness lets 127.0.0.1 stand in for the site).
- "FB11" = the 11 photos from the owner's two Marketplace listings.
- "mp" = two local pages built like the Marketplace carousel (63 cards).
- "fbo" = the same photo-1 served behind a Facebook-CDN stand-in with its 1537×2048 original.

| set | main 232a9d3 | 49600f0 (steps 1–5) | branch HEAD |
|---|---|---|---|
| FB11 shot | 55 (0) / 29 (0) / 75 | 55 (34) / 24 (5) / 71 | 64 (45) / 23 (5) / 63 guesses |
| FB11 src | 69 (5) / 21 (1) / 71 | 69 (46) / 18 (5) / 65 | 74 (57) / 17 (3) / 61 guesses |
| mp src | 14 (0) / 11 (0) / 46 | 38 (26) / 14 (3) / 36 | 39 (34) / 13 (3) / 35 (at e554499) |
| fbo-photo-1 src | 3 (0) / 10 (0) / 41 | 3 (0) / 10 (0) / 41 | 12 (1) / 9 (0) / 34 guesses |

**Sure-wrong vs the "wrong names must not rise" rule.** It rose on the branch (FB11 1→3 src, 0→5 shot; mp 0→3). Every rise comes from step 1, which shows 200–299 px names as identified, and from step 2 on the mp fixtures. The owner accepted that trade: about +45 right names shown as sure for +3–5 wrong.

**Tag states on FB11** (ba59d38, sure unchanged):
- shot: 50 identified / 37 asked / 63 not recognised → 50 / 37 / 63 guess
- src: 60 / 30 / 62 → 60 / 31 / 61 guess

**Gates on HEAD 4c4aae5:**
- unit tests 1135 pass, with the 5 known failing files (Collectr, TCGdex backend);
- eslint clean on changed files;
- Base Set 3/3; 22/22 ×2; pokellector fixture 102/102;
- no new console errors (price snapshot 404 only).

Screenshots are on the box only, in `fb/out2/ui2-*.png`.

### Tried and rejected (with numbers)
- **Title guard for 200–299 px names** (kept in a local stash, not committed). It removed 11 confident-wrong names but turned 30 confident-right ones back into questions: FB shot sure right 34→19, sure wrong 5→0; src 46→35 / 5→1.
- **Crop-shift averaging** (mean of 5 framings), tried twice:
  - On grid tiles (Step C, earlier): sure-wrong rose 12→15 on the fixture with no more right names.
  - Re-ranking only guesses (this pass): shot FB11 top-1 7→8, top-5 18→17; photo-1 top-1 3→1, top-5 8→5. Scans took about twice as long (photo-1 25→47 s). Not committed.
- **Upscaling before the crop** (138 FB cards, top-1, baseline 66):
  - Real-ESRGAN general x4v3: 57 (−9). It invents texture the clean catalog scans lack.
  - Bicubic 2× + unsharp: 60. Plain bicubic 2×: 68, within noise.
- **Blurry catalog copies** (degraded 60/100/150 px views of all 21,774 cards as extra rows):
  - Using the "max" rule, blurry rows became hubs: 150–200 px top-1 22→14, pokellector at 137 px 87→78.
  - With "score max", wrong reads went 22→53.
  - The best safe mix (w=0.3, crops <150 px) gave only +3/138 for +6.5 MB of download.
- **Blur-trained adapter** (seed + one 150 px view per card, merged 0.5 with the live adapter):
  - Offline it looked good: FB11 top-1 73→75, top-5 88→93; pokellector 137 px 87→96.
  - The card-scanner-data gate failed (acceptedWrong 32→36, `improved=false`).
  - In the extension A/B, pokellector improved (sure right 65→77, sure wrong 12→5), but FB11 sure-wrong went 4→7 (photo-5, photo-6). It failed the ship rule, so it was not shipped or published.

### Known limits
- Guesses on tiny cards are weak. Among cards that used to be "not recognised", the top guess is right about 10% of the time and the right card is in the top 5 for 25–30% (FB11). On photo-1 that is 5–8% and 17–22%. Treat guesses as a starting point for the pick list, not as answers.
- On dense photos the tags are small next to the cards; hover a tag to see its full label.
- The rescan→popup refresh path (late-loading pictures) is covered by code review only; the harness can't trigger it.
- The `ctp=` original is undocumented Facebook behaviour (seen 2026-10-20). It can stop working at any time; the code then falls back to the shown photo.
- With access, the full-size tab turned 12 cards sure (from 0) on fbo-photo-1. Those 12 have not been scored for right/wrong yet.
- The `prices` release (price snapshot) still returns 404, so the popup logs one known console error.

### Next
- Training for small, blurry crops: `docs/blurry-training-plan.md` covers degraded training data, the adapter retrain with a tile slice in the gate, a CLIP fine-tune, the detector, and the gates to pass. The first try (the blur adapter above) shows that the gate must count sure-wrong on Facebook-style photos, not just top-1.
- Score the 12 sure cards from the full-size tab before advertising that path.
- Real Chrome on the owner's PC: re-check the FB listings live, the site-access prompt, and the full-size bar.

### Eval pack
`/workspace/fb-eval-pack.zip` on the Linux box (3 MB) contains:
- the 11 served photos and 2 originals;
- `truth.json`;
- the replica scripts.

It is deliberately **not** in the repo: the repo is public, and the photos are other people's Marketplace listings. Copy it to the PC by hand.

## Continue from here (2026-10-19)

Ship-smoke of the overlay and extension UI ran on this dirty tree. The product is **not signed off**. Cloud QA never launched (the Cursor workspace is `cardscanner`, which has no git remote; the repo with `origin` is this nested folder). [QA auditor](c980dd19-3450-473c-a741-5b89aba4d7cd) ran locally in headed Chromium 153 / Playwright 1.63.0, unpacked `tools/extension-wasm`, id `glelmmehhcnicljmgmhkaddndalaeelg`. Report: `tasks/qa-smoke-report.md`. Screenshots: `tasks/qa-smoke/*.png`. Do not commit the leftover Playwright profiles under `tasks/qa-smoke/chrome-profile-*` and `tasks/qa-smoke/label-profile-*`.

HEAD at audit: `48e2b76` plus uncommitted extension/docs/pricing work. Overlay, popup, and settings were exercised with screenshots and console listeners. Live scan was blocked (models not downloaded).

### This smoke — done vs remaining

The named-model engineer agent could not start (plan only allows Auto). QA-1 was fixed in this session in `content.js` (`badgeLayout`, compact under 140 px, clamp to card width). `tests/content-pure.test.js` 30/30. Chromium re-shot the same 200/110 fixture: `tasks/qa-smoke/overlay-wide-fixed.png` (name ellipsized on the card), `overlay-narrow-fixed.png` (price-only `$420.50` on the 110 px card). Overlay QA-1 is accepted. No commit.

Still open:

1. **QA-2 (deferred).** Popup and service worker `console.error`: `[prices] snapshot not updated: price snapshot answered 404`. Needs the `prices` pre-release on `fabcrowd/card-scanner-data`, or a quieter log for an expected miss.

2. **Live SCAN PAGE** still untested (models not downloaded, ~140 MB). Wizard `#btn-wiz-access-skip` never shown on the unpacked `<all_urls>` manifest. Wizard Allow / post-scan Allow not clicked. Store-build optional-permission wording not exercised.

3. Playwright profiles under `tasks/qa-smoke/*-profile-*` — delete; do not commit.

4. Owner PC / store / accuracy items below are unchanged.

### Still to do (from before this smoke)

Owner PC / store / accuracy items below are unchanged: Windows `npm test` including `tests/store-build.test.js`, real Chrome Pokellector vs the old 97–98 figure, rebuild `dist/extension-wasm-store.zip` from current sources, `hub-penalty.bin`, refinement on other grid sites, adapter `tiles` slice, community loop, revoke leaked chat tokens.

Working-tree warning: many files are already dirty (`popup.js`, `content.js`, `background.js`, pricing snapshot, store docs). Do not `git add -A`. Do not commit detector weights under `tools/vellum-ai/models/card_detect_v7/`. Do not read `data/sealed-test`.

Daily prices: TCGdex's TCGPlayer block was stuck on 2026-10-14 (Venusaur ex `sv03.5-198` $92.29 there, $88.85 in the same day's tcgcsv snapshot). The extension does not fetch that snapshot itself. `pipeline/prices.py` writes `prices.json` (product id to subtype price, plus `updatedAt`). The nightly publishes it on the `prices` pre-release of `fabcrowd/card-scanner-data`, which is not `latest`, so the learning bundle is unchanged. `lib/price-snapshot.js` downloads that file once a day and replaces a TCGdex market only when the product id matches. Until `tools/shared-data` is copied onto the data repo and the nightly runs, the URL 404s and scans keep the TCGdex date.

State: `main` includes the extension accuracy pass below (branch `fix/extension-only`, merged 2026-10-18; the commit list is in "Extension accuracy pass"). The working tree is dirty (extension, pricing snapshot, store docs, this smoke). Untracked detector candidates `tools/vellum-ai/models/card_detect_v7/` and `card_detect_v7b/` stay parked; do not commit weights. `dist/extension-wasm-store.zip` was last rebuilt before the accuracy pass: rebuild it from current sources before any store upload.

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
