# Card picker, corrections, and the sealed test set

Status 2026-10-15: steps 1 and 2 approved to build. Step 3 waits until steps 1 and 2 exist and the sealed set has labels.

Why: the Cursor variant loop tuned rules against its own "held-out" photos until they passed. These steps give the scanner a way to ask when it is unsure, record what the user says, and measure progress on photos no one tunes against.

## Step 1 — Ask when unsure, let the user search, keep the answer

### What the user sees (popup, `tools/extension-wasm/popup.js`)
- A card is **unsure** when `abstain`, when `setChoices.length > 1`, or when its confidence tier is low.
- An unsure card shows **"Which card is this?"**: up to 5 candidates in a row of thumbnails, each with name, set, and number. Clicking one prices that card through the existing `priceCard` path.
- Under the candidates, **"Not listed? Search"** opens a search box. It searches the local catalog by name, by number (`4/102`, `#4`, `4`), or both (`charizard 4`). Results show the same thumbnails, up to 20, newest era first when the scan era is set.
- Every card, sure or not, has a small **"Wrong card?"** link that opens the same search. Confident mistakes are the expensive ones.
- Thumbnails use the catalog's `imageUrl` (TCGdex). When it is missing, they fall back to `https://images.pokemontcg.io/{setCode}/{number}.png`.

### Data
- Pure logic goes in a new `tools/extension-wasm/lib/card-picker.js`:
  - `isUnsure(card)`
  - `candidatesFor(card, meta, limit = 5)`, which takes set choices first, then same-name printings.
  - `parseSearch(query)`, which returns `{ words, number, total }`.
  - `searchCatalog(meta, query, { era, limit = 20 })`, for name and number matching. It is not the embedding `searchCatalog` in `lib/search.js`; choose a distinct exported name, `findCards`.
  - `thumbUrl(card)`
  - `correctionRecord(...)`
- Background (`background.js`):
  - A new `findCards` message, `{ query, era }`, returns the top rows from `_meta`.
  - A new `saveCorrection` message stores one record.
  - During a scan, keep each card's rectified crop as a small JPEG (375×525, quality 0.85) in memory, keyed `scanId:index`, so a later correction can save the pixels the scanner saw. Drop the map on the next scan.
- Storage: IndexedDB in the service worker, database `card-scanner`, store `corrections`. Do not use `chrome.storage`, because its quota is too small for images. Each record holds:
  - `ts`, `pageUrl`
  - `guess` (`{ id, confidence, abstain, choiceIds }`)
  - `pickedId`
  - `via`: `"candidates"`, `"search"`, or `"wrong-card"`
  - `crop` (JPEG data URL)
  - `extVersion`
- Options page (`options.html` / `options.js`):
  - **"Corrections: N saved"** with **Export**, which downloads one JSON file.
  - **Clear**, behind a confirm.
- Nothing is uploaded anywhere.

### Tests
- `tests/card-picker.test.js` covers every pure function, including XSS-safe rendering of names with `<`, `&`, and quotes.
- Coverage of the new lib is at least 80%.
- Existing `npm test` stays green. Existing lint errors on `main` may remain, but no new ones.

## Step 2 — Sealed marketplace test set

### Collect (no scrapers)
Scraping eBay, Mercari, or Facebook breaks their terms, and Facebook needs a login. Instead, the extension saves what the user is already looking at:
- Options toggle **"Test-set collection"**, off by default.
- When it is on, each page scan also stores, in IndexedDB store `testPhotos`:
  - the full source photo bytes the scanner used
  - the page URL and marketplace host
  - the detector boxes
- It stores **no identities and no prices**.
- Export from the options page as one JSON file. HiBid lots can also come from `scripts/harvest-hibid-photos.mjs`.
- Target: about 200 cards, at least 30 per variant we report, from eBay, Mercari, HiBid, and Facebook Marketplace. Dates must be after 2026-10-15.

### Import and seal
- `scripts/sealed-import.mjs <export.json>` writes `data/sealed-test/photos/<sha>.jpg` and `data/sealed-test/photos.jsonl`.
- It drops a photo when either is true:
  - its 64×64 dHash is within Hamming distance 6 of any training crop (`data/variant-photos/crops`) or of an earlier sealed photo
  - its listing URL is in the training manifest
- `data/` is already gitignored.
- Agents are kept out:
  - `.claude/settings.json` denies `Read`, `Grep`, and `Glob` on `data/sealed-test/**`.
  - `.cursorignore` lists `data/sealed-test/`.
  - `CLAUDE.md` and `docs/autopilot/CURSOR.md` state the rule. Agents may run the scorer only when the user asks, and never read per-photo results.

### Label (pick from options, scanner guess hidden)
- `node scripts/sealed-label.mjs` serves `tools/labeler/` on `http://127.0.0.1:3100`.
- For each box it shows:
  - The crop.
  - A search box prefilled with words from nothing. The listing title is not shown, because it is a guess too.
  - All printings of the name the user types, in set order.
- The user clicks a printing, then a variant:
  - the variant buttons come from that card's catalog variants (1st Edition / Shadowless / Unlimited / Holo / Reverse / Normal)
  - **"Can't tell"** is always offered
- Per box there is also **"Not a card"**. Per photo there is **"+ a card the scanner missed"**, which records a missed-card count with its label.
- The scanner never runs in the labeler. Labels go to `data/sealed-test/labels.jsonl`.
- Reuse `card-picker.js` for search and thumbnails.

### Score (totals only)
- `node scripts/sealed-score.mjs` loads `dist/extension-wasm` in Playwright, like `tests/e2e/live-scan.mjs`, and scans each sealed photo.
- It prints totals only, each with a Wilson 95% interval:
  - detection recall and precision
  - identity accuracy
  - precision when not unsure
  - unsure rate
  - variant accuracy
  - right-price rate
- It never prints file names, listing ids, or per-photo results.
- Each run appends `{ ts, gitCommit, counts }` to `data/sealed-test/score-log.jsonl`, so the number of runs is visible.

## Step 3a — Reference memory from corrections (building 2026-10-16)

- **Reference store.** A `references` IndexedDB store holds one row per correction: `{ id, cardId, ts, embedding }`. `ts` is the correction's time, so a reference made from a replaced answer is recognized as stale.
  - The embedding is the normalized 512-float CLIP vector of the correction's crop, made with the extension's own `embedCard`.
  - Corrections without an embedding are embedded later, once the models are loaded and only while the option is on. Saving a correction never waits for the models.
  - Embeddings must be finite, 512 floats, unit length (within 1e-3); anything else is refused on import and export.
  - When a correction is replaced (same `scanId:index`), its reference is replaced with it.
- **Use at search.** After `searchCatalog`, the query is also scored against the references. A reference reorders printings; it never overrides the catalog.
  - A reference counts only if its score reaches `REFERENCE_MIN`, and only if it also beats the top catalog hit by `REFERENCE_MARGIN`.
  - It may only promote a card that is already in the catalog's physical top 20. That card moves to the front at the catalog's top score, so fusion sees a tie: no confidence is added and the unsure picker can still appear.
  - When the card is unsure, its `candidates` list starts with the referenced card.
  - Each correction also saves the catalog's top score (`guess.catalogTop`) so the margin can be measured later.
  - Both constants are documented as unmeasured. They may be set only from dev data (the user's own corrections, leave-one-out), never from the sealed set.
- **Option.** "Recognize cards I corrected before" is **off by default** until a sealed score shows it helps.
- **Measuring it.** `sealed-score.mjs --references <corrections-export.json>` loads that export's references into the scoring profile.
  - Any correction whose crop dHash is within 6 of a sealed photo, a sealed box crop, or a box crop turned 90, 180 or 270 degrees is dropped first. The dropped count and a histogram of how close the kept ones came (7-10, 11-15, over 15 bits) are printed.
  - This cannot catch a different photo of the same physical card.
  - The scoring profile's own corrections are cleared and the loaded reference count is checked before the first scan and after the last.
  - Comparing a run with references to one without is the gate.
- **Leave-one-out dev check.** `scripts/references-dev-check.mjs <corrections-export.json>` reports, for a given threshold and margin, how often a held-out correction's nearest reference from another scan is the right card. Results are an upper bound for `REFERENCE_MIN` (they ignore whether the card was in the catalog's top 20). The margin can be judged only for corrections saved with a catalog top score.

## Step 3 — Learn from corrections (plan only; build after steps 1–2)
- The cheapest learning needs no retraining. Add user-confirmed crops as extra reference embeddings for their card id in the FAISS index, so a card seen and corrected once is found next time.
- Periodic retrain: corrections go to the train split only. Drop any whose dHash or URL matches a sealed photo.
- A new embedding set or model ships only if `sealed-score` beats the current one. Never update live in the browser.
- Picks from a ranked list lean toward the top suggestion. That is fine for training, and it is why the labeler hides the guess.
