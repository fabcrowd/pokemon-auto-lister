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

## Default debugging recipe for this codebase

When a scan silently returns nothing:

1. **Wipe the profile** — `rm -rf .tmp/ship-profile` — rule out stale SW cache.
2. **Open the SW DevTools** manually (chrome://extensions → service worker inspect) or hook SW console in Playwright. Most silent failures surface as a thrown error there.
3. **Log the full response shape** in the popup — don't `JSON.stringify` just the fields you expect, log the whole object. An "empty" object usually means every field is `undefined`.
4. **Check model input shapes** — ONNX shape mismatches throw clear errors with "Got X Expected Y."
5. **Dump the overlay canvas** separately — `canvas.toDataURL("image/png")` → write to disk. If the overlay drew but didn't show in a page screenshot, the overlay is working and the issue is screenshot capture (DPR, viewport cropping, fullPage flag).
