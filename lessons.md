# Lessons — pokemon-auto-lister WASM extension

Captured while taking `dist/extension-wasm/` from a crashing webcam toy to a shipping web-page scanner that overlays live Pokémon TCG prices on any webpage.

---

## 1. Model shape bugs are silent until you look at tool errors

The original `detect.js` letterboxed the input to multiples of 32 (e.g. 640×480 from a webcam frame), but the YOLO detector was exported with `imgsz=640` + `simplify=True` — a fixed `[1,3,640,640]` input shape baked into the graph.

Every scan threw:

```
ORT: Got invalid dimensions for input: images for the following indices
 index: 2 Got: 480 Expected: 640
```

And `popup.js` silently returned `isBusy = false` on `data?.error`, so the UI stayed on `—` forever with zero diagnostic signal.

**Rule**: when inference silently fails, add a surface for the error in the UI (not just console). A hidden error is worse than a loud one.

**Rule**: ONNX exports with `simplify=True` embed input shape. Check the model with a `.inspect()` or an `onnxruntime` session dump before writing dynamic preprocessing.

---

## 2. Chrome SW module cache survives profile launches

With a persistent Playwright profile, Chrome caches the extension's service worker. Editing `background.js` on disk does **not** cause the SW to reload — the cached module graph is reused.

Symptoms:
- Code change clearly on disk, confirmed via `Read`
- Runtime still throws against the old code (e.g. `_ensureContentScript is not defined` when it IS defined)
- SW console logs don't match the current source

**Fix**: `rm -rf .tmp/ship-profile` before every test run that depends on new SW code. Alternatively, programmatically call `chrome.runtime.reload()` from an SW `.evaluate()` — but wiping the profile is more reliable.

---

## 3. Playwright + Windows HiDPI: `devicePixelRatio` lies

On a 150%-scaled Windows display, `chrome.tabs.captureVisibleTab()` returns the viewport at **physical** pixels (e.g. 2100×1350 for a 1400×900 CSS viewport). But `window.devicePixelRatio` inside the page reports **`1.0`** when Playwright didn't explicitly set `deviceScaleFactor`.

If you trust the DOM-reported dpr for crop math, every crop lands on the wrong pixels and CLIP sees garbage.

**Fix**: compute dpr empirically — `bitmap.width / viewportWidthFromContent` — and only trust the DOM value when the two agree:

```js
const dprMeasured = bitmap.width / viewportWidth;
const dpr = Math.abs(dprMeasured - dprReported) < 0.05 ? dprReported : dprMeasured;
```

---

## 4. YOLO detectors don't generalize from photos to screenshots

The YOLO card detector was trained on synthetic + photographic card images (held in hand, on tables). Pointed at a webpage with the exact same cards rendered as `<img>` on white, it found **1 of 6** — because the training distribution never contained "card inside UI card inside browser chrome on bright background."

**Pivot that unblocked the project**: don't detect at all. The DOM already knows where every image is. A `findCardImages()` content-script function that walks `<img>` elements and filters by Pokémon card aspect ratio (0.60–0.82) + min dimensions returns 6/6 with zero false positives.

**Rule**: when a model is out of distribution, look for a cheaper deterministic signal first. The DOM is a free annotation layer the ML stack rarely uses.

Keep the YOLO path for use cases that need it (webcam, generic screenshots without `<img>` tags), but prefer DOM when it's available.

---

## 5. RRF margin thresholds break on single-source retrieval

The fusion rule inherited from the Python sidecar required `top1_rrf − top2_rrf ≥ 0.02`. With only CLIP as a signal and 20 distinct catalog hits, consecutive RRF scores are `1/(60+r+1) − 1/(60+r+2)` → about **0.0003**. The threshold almost never passes, so the pipeline abstains on nearly every card.

**Fix**: use raw CLIP similarity for the gate instead of RRF when there's only one ranking signal. Three accept rules work well:

1. **Clear gap**: `topSim − secondSim ≥ 0.02` → accept top-1
2. **Reprint tie**: top-1 and top-2 share a Pokémon name → accept top-1 (same art, different printing)
3. **High absolute sim**: `topSim ≥ 0.85` → accept even without a gap

Hard floor: `topSim < 0.72` always abstains. Below that it's genuinely noise.

**Fourth rule (2026-10-11):** if the top 3 hits are within 0.02 of each other and one name appears more often than any other, accept that name's best hit (`name_vote` in `lib/fusion.js`). This recovered Sunflora when Exeggutor led by 0.001 and the next two hits were Sunflora. Only count those three hits. Later catalog neighbors that repeat the lookalike will outvote a real three-way tie (PokéNav was accepted for a PlusPower until the vote was limited to the top 3). A tie among different names still abstains. If the top 3 all agree on the wrong Pokémon (Shellder scored as Shelgon at 0.83/0.82/0.82), this rule cannot help — that is the embedder, not the gate.

---

## 6. Base-Set art is reprinted *many* times — identity ≠ printing

CLIP correctly matched Charizard base art, but the top-5 all looked like this:

```
base1-4@0.865   lc-3@0.865   ecard1-6@0.845   base4-4@0.839   ecard3-146@0.831
```

All five are **Charizard**, same artwork, from different sets (Base, Legendary Collection, Expedition, Base Set 2, e-Card). CLIP cannot distinguish identical artwork — and shouldn't be expected to.

**UX implication**: showing "Charizard" is high-value even when the specific print is ambiguous. Showing a wrong-set price (e.g. "$2 Pocket print" for a "$900 Base-Set card") is actively harmful.

**Fix — fallback pricing**: if top-1 identity has no market price, walk the top-K for a same-named card that **does** price. Then surface that printing as the final identity so the label and the dollars match. This moved the overlay from 2/6 to 6/6 fully-priced cards.

---

## 7. pokemontcg.io flakes under burst — retry 5xx, cache 404

The API returned `502 Bad Gateway` on about one in six requests when hit in rapid succession. The original code treated any non-OK as "no price" and cached it — so a transient 502 permanently poisoned the cache.

**Rules**:
- Retry 5xx (3 attempts, 400ms backoff per attempt). 2 of my 2 flaking cards recovered on retry.
- Cache **only 404** ("card does not exist"). 5xx is transient; a scan 30s later might succeed.

---

## 8. Content-script overlay badge placement

Original placement — "below the card, else above" — collided badly when card images extend past the viewport fold. Row-2 cards' badges got pushed up and overlapped row-1 cards' badges in the same column.

**Fix**: place every badge inside the top-left of the card's **visible** region. Readable, never collides, even when a card is half-cut by the viewport edge:

```js
const vy1 = Math.max(0, y1);
const vy2 = Math.min(canvas.height, y2);
const bx = Math.max(6, Math.min(vx1 + 6, canvas.width - WIDTH - 6));
const by = Math.max(6, Math.min(vy1 + 6, vy2 - HEIGHT - 6));
```

---

## 9. Service-worker response plumbing

Three things to get right for `chrome.runtime.sendMessage` + async handler:

1. The sync listener must `return true` to keep the port open:
   ```js
   case "scanPage":
     handleScanPage(sendResponse);
     return true;
   ```
2. The async handler must call `sendResponse(...)` on **every** code path (including early-return guards and `catch`).
3. If the SW dies before `sendResponse`, the caller's Promise resolves to `undefined` with `chrome.runtime.lastError` set. "`undefined` response" almost always means "handler threw or forgot to call sendResponse."

For diagnostics: `JSON.stringify({a: undefined, b: undefined}) === "{}"` — an empty-looking response in logs can mean "every field was undefined because the whole response was undefined."

---

## 10. Playwright can't drive the SW directly when it's idle

`context.serviceWorkers()[0].evaluate(...)` throws `Could not establish connection. Receiving end does not exist.` when the SW has gone to sleep (which happens after ~30s of idle).

**Fix**: hold open a page served from the extension (`chrome-extension://<id>/popup.html`). That keeps the SW warm and gives you a `page.evaluate()` surface where `chrome.*` APIs work. Also hook SWs that already exist at launch time — `context.on('serviceworker')` only fires for **new** SWs, not pre-existing ones:

```js
context.on("serviceworker", hookSw);
for (const sw of context.serviceWorkers()) hookSw(sw);
```

---

## 11. UI state is not SW state

The popup script runs an init IIFE on load that calls `checkReady()` → shows the setup overlay if models aren't loaded. If you later install the models via `chrome.runtime.sendMessage({action: "startSetup"})` *from `.evaluate()`*, the SW's `_ready` flips to `true` but the popup DOM state **does not update** — the setup overlay stays on top and intercepts pointer events.

Playwright symptom: `<div id="setup-overlay"> intercepts pointer events` on every click retry.

**Fix in tests**: click the actual `#btn-setup` button so popup.js runs its own completion handler (`setupOverlay.style.display = "none"`). Don't shortcut the UI state machine with raw SW messages when a later test step depends on the UI being in a specific state.

---

## 12. `activeTab` + `scripting.executeScript` is enough — don't ask for `<all_urls>`

The extension needs to inject `content.js` into pre-existing tabs (opened before install) because `content_scripts` only auto-injects on **future** navigations.

With `activeTab` + the `scripting` permission, you can `chrome.scripting.executeScript({target:{tabId}, files:["content.js"]})` on the tab the user invoked the action from — no scary "read your data on all websites" warning. The `content.js` has a `window.__cardScannerLoaded` guard so repeated injections are idempotent.

Keep the `<all_urls>` permission out of the manifest unless you genuinely need background access to arbitrary tabs.

---

## 13. Measure latency with and without the price cache

Cold-cache end-to-end on 6 cards: 7.9 seconds (6 pokemontcg.io round-trips dominate).
Warm-cache end-to-end on the same 6 cards: 1.4 seconds (CLIP + search only).

**Rule**: when a user-facing latency is dominated by a network cache miss, measure both paths. The warm number is what your returning users actually feel.

---

## 14. Keep the test harness deterministic — serve from localhost, not `file://`

`file://` has quirky origin behavior for extensions (CORS, cookies, favicon requests throw). A one-liner Node HTTP server (`createServer`, 30 lines, no deps) serving the test page from `127.0.0.1:7788` eliminated multiple heisenbugs that had nothing to do with the extension itself.

---

## 15. Marketplace photos need source geometry and reviewed photo labels

The HiBid binder example is a useful counterexample to the clean DOM-grid path. On `.tmp/hibid-binder-hero.jpg` (540×720), the shipped model returned one near-full-image box `[1, 0, 541, 720]` at 0.932 confidence rather than the nine cards. Rejecting that box avoids false identifications, but does not detect those cards. The local marketplace set had 138 photos and no reviewed annotations; synthetic validation is not evidence of marketplace-photo performance.

**Capture rule:** pass large image candidates' source URL and CSS rendering geometry to the worker. Run against original pixels when readable, then map detections through `object-fit`/`object-position` or supported background sizing and positioning. Fall back to the captured viewport crop when source access or mapping fails. Measure screenshot scale from bitmap width divided by viewport width; page `devicePixelRatio` can be wrong under Playwright/Windows scaling.

**Training rule:** never use detector output as ground truth without review. Marketplace import requires an adjacent JSON sidecar with `reviewed: true` and pixel-coordinate `boxes`; `boxes: []` means a reviewed negative, such as sealed product. Keep photos from each auction lot in one split, and include negatives when reporting precision.

**Inference:** sliced inference can help when cards are too small after whole-image resizing, but it cannot fix a model that predicts the entire scene or tile as one card. Here the existing model did that on the binder, so tile inference alone is not a justified fix. Evaluate it only after training on real listing photos. See the [SAHI paper](https://arxiv.org/abs/2202.06934) and [Ultralytics tiled-inference guide](https://docs.ultralytics.com/guides/sahi-tiled-inference).

## 16. Same byte length is not the same ONNX

On the ShopGoodwill lot photo (`data/detect-marketplace/goodwill/279630564/00.jpg`, and the screenshot saved as `data/extension-live-listing.png`), desktop ORT on `tools/vellum-ai/models/card_detect.onnx` scored class 0 at **0.932** (137 anchors above 0.5) and the extension scored **0.0804**. Letterbox pixels matched (gray 114 corner, same channel means). Output layout was channel-major `[1, 7, 8400]`. JPEG recompress, ORT Web 1.17 / 1.18 / 1.21, and `ort.env.wasm.simd = false` all stayed near 0.08.

The files are both **10,606,263** bytes and they are not the same model:

- local finder: sha256 prefix `5e17ae58b25843be`
- GitHub release v2.0 `card_detect.onnx`: sha256 prefix `930c9875e218f83a`

The extension downloads the release into Cache API `cardscanner-models-v2.1` and skips files already cached, so a weak download is reused forever.

**Fix:** `scripts/build-wasm-extension.ps1` copies the local finder to `dist/extension-wasm/models/card_detect.onnx`. `getDetectorBuffer()` in `background.js` uses that file when it is present and only then falls back to the download. Do not publish the local ONNX to the GitHub release unless asked.

**Rule:** before comparing desktop and WASM scores, hash both model files. Equal length is not equality.

**Superseded the same day:** with the user's OK, the local finder was published as release v2.1, and the bundled copy was removed. `lib/setup.js` now gives each file its own release and checks the finder's sha256 before caching it. To ship a new model, publish a new release and change only that file's entry. The extension caches by URL and never re-fetches a URL it already has, so replacing an asset in place reaches no existing user. A new URL fetches just that one file.

## 17. Wipe the service-worker script cache, not the model cache, and not in the same command as launch

Lesson 2 still holds: a persistent Playwright profile reuses the old service worker after `background.js` changes. Two extra traps showed up while forcing a reload:

- Deleting `Default/Service Worker/ScriptCache`, `Extension Scripts`, or `Code Cache` in the **same** command that launches Chrome leaves the worker dead (`not running` / no `serviceworker` event). Delete first, launch, and if the first launch fails, launch again without deleting. The second start compiles the worker from disk.
- `Default/Service Worker/CacheStorage` is the Cache API. Deleting it throws away the ~140 MB model download. Do not clear it to reload JavaScript.
- `chrome.runtime.reload()` did not produce a `serviceworker` event Playwright could see (20s timeout).
- Bumping `manifest.json` (`2.0.0` → `2.0.1`) is the durable way to make Chrome notice an unpacked extension. Popup pages reload from disk more readily than the worker; a new popup can show new UI while the worker is still the old module graph. Confirm a worker change with a log line that only exists in the new file (`[BG] using bundled detector`).

## 18. `captureVisibleTab` photographs the focused window

`chrome.tabs.captureVisibleTab(windowId)` captures that window's visible tab, not a tab you name. Opening `popup.html` as a tab in the listing's window, then focusing it, made YOLO run on a picture of the popup (0 boxes). The product opens the scanner with `chrome.windows.create` (500×680) and leaves the listing in the original window. The live harness has to do the same: configure the popup, close that tab, open the real popup unfocused, and bring the listing forward before Scan.

A portrait lot (1500×2000, displayed 900×1200) has ratio 0.75, so `findCardImages` reports it as one card **and** one photo. If YOLO inside the photo returns 0, the single-card path embeds the whole collage and fusion abstains ("Found 1 card (0 identified)"). That message means the split failed, not that the page had one card. A close-up of one real card is also a photo candidate, so a failed split must still be allowed to fall through for genuine single cards.

Local test pages are `http://127.0.0.1`, which `loadPhotoSource` rejects (`isPrivateHost`). The scan then uses the viewport crop, not the original file. `createImageBitmap(bitmap, sx, sy, sw, sh)` is the crop that stays non-blank. Letterbox, rectify, and embed canvases need `willReadFrequently: true`.

## 19. Say the price once, and name the source in words

Two consumer bugs on an otherwise correct 15-card result:

- The printing menu and the empty price row both rendered `2 printings · $low–$high`. The menu already has the range. `renderConditionGrid` returns nothing until a printing is chosen.
- The source badge printed the raw id `pokemontcg`. CSS `text-transform: uppercase` turned that into `POKEMONTCG`. Use `sourceName()` (`TCGPlayer`, `JustTCG`, `Price Tracker`).
- Empty price dashes at `#22273d` on `#0b0c12` were invisible. `#8b92ab` matches the other secondary text.

A card with more than one printing is not added to the lot total until the user picks one. The popup says so (`Choose a printing on N…`).

## 20. What a consumer scan of this lot actually did

Photo: ShopGoodwill lot `279630564`, 15 fronts (Bulbasaur, Ivysaur, Charmander, Squirtle, Metapod, Grimer, Shellder, Squirtle, Sunflora, Voltorb, Loudred, Quagsire, Lickitung, Spearow, PlusPower).

After the bundled finder and the top-3 name vote, one live scan (`node tests/e2e/live-scan.mjs`, profile `data/extension-live-profile`) reported **15 detected, 13 named, ~10s**. Each named card showed a TCGPlayer printing range and the total stayed `—`. Sunflora came back via the name vote. PlusPower and the second Squirtle stayed unknown (top hits were PokéNav/Switch and Wynaut/Squirtle/Gible). Shellder was reported as Shelgon because the top three hits were all Shelgon. Sets are the closest visual match, not a confirmed collector number — the extension still passes `null` OCR into `fuseResults`.

Checks that passed after the change: `node --test tests/fusion.test.js tests/card-display.test.js` (10) and `npx playwright test tests/e2e/extension-wasm-popup.spec.js --project=extension` (2). Playwright loads `dist/extension-wasm`, so rebuild with `scripts/build-wasm-extension.ps1` before those tests. Nothing was committed, pushed, or published to the v2.0 release.

## 21. Price the extension from TCGdex, not keyless pokemontcg.io

On 2026-10-11, `api.pokemontcg.io/v2/cards/ex16-64` timed out after 30 s, so a user-picked set showed "no price data". `api.tcgdex.net/v2/en/cards/ex16-64` answered in under 5 s with that day's TCGPlayer prices (normal $0.46, reverse holo $9.99) and the TCGPlayer product id. TCGdex uses our catalog ids, so the lookup needs no id mapping. The server learned the same thing earlier (`src/pricing/tcgdex.js`).

Rule: the extension tries TCGdex first, then the JustTCG/Price Tracker grid, and calls pokemontcg.io only when TCGdex has no TCGPlayer price. A TCGdex card whose name, set, or number differs from the identity is discarded, so a wrong id cannot price a different card. TCG Pocket ids (`A1-…`, `B1-…`, `P-A-…`) are dropped from search hits before fusion; they cannot be bought or sold.

## 22. Neighbouring cards don't tell you the era; ask the user once

The recognizer leans toward modern printings: the true printing usually ranks 5–12 among same-name prints, 0.04–0.14 below the best. Voting with the other cards in the same photo makes this worse, because every card leans modern together (lot `279630564`, a 2004–2007 lot, voted Sun & Moon/Black & White/XY). Among printings of the true era, though, the true one ranks first on ~28 of 40 cards. So the era is a one-click user choice per lot, the name still comes from the full catalog, and only the printing is ranked inside the era. Putting HeartGold in the EX/DP era added wrong single answers; eras must match how the cards look, not just years.

## 23. The collector number beats the picture, but only on big cards

On a crop from a 3–4-card close-up (~750–1000 source pixels tall), RapidOCR reads "number/total" on 13 of 14 cards. At 600 px it reads 3 of 14; at whole-lot size (~380 px), none. So gate on source height, not on the rectified canvas (always 750×1050). A number is trusted only if a printing of that number exists in a set whose catalog count fits the printed total. That rejects misreads like "12/132" for 112/132 and "21/132" for 121/132. Detector boxes often run past the card's bottom edge, so try a taller strip when the bottom 12% has no number. Port checks: run the JS reader on the same crops as Python (`readCardNumber` in plain Chromium) before testing in the extension.

## 24. Never pipe a script that writes files into `Select-Object -First`

`node script.mjs write | Select-Object -First 1` stops the script once the first line is printed, before it writes its output. `lib/card-back.js` silently kept an old reference, and live checks failed for no visible reason. Use `| Out-Null` or `*> $null` for writer scripts. In PowerShell, `>` writes UTF-16, which Node's `JSON.parse` rejects.

## 25. Extension service workers can't be restarted from Playwright

`chrome.runtime.reload()` from `worker.evaluate` leaves Playwright without a new service worker (neither the event nor `serviceWorkers()` shows it). To change what the extension loads at startup (e.g. seeding the model cache), do it in a separate `launchPersistentContext`, close it, then launch again on the same profile.

## 26. A read number does not make the picture trustworthy

For cards nobody could name, ranking every catalog card that has the read number (in a set of fitting size, 11–65 candidates) by picture similarity looks tempting. Measured on 26 reads, it was right where the name path was already right, rescued one card, and put a wrong card first with a 0.036 lead (Duosion for Sunflora 38/132). The number narrows the set; it does not make a weak picture match strong. Keep number matches to the recognized name and its 20 closest look-alikes.

Related: a "wrong name" on a ~300 px card is usually a near-tie (top hit ahead by < 0.02) that tips differently when the crop changes slightly. Check the margins with the dumped embedding before changing fusion rules; the rule that tips Koffing to Gible is the one that makes Sunflora right.

## Default debugging recipe for this codebase

When a scan silently returns nothing:

1. **Wipe the script cache, then launch** — delete `Service Worker/ScriptCache`, `Extension Scripts`, and `Code Cache` under the profile, in a separate command from the browser launch. Do not delete `CacheStorage` (that is the downloaded models). If the first launch says the extension is not running, launch once more without deleting anything. See lesson 17.
2. **Hash `card_detect.onnx`** — local file vs Cache API vs the GitHub release. Same length can still be a different model. See lesson 16.
3. **Open the SW DevTools** manually (chrome://extensions → service worker inspect) or hook SW console in Playwright. Most silent failures surface as a thrown error there.
4. **Log the full response shape** in the popup — don't `JSON.stringify` just the fields you expect, log the whole object. An "empty" object usually means every field is `undefined`.
5. **Check model input shapes** — ONNX shape mismatches throw clear errors with "Got X Expected Y."
6. **Dump the overlay canvas** separately — `canvas.toDataURL("image/png")` → write to disk. If the overlay drew but didn't show in a page screenshot, the overlay is working and the issue is screenshot capture (DPR, viewport cropping, fullPage flag).
