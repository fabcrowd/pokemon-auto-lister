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

import { checkModelsReady, downloadModels, getAssetBuffer, getAssetJson, getOptionalAsset } from "./lib/setup.js";
import { loadDetector, detectCards, getConfThreshold, setConfThreshold } from "./lib/detect.js";
import { filterPhotoDetections, imageToViewportTransform, mapPhotoBoxToViewport } from "./photo-detection.js";
import { loadEmbedder, embedCard }    from "./lib/embed.js";
import { rectifyCard }                 from "./lib/rectify.js";
import { loadCatalog, searchCatalog, physicalHits, scoreIndices } from "./lib/search.js";
import { fuseResults }                 from "./lib/fusion.js";
import { setChoices, choiceName }      from "./lib/set-choice.js";
import { eraById, eraPrintings, inEra } from "./lib/era.js";
import { isCardBack }                  from "./lib/card-back.js";
import { loadNumberReader, readCardNumber } from "./lib/ocr.js";
import { setSizes, printingByNumber }  from "./lib/card-number.js";
import { publicHttpsUrl }              from "./lib/net.js";
import { FIRST_EDITION_MIN_SCORE, grayFromRgba, hasFirstEdition, stampScore } from "./lib/edition-stamp.js";
import { getPrice, getFullCardPayload, extractTcgPlayerId, getTcgdexCard } from "./lib/pricing.js";
import {
  getConditionGrid, fromPokemontcgPayload, fromTcgdexPayload, tcgPlayerIdFromTcgdex,
} from "./lib/condition-pricing.js";

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
    width: 500,
    height: 680,
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

// The SW is killed after ~30s idle while the popup window stays open, so every
// entry point that needs models must reload them from cache first.
async function _ensureReady(sendResponse) {
  try {
    if (!_ready) await tryAutoLoad();
  } catch (err) {
    console.error("[BG] model reload failed", err?.message || err);
    sendResponse({ error: String(err?.message || err) });
    return false;
  }
  if (!_ready) sendResponse({ error: "Models not loaded" });
  return _ready;
}

let _loadPromise = null;

async function loadModels() {
  if (_ready) return;
  if (_loadPromise) return _loadPromise;
  _loading = true;
  _loadPromise = (async () => {
    const [detectBuf, clipBuf, catalogBuf] = await Promise.all([
      getAssetBuffer("card_detect.onnx"),
      getAssetBuffer("clip_visual_int8.onnx"),
      getAssetBuffer("catalog.bin.gz"),
    ]);

    await loadDetector(detectBuf).catch(e => { throw new Error("detector (" + detectBuf.byteLength + " bytes): " + e.message); });
    await loadEmbedder(clipBuf).catch(e => { throw new Error("embedder: " + e.message); });
    await loadCatalog(catalogBuf).catch(e => { throw new Error("catalog: " + e.message); });

    [_meta, _idMap] = await Promise.all([
      getAssetJson("meta.json"),
      getAssetJson("id_map.json"),
    ]);

    _ready = true;
    _loadNumberReader();
  })();
  try {
    await _loadPromise;
  } finally {
    _loading = false;
    _loadPromise = null;
  }
}

let _numberReader = null;

// Scans run without the number reader until its files are cached.
function _loadNumberReader() {
  _numberReader ??= (async () => {
    const [det, rec] = await Promise.all([getOptionalAsset("ocr_det.onnx"), getOptionalAsset("ocr_rec.onnx")]);
    if (!det || !rec) {
      console.log("[BG] number reader not available");
      return;
    }
    await loadNumberReader(det, rec);
    console.log("[BG] number reader loaded");
  })().catch((err) => console.error("[BG] number reader failed:", err?.message || err));
}

// ─── message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case "checkReady":
      // The service worker starts blank after Chrome suspends it. Models stay
      // in the cache, so a later visit should come back ready without another download.
      (async () => {
        try {
          if (!_ready) await tryAutoLoad();
          sendResponse({ ready: _ready });
        } catch (err) {
          console.error("[BG] checkReady failed", err?.message || err);
          sendResponse({ ready: false, error: String(err?.message || err) });
        }
      })();
      return true;

    case "startSetup":
      handleSetup(sendResponse);
      return true; // async

    case "detect":
      handleDetect(msg.imageB64, sendResponse);
      return true; // async

    case "priceCard":
      handlePriceCard(msg.id, sendResponse);
      return true;

    case "scanPage":
      handleScanPage(sendResponse, eraById(msg.era));
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

async function handleScanPage(sendResponse, era) {
  console.log("[BG] handleScanPage start; _ready =", _ready, "_targetTabId =", _targetTabId, "era =", era?.id || "any");
  if (!(await _ensureReady(sendResponse))) return;

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
    let domResp = await chrome.tabs.sendMessage(targetTab.id, { action: "findCards" }).catch((e) => ({ error: e.message }));
    if (domResp?.error) {
      sendResponse({ error: "Could not query page for cards: " + domResp.error });
      return;
    }
    // Marketplace pages often paint the card frame before the photo arrives.
    // Scanning then would report "no cards" and run detection on a blank image.
    if ((domResp.pending || 0) > 0 && !(domResp.cards?.length) && !(domResp.photos?.length)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const again = await chrome.tabs.sendMessage(targetTab.id, { action: "findCards" }).catch((e) => ({ error: e.message }));
      if (!again?.error) domResp = again;
    }
    if (!(domResp.cards?.length) && !(domResp.photos?.length) && (domResp.pending || 0) > 0) {
      sendResponse({ error: "Card pictures are still loading. Scan again in a moment." });
      return;
    }
    const domCards = domResp?.cards || [];
    console.log("[BG] DOM finder returned", domCards.length, "card-shaped images");

    // The tab may have changed while the content script was answering. Capturing now would
    // crop one page's boxes out of another page's pixels.
    const freshTab = await chrome.tabs.get(targetTab.id).catch(() => null);
    if (!freshTab?.active || freshTab.windowId !== targetTab.windowId) {
      sendResponse({ error: "That tab is no longer in front. Scan again." });
      return;
    }
    targetTab = freshTab;
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
          photoBitmap = await createImageBitmap(bitmap, sx, sy, sw, sh);
        }
        const previousThreshold = getConfThreshold();
        setConfThreshold(0.12);
        let detectedBoxes;
        try {
          detectedBoxes = await detectCards(photoBitmap);
        } finally {
          setConfThreshold(previousThreshold);
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
          cards.push({ box: viewportBox, score, ...(await identifyCard(cardCanvas, era, by2 - by1)), via: "yolo-in-photo" });
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
      cards.push({
        box: [dc.rect.x, dc.rect.y, dc.rect.x + dc.rect.w, dc.rect.y + dc.rect.h],
        score: 1.0,
        ...(await identifyCard(cardCanvas, era, sh)),
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
          cards.push({
            box: [x1 / dpr, y1 / dpr, x2 / dpr, y2 / dpr],
            score,
            ...(await identifyCard(cardCanvas, era, y2 - y1)),
            via: "yolo-viewport",
          });
        }
      } catch (err) {
        console.error("[BG] YOLO viewport fallback failed:", err?.message || err);
      }
    }

    const identified = cards.filter((c) => !c.abstain).length;
    console.log("[BG] identified", identified, "/", cards.length, "cards");

    // Read the bitmap before closing it. A missing viewport size used to throw
    // after close() and the scan died after the cards were already found.
    const srcWidth  = domResp.viewportWidth  || Math.round(bitmap.width  / dpr);
    const srcHeight = domResp.viewportHeight || Math.round(bitmap.height / dpr);
    bitmap.close();
    await relayToTab({ action: "relayOverlay", cards, srcWidth, srcHeight }, targetTab.id);
    console.log("[BG] overlay relayed");

    // Ask the content script to start watching for lazy-loaded card images.
    chrome.tabs.sendMessage(targetTab.id, { action: "startObserving" }).catch(() => {});

    sendResponse({ cards, srcWidth, srcHeight, targetTabId: targetTab.id, pending: domResp.pending || 0 });
  } catch (err) {
    console.error("[BG] handleScanPage error:", err?.message || err);
    sendResponse({ error: String(err?.message || err) });
  }
}

// ─── detection ───────────────────────────────────────────────────────────────

async function handleDetect(imageB64, sendResponse) {
  if (!(await _ensureReady(sendResponse))) return;

  try {
    const bitmap  = await b64ToBitmap(imageB64);
    const rawBoxes = await detectCards(bitmap);

    // Sequential — single-threaded WASM cannot handle concurrent session.run() calls
    const cards = [];
    for (const { box, score } of rawBoxes) {
      const cardCanvas = rectifyCard(bitmap, box);
      const embedding  = await embedCard(cardCanvas);
      const hits       = physicalHits(searchCatalog(embedding, 20), _meta);
      if (isCardBack(embedding, hits[0]?.score ?? 0)) {
        cards.push({ box, score, identity: null, confidence: 0, abstain: true, cardBack: true, market_price: null, price_variant: null });
        continue;
      }
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

async function relayToTab(msg, tabId = null) {
  if (tabId != null) _setTargetTabId(tabId);
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

// Source pixels of card height; below this the stamp is a few blurry pixels.
const STAMP_MIN_HEIGHT = 400;
const STAMP_CARD_W = 375;
const STAMP_CARD_H = 525;

/**
 * Recognize one card, then look for the 1st Edition stamp when its set (or any set
 * the user may pick) was printed in 1st Edition. `firstEdition` stays unset otherwise.
 * A stamp rules out the set choices that never had a 1st Edition.
 */
async function identifyCard(cardCanvas, era = null, sourceHeight = 0) {
  const result = await recognizeCard(cardCanvas, era, sourceHeight);
  const setCodes = result.setChoices ? result.setChoices.map((c) => c.setCode) : [result.identity?.setCode];
  if (sourceHeight < STAMP_MIN_HEIGHT || !setCodes.some(hasFirstEdition)) return result;
  result.firstEdition = hasFirstEditionStamp(cardCanvas);
  if (!result.firstEdition || !result.setChoices) return result;
  const stamped = result.setChoices.filter((c) => hasFirstEdition(c.setCode));
  if (stamped.length !== 1) return { ...result, setChoices: stamped.length ? stamped : result.setChoices };
  const identity = catalogCard(stamped[0].id);
  if (!identity) return { ...result, setChoices: stamped };
  return { ...result, identity, setChoices: undefined, ...(await priceIdentity(identity)) };
}

function hasFirstEditionStamp(cardCanvas) {
  const small = new OffscreenCanvas(STAMP_CARD_W, STAMP_CARD_H);
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cardCanvas, 0, 0, STAMP_CARD_W, STAMP_CARD_H);
  const { data } = ctx.getImageData(0, 0, STAMP_CARD_W, STAMP_CARD_H);
  const score = stampScore(grayFromRgba(data, STAMP_CARD_W, STAMP_CARD_H), STAMP_CARD_W, STAMP_CARD_H);
  console.log("[BG] 1st Edition stamp", score.toFixed(3));
  return score >= FIRST_EDITION_MIN_SCORE;
}

/**
 * Recognize one rectified card. When close matches come from more than one set,
 * the card is not priced: the user picks the set and the popup asks "priceCard".
 */
async function recognizeCard(cardCanvas, era = null, sourceHeight = 0) {
  const embedding = await embedCard(cardCanvas);
  const hits = physicalHits(searchCatalog(embedding, 20), _meta);
  if (isCardBack(embedding, hits[0]?.score ?? 0)) {
    return { identity: null, confidence: 0, abstain: true, cardBack: true, market_price: null, price_variant: null, price_grid: null };
  }
  const { identity, confidence, abstain } = fuseResults(hits, null, _meta, _idMap);
  const unpriced = { market_price: null, price_variant: null, price_grid: null };
  const named = abstain || !identity ? null : identity.name;
  const numbered = sourceHeight >= NUMBER_MIN_HEIGHT ? await printingFromNumber(cardCanvas, named, hits) : null;
  if (numbered) {
    return { identity: numbered.card, confidence, abstain: false, numberRead: numbered.read, ...(await priceIdentity(numbered.card)) };
  }
  if (!named) return { identity, confidence, abstain, ...unpriced };

  const eraRows = era ? eraPrintingsOf(identity.name, era) : null;
  // The user said when these cards are from; a name never printed then was misread.
  if (eraRows && !eraRows.length) return { identity: null, confidence, abstain: true, ...unpriced };
  const inPeriod = eraRows ? eraPrintings(scoreIndices(embedding, eraRows)) : null;
  if (inPeriod?.pick != null) {
    const picked = _meta[inPeriod.pick];
    return { identity: picked, confidence, abstain, ...(await priceIdentity(picked)) };
  }
  const choices = inPeriod?.choices
    ? inPeriod.choices.map((index) => _meta[index])
    : setChoices(identity, hits, _meta);
  if (choices.length > 1) {
    return {
      identity: { name: identity.name },
      confidence,
      abstain,
      setChoices: choices.map(({ id, name, set, setCode, number }) => ({ id, name, set, setCode, number })),
      ...unpriced,
    };
  }
  return { identity, confidence, abstain, ...(await priceIdentity(identity)) };
}

let _indicesByName = null;
/** Catalog rows with this card name (set-choice spelling). */
function printingsOf(name) {
  if (!_indicesByName) {
    _indicesByName = new Map();
    _meta.forEach((card, index) => {
      const key = choiceName(card.name);
      if (!_indicesByName.has(key)) _indicesByName.set(key, []);
      _indicesByName.get(key).push(index);
    });
  }
  return _indicesByName.get(choiceName(name)) || [];
}

/** Catalog rows with this card name whose printing is in the era. */
function eraPrintingsOf(name, era) {
  return printingsOf(name).filter((index) => inEra(_meta[index], era));
}

// Source pixels of card height; below this the number does not read (measured on ShopGoodwill lots).
const NUMBER_MIN_HEIGHT = 600;
let _setSizes = null;

/**
 * The printing named by the collector number on the card, or null. Printings of the
 * recognized name come first, then the closest-looking cards (the name may be wrong).
 */
async function printingFromNumber(cardCanvas, name, hits) {
  const read = await readCardNumber(cardCanvas);
  if (!read?.number) {
    if (read) console.log("[BG] no number in", JSON.stringify(read.text));
    return null;
  }
  _setSizes ??= setSizes(_meta);
  const namedRows = name
    ? physicalHits(printingsOf(name).map((index) => ({ index })), _meta).map(({ index }) => _meta[index])
    : [];
  const lookalikes = [...new Map(hits.map(({ index }) => [_meta[index].id, _meta[index]])).values()];
  for (const rows of [namedRows, lookalikes]) {
    const at = printingByNumber(rows, read, _setSizes);
    if (at == null) continue;
    console.log("[BG] number", JSON.stringify(read.text), "→", rows[at].id, rows === namedRows ? "" : "(look-alike of " + (name ?? "unknown card") + ")");
    return { card: rows[at], read: `${read.number}/${read.total}` };
  }
  console.log("[BG] number", JSON.stringify(read.text), "→ no printing of", name);
  return null;
}

/** Price exactly this catalog card. Never substitutes another printing. */
async function priceIdentity(identity) {
  // TCGdex is keyed by our catalog id and answers when pokemontcg.io's keyless tier times out.
  const tcgdex = await getTcgdexCard(identity.id);
  const tcgdexGrid = fromTcgdexPayload(tcgdex, identity);
  const full = tcgdexGrid ? null : await getFullCardPayload(identity.id);
  const prices = full?.tcgplayer?.prices;
  const tcgPlayerId = tcgPlayerIdFromTcgdex(tcgdex) ?? extractTcgPlayerId(full?.tcgplayer?.url);
  // Prefer the richer grid from condition-pricing (backend/PPT), then TCGdex, then pokemontcg.io.
  let grid = await getConditionGrid({ ...identity, tcgPlayerId });
  if (!grid) grid = tcgdexGrid || fromPokemontcgPayload(prices, full?.tcgplayer?.updatedAt);
  const legacyPrice = extractLegacyPrice(prices);
  return {
    market_price: legacyPrice?.price ?? null,
    price_variant: legacyPrice?.variant ?? null,
    price_grid: grid || null,
  };
}

let _metaById = null;
function catalogCard(id) {
  _metaById ??= new Map(_meta.map((card) => [card.id, card]));
  return _metaById.get(id);
}

async function handlePriceCard(id, sendResponse) {
  if (!(await _ensureReady(sendResponse))) return;
  try {
    const identity = catalogCard(id);
    if (!identity) {
      sendResponse({ error: "That card isn't in the catalog." });
      return;
    }
    sendResponse({ identity, ...(await priceIdentity(identity)) });
  } catch (err) {
    console.error("[BG] priceCard failed", err?.message || err);
    sendResponse({ error: "Couldn't get a price. Try again." });
  }
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
  let current = publicHttpsUrl(rawUrl);
  if (!current) return null;
  try {
    let response;
    for (let hop = 0; hop < 4; hop++) {
      response = await fetch(current.href, { credentials: "omit", redirect: "manual", cache: "force-cache" });
      if (response.type === "opaqueredirect") return null;
      if (response.status < 300 || response.status >= 400) break;
      const next = publicHttpsUrl(response.headers.get("location") || "", current);
      if (!next) return null;
      current = next;
      response = null;
    }
    if (!response?.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/")) return null;
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