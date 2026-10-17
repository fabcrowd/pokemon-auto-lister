# Lessons

## The photo is the card signal, not the title

Only identify a card after PokeGrade (or VellumAI) confirms a card in the photo (`identity.name`). 422 "could not identify a card" is a skip, not a retry.

## Collectr has no public Partner API — use private api-v2 + JWT

`getcollectr.com/api` is 404. Live path: `api-v2.getcollectr.com` with JWT from web `localStorage.collectrToken` (`COLLECTR_TOKEN` + `COLLECTR_USER_ID`). Portfolio: `GET /collections/{userId}/products`. Aggressive probing can trip WAF 401s / service-unavailable; back off and re-login if needed. CSV remains fallback.

## Agent: PowerShell is not bash

`&&` / bash heredocs fail in this shell. Use `;` between commands, set cwd with `Set-Location` first, and pass multi-arg `node --test` as separate paths (not a comma-joined string).

## Marketplace photo detection needs marketplace photo labels

The current detector was trained and validated mostly on synthetic/card-focused images. On the HiBid binder example (`.tmp/hibid-binder-hero.jpg`), its high-confidence result was one box covering almost the entire photo, not the nine cards. A synthetic validation score does not establish performance on listing photos; split real photos by lot into train and held-out validation sets, and report false positives on sealed-product photos as well as recall on loose cards.

**Rule:** never write detector proposals into training labels as if they were ground truth. Marketplace harvest now requires an image-adjacent JSON sidecar with `reviewed: true` and pixel-space `boxes`; an empty list is an intentional negative. Review every box before import.

**Capture rule:** preserve the source image URL and CSS rendering geometry (`object-fit`/`object-position` or background size/position/repeat). Detect in source pixels when readable, then map boxes back to viewport coordinates. Use the captured viewport crop when the source cannot be fetched or its CSS mapping is unsupported. Measure screenshot scale from bitmap width / viewport width instead of trusting devicePixelRatio alone.

**Inference:** SAHI-style slicing is useful when cards become too small at whole-image inference, but slicing does not repair a detector that classifies the whole scene as a card. Verify tile behavior on held-out listing photos before enabling it. See the [SAHI paper](https://arxiv.org/abs/2202.06934) and [Ultralytics tiled-inference guide](https://docs.ultralytics.com/guides/sahi-tiled-inference).

## A synthetic-val gate let a poisoned detector ship

The 2026-09 detector was trained with 138 marketplace frames whose "labels" were one box covering the whole image (`0 0.5 0.5 1.0 1.0`), written from unreviewed proposals. It learned "listing photo = one card" — the binder failure — while synthetic val still reported mAP@50 0.995. On reviewed real photos it scored precision 0.17 / recall 0.14.

**Rule:** before trusting a detector metric, open a few label files and draw them. A full-frame box on a multi-card photo is a data bug, not a hard example.

**Rule:** promotion needs a reviewed real-photo gate, not only synthetic val. `detect/eval_real.py` scores the shipped ONNX path on `data/detect-real-eval/` (split by lot; sealed product as negatives), and `retrain.py` now requires real F1 ≥ 0.90 and ≥ the current model.

**Fix that worked:** quarantine the bad labels (`data/vellum-detect/_quarantine_fullframe_labels/`), add catalog-art binder pages / flat-lays (`detect/synth_binder.py`) and reviewed sealed-product negatives, then fine-tune from the existing weights. Two CPU epochs were enough to fix the binder case; 90°-rotated photos and tiny thumbnails needed their own synthetic coverage.

**Unittest note:** `tools/vellum-ai/tests` is not a package — `python -m unittest tests.test_x` fails to import (a false RED). Use `python -m unittest discover -s tests -p "test_x.py"`.

## A dev set you tune on is not an accuracy number

End-to-end identification scored 98% on the 18-photo dev set I iterated against, then 46% on a blind 31-lot HiBid test set labelled afterwards. Dev was small, mostly clean binder pages, and every fix was chosen by looking at its misses.

**Rule:** label a held-out test split (HiBid lots whose id ends in 0-2) *before* tuning, label ids from the card itself (name, set symbol, printed number vs. catalog art — not from the pipeline's guess), and report the test number. Null an id only when the exact print cannot be determined (identical-art reprint with illegible symbol, basic energy).

**Root causes the blind set exposed:** CLIP retrieval misses the true card entirely on many real crops (not in its top 300) while SIFT verification against the right print still gets 60-160 inliers → add a CLIP-independent candidate source (OCR'd name → all prints with that name). The Python detector stretched non-square photos while training/extension letterbox. 294 catalog cards had `.png`-only art that verification never loaded; 1,272 had no art because pokemontcg.io set ids differ (`sm7.5` → `sm75`, `swsh12.5gg` → `swsh12pt5gg`).

**Pricing rule:** a price is only right if it is the right product. JustTCG's free-text search + "name matches" acceptance priced 19/20 correctly identified cards as a different printing. Require name + number + set (normalising "SV03:" prefixes, accents, "Base Set" suffix) and resolve the set id first.

## Once you have fixed against a test set's misses, harvest a fresh one

The 31-lot blind set went 0.462 → 0.723 as I inspected its misses and fixed each (upright crop, set context, aliases). By then it was partly a dev set. A fresh harvest (`test2`, 18 lots, labelled after all tuning, ids from lookup sheets of every print with that name) gave the honest number: find 0.964. Freeze code before scoring it, and do not fix against its misses; harvest test3 for that.

**Also:** `_is_train_lot` only excluded `split in ("test", "dev")` — a new `test2` split would have been trained on. Exclude every named split except `train`.

## Substring set matching makes the price metric lie

`sameSetName` used `includes`, so Base Set == Base Set 2, Celebrations == Classic Collection, Generations == its Radiant Collection — and the eval scorer used the same function, so wrong-printing prices scored as correct. Compare normalised names exactly, and teach the normaliser the vendor's spellings instead ("SV03:" codes, "EX "/"XY - "/"SM - " era prefixes, "&" vs "and", "Base Set" suffix for a series' first set; aliases for promos, SM Base Set, 151, Radiant Collection). Check coverage by matching every catalog set name against the vendor's `/sets` list: 155/158 match.

## `s.replace(s[a:b], new)` with an empty slice destroys the file

`s.index('## Review')` found an earlier heading than intended, the slice was empty, and `str.replace('', new)` inserted `new` between every character (todo.md grew to 12 MB). Recovered losslessly by removing every copy of `new`. **Rule:** search from the anchor (`s.index(end, a)`), and assert the slice is non-empty and the expected size before replacing.

## Price by the catalog id, not by searching a vendor

Every JustTCG/pokemontcg.io lookup was a search (name + set + number) that had to be matched back to the card, and most pricing bugs this session were matching bugs (substring sets, era prefixes, promo names). The catalog ids *are* TCGdex ids, and TCGdex serves TCGplayer + Cardmarket prices per card with no key or quota — so `GET /cards/{id}` prices the exact product with no matching at all. test2 price accuracy went from unmeasurable (quota) to 0.964, equal to find accuracy.

**Gotchas:** TCGdex has no TCGplayer row for Trainer/Galarian Gallery, Radiant Collection and many promos — use Cardmarket EUR × an ECB rate and mark `basis: 'cardmarket-eur'`. Its Cardmarket `-holo` fields are the reverse-holo variant, not the card (Meowstic XY48: trend 7.03 vs trend-holo 2.25). Vintage prices differ by edition (1st Edition vs Unlimited) — same id, different product; identification cannot see the stamp yet.

## Measure on held-out real pages, not per-photo fixes (2026-10-16)

A Cursor run tuned the extension to individual photos and the numbers looked fine on those photos only. Fixes now have to move a number on pages and crops nobody tuned against: HiBid reviewed boxes, the 28 dev pages, and the 30-page held-out set (`fresh-pages.json`, used once at a56c0e9 and no longer blind). Never fix against a held-out miss.

## Check train/serve preprocessing parity first (2026-10-16)

`cropArt` stretched the top 45% strip of a card into a square while the catalog (`embed_all.py`) took the centre square of that strip. Clean catalog images matched themselves at #1 only 54.7% of the time (96.7% with the matching crop), and real crops collapsed onto a few hub cards. Fixing the crop moved HiBid exact 26.3% -> 43.2% and right name 57.4% -> 70.5%, more than any threshold work. **Rule:** when recognition is poor, replay the query path against the catalog's own images before touching thresholds.

## A score rise means the confidence tiers must be refit (2026-10-16)

After the crop fix similarities rose, and the old "high" rule (confidence >= 0.80) produced 22 high rows on 28 real pages, several wrong. Tiers were refit on labelled non-sealed data (high needs similarity >= 0.82 and a lead >= 0.025): wrong names among high 5/164 -> 0/84. **Rule:** any change to model, crop or catalog needs the thresholds in `lib/fusion.js` refit.

## "Identified with no picker" was the wrong success metric (2026-10-16)

It rewarded blocking pickers over useful output. Real users want a name and a price. The metric is now "useful": a row showing a name and a price or price range. When only the set or version is ambiguous, show a range instead of blocking (the row keeps the top card's price; "Set?" and "Other version?" menus let the user choose).

## Heredocs in agent shells dropped regex backslashes (2026-10-16)

A regex edited through a shell heredoc lost its backslashes without any error. After any scripted edit of a regex, re-read the changed line and run the tests that exercise it.

## Piping test output through tail hides the exit code (2026-10-16)

`npm test | tail` reports tail's status, not the test run's. Capture the real summary (tests / pass / fail lines) or the exit code separately.

## Always pass the pages file to the real-world harness (2026-10-16)

`scripts/realworld-run.mjs` can pick up the held-out file when an agent starts it without a pages file. Pass the file explicitly every time, and keep the held-out file out of tuning runs.

## Keep running fresh-context reviews (2026-10-16)

Fresh-context reviews found real bugs every time: wrong-price version swaps (a1606f2), an unbounded photo fetch and private-host redirects (a1606f2), and the security holes fixed in 87f2d0e and 58a9c93. Review every package before it merges.

## A public relay with a write token must not reach code that runs with the signing key (2026-10-16)

The relay's GitHub token can write to the data repo. If it could write to `main`, a leaked token could change the code the nightly job runs with the signing key. Fix (58a9c93): the relay writes only to an `inbox` branch, `main` is limited to admins by a ruleset, the nightly job reads `inbox` as data, and a build job with no secrets is separate from the sign job.

