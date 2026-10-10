// ES module service worker — card detection pipeline with local WASM inference.
// ort must be set on globalThis before any lib function is called.
import * as ort from "./vendor/ort.wasm.min.js";
globalThis.ort = ort;

// Single-threaded WASM to avoid SharedArrayBuffer / Worker restrictions in SW
try {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths  = chrome.runtime.getURL("vendor/");
} catch (e) {
  console.error("[BG] ORT env init failed:", e.message);
}

import { checkModelsReady, downloadModels, getAssetBuffer, getAssetJson } from "./lib/setup.js";
import { loadDetector, detectCards, setConfThreshold } from "./lib/detect.js";
import { filterPhotoDetections, imageToViewportTransform, mapPhotoBoxToViewport } from "./photo-detection.js";
import { loadEmbedder, embedCard }    from "./lib/embed.js";
import { rectifyCard }                 from "./lib/rectify.js";
import { loadCatalog, searchCatalog } from "./lib/search.js";
import { fuseResults }                 from "./lib/fusion.js";
import { getPrice, getFullCardPayload, extractTcgPlayerId } from "./lib/pricing.js";
import { getConditionGrid, fromPokemontcgPayload }          from "./lib/condition-pricing.js";

// ─── state ───────────────────────────────────────────────────────────────────

let _ready            = false;
let _loading          = false;
let _meta             = null;
let _idMap            = null;
let _popupWinId       = null;
let _targetTabId      = null;
let _autoScanInFlight = false;

// Persists _targetTabId across service-worker restarts (chrome.storage.session survives SW idle kills).
function _setTargetTabId(id) {
  _targetTabId = id;
  chrome.storage.session.set({ targetTabId: id }).catch(() => {});
}

// Returns true for browser-internal URLs that never have a content script.
function _isInternalUrl(url) {
  if (!url) return true;
  return url.startsWith("chrome-extension://")
      || url.startsWith("chrome://")
      || url.startsWith("about:")
      || url.startsWith("edge://")
      || url.startsWith("devtools://");
}

// Idempotently inject content.js so sendMessage can reach it. Safe to call repeatedly —
// content.js has its own `__cardScannerLoaded` guard against double-init.
async function _ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch {
    // Restricted URL (chrome://, store page) or activeTab not granted — nothing to do.
  }
}

// ─── icon click → open popup window (gets camera permission prompt) ──────────

chrome.action.onClicked.addListener(async () => {
  // Capture the tab the user is on RIGHT NOW, before focus switches to the popup window.
  // relayToTab uses this so overlay messages go to the correct page.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && !_isInternalUrl(activeTab.url)) {
    _setTargetTabId(activeTab.id);
    // Proactively inject content.js so the first scan can relay immediately — covers tabs
    // that were already open before the extension installed.
    chrome.scripting
      .executeScript({ target: { tabId: activeTab.id }, files: ["content.js"] })
      .catch(() => {});
  }

  if (_popupWinId !== null) {
    try {
      await chrome.windows.update(_popupWinId, { focused: true });
      return;
    } catch {
      _popupWinId = null;
    }
  }

  // After a SW restart _popupWinId is null even if the window still exists — find it.
  const popupUrl = chrome.runtime.getURL("popup.html");
  const [existingTab] = await chrome.tabs.query({ url: popupUrl });
  if (existingTab?.windowId != null) {
    _popupWinId = existingTab.windowId;
    try {
      await chrome.windows.update(_popupWinId, { focused: true });
      return;
    } catch {
      _popupWinId = null;
    }
  }

  // Keep the popup narrow and tall so it docks on the right without obscuring the page content.
  const win = await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    width: 440,
    height: 620,
    focused: true,
  });
  _popupWinId = win.id;
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === _popupWinId) _popupWinId = null;
});

// Keep _targetTabId current while the scanner popup is open.
// When the user switches tabs or navigates, the overlay follows automatically.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (_popupWinId === null) return;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (!_isInternalUrl(tab.url)) {
      _setTargetTabId(tabId);
    }
  });
});

// Clear the overlay when the target tab navigates to a new page, then re-target it.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== _targetTabId) return;
  if (changeInfo.status === "loading") {
    // Page is navigating — clear the old overlay reference so stale overlays
    // don't linger. The content script will reinject itself on the new page.
    chrome.tabs.sendMessage(tabId, { action: "clearOverlay" }).catch(() => {});
  }
});

// ─── startup ─────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(tryAutoLoad);
chrome.runtime.onInstalled.addListener(tryAutoLoad);

async function tryAutoLoad() {
  try {
    const { targetTabId } = await chrome.storage.session.get("targetTabId");
    if (targetTabId != null) _targetTabId = targetTabId;
  } catch {}
  const ready = await checkModelsReady();
  if (ready) await loadModels();
}

async function loadModels() {
  if (_ready || _loading) return;
  _loading = true;
  try {
    const [detectBuf, clipBuf, catalogBuf] = await Promise.all([
      getAssetBuffer("card_detect.onnx"),
      getAssetBuffer("clip_visual_int8.onnx"),
      getAssetBuffer("catalog.bin.gz"),
    ]);

    await loadDetector(detectBuf).catch(e => { throw new Error("detector: " + e.message); });
    await loadEmbedder(clipBuf).catch(e => { throw new Error("embedder: " + e.message); });
    await loadCatalog(catalogBuf).catch(e => { throw new Error("catalog: " + e.message); });

    [_meta, _idMap] = await Promise.all([
      getAssetJson("meta.json"),
      getAssetJson("id_map.json"),
    ]);

    _ready = true;
  } finally {
    _loading = false;
  }
}

// ─── message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case "checkReady":
      sendResponse({ ready: _ready });
      return false;

    case "startSetup":
      handleSetup(sendResponse);
      return true; // async

    case "detect":
      handleDetect(msg.imageB64, sendResponse);
      return true; // async

    case "scanPage":
      handleScanPage(sendResponse);
      return true; // async

    case "clearPageOverlay":
      relayToTab({ action: "relayClear" });
      sendResponse({ ok: true });
      return false;

    case "overlayWithGrid":
      // Popup forwards an overlay payload already enriched with display info
      // (filter-aware printing/condition/price). SW just relays to the content tab.
      relayToTab({
        action: "relayOverlay",
        cards: msg.cards,
        srcWidth: msg.srcWidth,
        srcHeight: msg.srcHeight,
      });
      sendResponse({ ok: true });
      return false;

    case "relayOverlay":
      relayToTab(msg);
      sendResponse({ ok: true });
      return false;

    case "relayClear":
      relayToTab(msg);
      sendResponse({ ok: true });
      return false;

    case "newCardsDetected":
      // Content script saw new card-shaped images load (lazy/infinite scroll).
      // Re-scan only when the popup is open, models are ready, and no scan is running.
      if (_popupWinId !== null && _ready && !_autoScanInFlight) {
        _autoScanInFlight = true;
        handleScanPage(() => { _autoScanInFlight = false; });
      }
      return false;
  }
});

// ─── setup ───────────────────────────────────────────────────────────────────

async function handleSetup(sendResponse) {
  try {
    await downloadModels((progress) => {
      // Forward progress to popup
      chrome.runtime.sendMessage({ action: "setupProgress", ...progress }).catch(() => {});
    });
    await loadModels();
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
}

// ─── page scan ───────────────────────────────────────────────────────────────

async function handleScanPage(sendResponse) {
  console.log("[BG] handleScanPage start; _ready =", _ready, "_targetTabId =", _targetTabId);
  if (!_ready) {
    sendResponse({ error: "Models not loaded" });
    return;
  }

  // Resolve a scannable target tab — fall back to the most-recent non-popup active tab.
  let targetTab = null;
  if (_targetTabId !== null) {
    try { targetTab = await chrome.tabs.get(_targetTabId); } catch { targetTab = null; }
  }
  if (!targetTab || _isInternalUrl(targetTab.url) || targetTab.windowId === _popupWinId) {
    const candidates = await chrome.tabs.query({ windowType: "normal" }).catch(() => []);
    const normalWindows = candidates.filter((t) => t.windowId !== _popupWinId && !_isInternalUrl(t.url));
    normalWindows.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    targetTab = normalWindows[0] ?? null;
    if (targetTab) _setTargetTabId(targetTab.id);
  }
  if (!targetTab) {
    sendResponse({ error: "No scannable tab — open a webpage first" });
    return;
  }
  console.log("[BG] scanning tab", targetTab.id, "url", targetTab.url, "window", targetTab.windowId);

  try {
    // Make sure the content script is live, then ask it which images look like cards.
    await _ensureContentScript(targetTab.id);
    const domResp = await chrome.tabs.sendMessage(targetTab.id, { action: "findCards" }).catch((e) => ({ error: e.message }));
    if (domResp?.error) {
      sendResponse({ error: "Could not query page for cards: " + domResp.error });
      return;
    }
    const domCards = domResp?.cards || [];
    console.log("[BG] DOM finder returned", domCards.length, "card-shaped images");

    // Capture viewport once; we'll crop each DOM rect from it.
    const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, { format: "jpeg", quality: 92 });
    const b64 = dataUrl.split(",")[1];
    const bitmap = await b64ToBitmap(b64);
    // Prefer actual-vs-viewport ratio over DOM-reported devicePixelRatio — some
    // environments (Playwright + Windows HiDPI) report dpr=1 but still capture at 1.5x.
    const dprReported = Number(domResp.devicePixelRatio) || 1;
    const dprMeasured = domResp.viewportWidth ? bitmap.width / domResp.viewportWidth : dprReported;
    const dpr = Math.abs(dprMeasured - dprReported) < 0.05 ? dprReported : dprMeasured;
    console.log("[BG] bitmap", bitmap.width + "x" + bitmap.height, "viewport", domResp.viewportWidth + "x" + domResp.viewportHeight, "dpr reported", dprReported, "measured", dprMeasured.toFixed(3), "using", dpr.toFixed(3));

    const cards = [];
    const preemptedPhotoKeys = new Set();

    // ── Multi-card photo split ────────────────────────────────────────────
    // Walk every DOM-flagged photo candidate (any sufficiently large image),
    // run YOLO inside it. When ≥ 2 cards are detected we treat it as a lot /
    // multi-card photo and skip the single-card interpretation below.
    const photos = domResp?.photos || [];
    if (photos.length) console.log("[BG]", photos.length, "photo candidates — running YOLO inside each");
    for (const ph of photos) {
      const sx = Math.max(0, Math.round(ph.rect.vx * dpr));
      const sy = Math.max(0, Math.round(ph.rect.vy * dpr));
      const sw = Math.min(bitmap.width  - sx, Math.round(ph.rect.vw * dpr));
      const sh = Math.min(bitmap.height - sy, Math.round(ph.rect.vh * dpr));
      if (sw < 150 || sh < 150) continue;
      let photoBitmap = null;
      let fromSource = false;
      let sourceTransform = null;
      try {
        const sourceCanMap = ph.render?.fit !== "background" || ph.render?.repeat === "no-repeat";
        photoBitmap = sourceCanMap ? await loadPhotoSource(ph.src) : null;
        if (photoBitmap) {
          sourceTransform = imageToViewportTransform(ph.rect, photoBitmap.width, photoBitmap.height, ph.render || {});
          if (!sourceTransform) {
            photoBitmap.close();
            photoBitmap = null;
          } else {
            fromSource = true;
          }
        }
        if (!photoBitmap) {
          photoBitmap = await createImageBitmap(await cropViewport(bitmap, sx, sy, sw, sh));
        }
        setConfThreshold(0.12);
        let detectedBoxes;
        try {
          detectedBoxes = await detectCards(photoBitmap);
        } finally {
          setConfThreshold(0.25);
        }
        const imageW = photoBitmap.width;
        const imageH = photoBitmap.height;
        const boxes = filterPhotoDetections(detectedBoxes, imageW, imageH);
        console.log("[BG]   photo", (ph.rect.x | 0) + "," + (ph.rect.y | 0),
                    imageW + "x" + imageH, fromSource ? "(source image)" : "(viewport crop)", "→ YOLO returned", detectedBoxes.length,
                    "boxes;", boxes.length, "passed card-size validation",
                    boxes.length ? "(scores: " + boxes.map(b => b.score.toFixed(2)).join(",") + ")" : "");

        if (!boxes.length) continue;
        console.log("[BG]   splitting", boxes.length, "cards");
        preemptedPhotoKeys.add(_photoKey(ph));
        for (const { box, score } of boxes) {
          const [bx1, by1, bx2, by2] = box;
          if ((bx2 - bx1) < 40 || (by2 - by1) < 60) continue;
          let viewportBox;
          let cardCanvas;
          if (fromSource) {
            viewportBox = mapPhotoBoxToViewport(box, sourceTransform, ph.rect);
            if (!viewportBox) continue;
            cardCanvas = rectifyCard(photoBitmap, box);
          } else {
            viewportBox = [sx + bx1, sy + by1, sx + bx2, sy + by2].map((v) => v / dpr);
            cardCanvas = rectifyCard(bitmap, [sx + bx1, sy + by1, sx + bx2, sy + by2]);
          }
          const embedding  = await embedCard(cardCanvas);
          const hits       = searchCatalog(embedding, 20);
          const { identity, confidence, abstain } = fuseResults(hits, null, _meta, _idMap);
          let finalIdentity = identity, priceGrid = null, legacyMarket = null, legacyVariant = null;
          if (!abstain && identity) {
            const picked = await pickPricingIdentity(identity, hits);
            if (picked) { finalIdentity = picked.identity; legacyMarket = picked.legacyPrice; legacyVariant = picked.legacyVariant; priceGrid = picked.grid; }
          }
          cards.push({
            box: viewportBox,
            score, identity: finalIdentity, confidence, abstain,
            market_price: legacyMarket, price_variant: legacyVariant, price_grid: priceGrid,
            via: "yolo-in-photo",
          });
        }
      } catch (err) { console.error("[BG] YOLO-in-photo failed:", err?.message || err); }
      finally { photoBitmap?.close?.(); }
    }

    for (const dc of domCards) {
      // Skip the single-card interpretation when this image was already split by YOLO
      // into multiple cards (handled above). Compare by key constructed the same way.
      if (preemptedPhotoKeys.has(_photoKey(dc))) continue;

      // Crop the visible slice of this image in physical pixels.
      const sx = Math.max(0, Math.round(dc.rect.vx * dpr));
      const sy = Math.max(0, Math.round(dc.rect.vy * dpr));
      const sw = Math.min(bitmap.width  - sx, Math.round(dc.rect.vw * dpr));
      const sh = Math.min(bitmap.height - sy, Math.round(dc.rect.vh * dpr));
      if (sw < 20 || sh < 30) continue;

      // Build the 750x1050 rectified canvas the embedder expects.
      const cardCanvas = rectifyCard(bitmap, [sx, sy, sx + sw, sy + sh]);
      const embedding  = await embedCard(cardCanvas);
      const hits       = searchCatalog(embedding, 20);
      const top5 = hits.slice(0, 5).map((h) => `${_idMap[h.index]}@${h.score.toFixed(3)}`).join(" ");
      console.log("[BG] crop", sx, sy, sw, sh, "top5:", top5);
      const { identity, confidence, abstain } = fuseResults(hits, null, _meta, _idMap);

      // Resolve a pricing identity: top-1 by default, falling back to a same-named
      // top-K candidate if the picked one has no market data. Then enrich with the full
      // per-condition grid (NM/LP/MP/HP/DMG) and graded prices from JustTCG/PPT.
      let finalIdentity = identity;
      let priceGrid     = null;         // full {variants, graded, defaultVariant, spreadRatio}
      let legacyMarket  = null;
      let legacyVariant = null;

      if (!abstain && identity) {
        const picked = await pickPricingIdentity(identity, hits);
        if (picked) {
          finalIdentity = picked.identity;
          legacyMarket  = picked.legacyPrice;
          legacyVariant = picked.legacyVariant;
          priceGrid     = picked.grid;
        }
      }

      cards.push({
        box: [dc.rect.x, dc.rect.y, dc.rect.x + dc.rect.w, dc.rect.y + dc.rect.h],
        score: 1.0,
        identity: finalIdentity, confidence, abstain,
        market_price:  legacyMarket,
        price_variant: legacyVariant,
        price_grid:    priceGrid,
      });
    }

    // ── Fallback: YOLO viewport scan ───────────────────────────────────────
    // Last resort — a page with no <img> cards and no photo candidates
    // (CSS backgrounds, canvas renders, lightbox overlays).
    if (cards.length === 0) {
      try {
        console.log("[BG] still nothing — running YOLO over whole viewport");
        const yoloBoxes = await detectCards(bitmap);
        console.log("[BG] YOLO found", yoloBoxes.length, "boxes in viewport");
        for (const { box, score } of yoloBoxes) {
          const [x1, y1, x2, y2] = box;
          if ((x2 - x1) < 40 || (y2 - y1) < 60) continue;
          const cardCanvas = rectifyCard(bitmap, box);
          const embedding  = await embedCard(cardCanvas);
          const hits       = searchCatalog(embedding, 20);
          const { identity, confidence, abstain } = fuseResults(hits, null, _meta, _idMap);
          let finalIdentity = identity;
          let priceGrid = null, legacyMarket = null, legacyVariant = null;
          if (!abstain && identity) {
            const picked = await pickPricingIdentity(identity, hits);
            if (picked) { finalIdentity = picked.identity; legacyMarket = picked.legacyPrice; legacyVariant = picked.legacyVariant; priceGrid = picked.grid; }
          }
          cards.push({
            box: [x1 / dpr, y1 / dpr, x2 / dpr, y2 / dpr],
            score,
            identity: finalIdentity, confidence, abstain,
            market_price: legacyMarket, price_variant: legacyVariant, price_grid: priceGrid,
            via: "yolo-viewport",
          });
        }
      } catch (err) {
        console.error("[BG] YOLO viewport fallback failed:", err?.message || err);
      }
    }

    bitmap.close();
    const identified = cards.filter((c) => !c.abstain).length;
    console.log("[BG] identified", identified, "/", cards.length, "cards");

    // srcWidth/Height = viewport (CSS px) because box coords are already in CSS px.
    const srcWidth  = domResp.viewportWidth  || Math.round(bitmap.width  / dpr);
    const srcHeight = domResp.viewportHeight || Math.round(bitmap.height / dpr);
    await relayToTab({ action: "relayOverlay", cards, srcWidth, srcHeight });
    console.log("[BG] overlay relayed");

    // Ask the content script to start watching for lazy-loaded card images.
    chrome.tabs.sendMessage(targetTab.id, { action: "startObserving" }).catch(() => {});

    sendResponse({ cards, srcWidth, srcHeight, targetTabId: targetTab.id });
  } catch (err) {
    console.error("[BG] handleScanPage error:", err?.message || err);
    sendResponse({ error: String(err?.message || err) });
  }
}

// ─── detection ───────────────────────────────────────────────────────────────

async function handleDetect(imageB64, sendResponse) {
  if (!_ready) {
    sendResponse({ error: "Models not loaded" });
    return;
  }

  try {
    const bitmap  = await b64ToBitmap(imageB64);
    const rawBoxes = await detectCards(bitmap);

    // Sequential — single-threaded WASM cannot handle concurrent session.run() calls
    const cards = [];
    for (const { box, score } of rawBoxes) {
      const cardCanvas = rectifyCard(bitmap, box);
      const embedding  = await embedCard(cardCanvas);
      const hits       = searchCatalog(embedding, 20);
      const { identity, confidence, abstain } = fuseResults(hits, null, _meta, _idMap);
      const priceData  = abstain ? null : await getPrice(identity);
      const market_price  = priceData?.price  ?? null;
      const price_variant = priceData?.variant ?? null;

      cards.push({ box, score, identity, confidence, abstain, market_price, price_variant });
    }

    const { width, height } = bitmap;
    bitmap.close(); // release GPU-backed bitmap memory
    sendResponse({ cards, srcWidth: width, srcHeight: height });
  } catch (err) {
    sendResponse({ error: String(err) });
  }
}

// ─── tab relay ───────────────────────────────────────────────────────────────

async function relayToTab(msg) {
  if (_targetTabId === null) {
    const tabs = await chrome.tabs.query({ active: true }).catch(() => []);
    const candidate = tabs.find(t => !_isInternalUrl(t.url) && t.windowId !== _popupWinId);
    if (candidate) _setTargetTabId(candidate.id);
  }
  if (_targetTabId === null) return;
  const relayMsg = msg.action === "relayOverlay"
    ? { action: "showOverlay", cards: msg.cards, srcWidth: msg.srcWidth, srcHeight: msg.srcHeight }
    : { action: "clearOverlay" };
  try {
    await chrome.tabs.sendMessage(_targetTabId, relayMsg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: _targetTabId }, files: ["content.js"] });
      chrome.tabs.sendMessage(_targetTabId, relayMsg).catch(() => {});
    } catch { /* restricted URL */ }
  }
}

// Stable key for a photo/image rect so the multi-card preemption set can
// cross-match a photo-list entry against the sibling card-list entry.
function _photoKey(entry) {
  const r = entry?.rect || {};
  return `${Math.round(r.x || 0)},${Math.round(r.y || 0)},${Math.round(r.w || 0)}x${Math.round(r.h || 0)}`;
}

// ─── pricing resolver ────────────────────────────────────────────────────────

/**
 * Decide which catalog identity owns the price for this scan + fetch its full price grid.
 * Walks top-K candidates when the top-1 identity returns nothing. Returns:
 *   { identity, legacyPrice, legacyVariant, grid } | null
 */
async function pickPricingIdentity(topIdentity, hits) {
  const candidates = [];
  candidates.push(topIdentity);
  for (const h of hits.slice(0, 10)) {
    const cand = _meta[h.index];
    if (!cand || cand.id === topIdentity.id) continue;
    if (cand.name !== topIdentity.name) continue;
    candidates.push(cand);
  }

  for (const cand of candidates) {
    const full = await getFullCardPayload(cand.id);
    const prices = full?.tcgplayer?.prices;
    const tcgPlayerId = extractTcgPlayerId(full?.tcgplayer?.url);
    // Prefer the richer grid from condition-pricing (backend/PPT); fall back to pokemontcg.io variants.
    let grid = await getConditionGrid({ ...cand, tcgPlayerId });
    if (!grid) grid = fromPokemontcgPayload(prices);

    const legacyPrice   = extractLegacyPrice(prices);
    if (grid || legacyPrice) {
      return {
        identity: cand,
        legacyPrice:   legacyPrice?.price   ?? null,
        legacyVariant: legacyPrice?.variant ?? null,
        grid: grid || null,
      };
    }
  }
  return null;
}

const _LEGACY_VARIANT_ORDER = [
  "holofoil", "reverseHolofoil", "normal", "1stEditionHolofoil", "1stEditionNormal",
];
function extractLegacyPrice(prices) {
  if (!prices) return null;
  for (const variant of _LEGACY_VARIANT_ORDER) {
    const p = prices[variant]?.market ?? prices[variant]?.mid;
    if (p != null) return { price: p, variant };
  }
  for (const variant of Object.keys(prices)) {
    const p = prices[variant]?.market ?? prices[variant]?.mid;
    if (p != null) return { price: p, variant };
  }
  return null;
}

// ─── util ─────────────────────────────────────────────────────────────────────

async function b64ToBitmap(b64) {
  const binary   = atob(b64);
  const bytes    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob     = new Blob([bytes], { type: "image/jpeg" });
  return createImageBitmap(blob);
}

async function loadPhotoSource(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHost(url.hostname)) return null;
  try {
    const response = await fetch(url.href, { credentials: "omit", redirect: "follow", cache: "force-cache" });
    let finalUrl;
    try { finalUrl = new URL(response.url); } catch { return null; }
    if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password || isPrivateHost(finalUrl.hostname)) return null;
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/")) return null;
    const declaredSize = Number(response.headers.get("content-length")) || 0;
    if (declaredSize > 20 * 1024 * 1024) return null;
    const blob = await response.blob();
    if (blob.size > 20 * 1024 * 1024 || !blob.type.toLowerCase().startsWith("image/")) return null;
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width > 10000 || bitmap.height > 10000) {
      bitmap.close();
      return null;
    }
    return bitmap;
  } catch {
    // Cross-origin sources without CORS access use the already captured viewport crop.
    return null;
  }
}

function isPrivateHost(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || value === "0.0.0.0" ||
    value.endsWith(".local") || value.endsWith(".internal") || /^(fc|fd|fe80):/.test(value) ||
    /^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value) ||
    /^169\.254\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
}

function cropViewport(bitmap, sx, sy, sw, sh) {
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}
