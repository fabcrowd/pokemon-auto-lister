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

import { checkModelsReady, downloadModels, getAssetBuffer, getAssetJson, getOptionalAsset, pruneOldCaches } from "./lib/setup.js";
import { loadDetector, detectCards, getConfThreshold, setConfThreshold } from "./lib/detect.js";
import { acceptWholePhoto, displayedRegion, extendClippedBottom, filterPhotoDetections, imageToViewportTransform, mapPhotoBoxToViewport, mergeTileDetections, planHeroCard, rescaleTransform, tileRects } from "./photo-detection.js";
import { choosePageFocus, imageKey, isSealedListing, shouldSuppressCards } from "./lib/page-focus.js";
import { loadEmbedder, embedCard }    from "./lib/embed.js";
import { rectifyCard }                 from "./lib/rectify.js";
import { loadCatalog, loadHubPenalty, searchCatalog, physicalHits, scoreIndices } from "./lib/search.js";
import { capHeightFor, capSmallSource, capUnconfirmedSet, fuseResults, informationHeight, markRepeatedNames } from "./lib/fusion.js";
import { setChoices, choiceName, cardDescribedInText, cardNamedByAttacks, cardNamedInText, descriptionFromCard, attacksFromCard, nameAgrees, nameAlmostAgrees, onlyPromoChoice } from "./lib/set-choice.js";
import { eraById, eraPrintings, inEra } from "./lib/era.js";
import { applyTitlePrior } from "./lib/title-prior.js";
import { setRangeOf } from "./lib/card-display.js";
import { candidatesFor, correctionRecord, findCards, isUnsure, pageUrlForStorage } from "./lib/card-picker.js";
import { createCorrectionsStore } from "./lib/corrections-store.js";
import { correctionsToEmbed, currentReferences, decodeEmbedding, promoteHit, referenceHit, referenceRow, referencesForExport, singleFlight, withEmbeddings } from "./lib/references.js";
// dev-only:start
import { fitWithin, idWithSize, limitReached, photoRecord, statsFromIds } from "./lib/test-photos.js";
// dev-only:end
import { sendToTab } from "./lib/tab-messaging.js";
import { fullSizeCandidates, loadFullSize } from "./lib/full-size.js";
import { hasSiteAccess } from "./lib/site-access.js";
import { getPptKey } from "./lib/ppt-key.js";
import { chooseFallbackTab, isOwnPage } from "./lib/page-target.js";
import { isCardBack }                  from "./lib/card-back.js";
import { loadNumberReader, readArtStamp, readCardName, readCardNumber, readCardRules, readCollectorCorner } from "./lib/ocr.js";
import { setSizes, exactTotalHits, prefixTotals, printingByNumber, blackStarPromo, promoCollectorNumber } from "./lib/card-number.js";
import { publicHttpsUrl }              from "./lib/net.js";
import { FIRST_EDITION_MIN_SCORE, editionAfterEreader, editionAfterPromo, editionForSets, grayFromRgba, hasFirstEdition, pricedEdition, stampAfterFirst, stampBelowText, stampScore } from "./lib/edition-stamp.js";
import { SHADOW_MIN_DEPTH, borderEdition, shadowDepth } from "./lib/frame-shadow.js";
import { loadVariantModel, readVariant, variantModelReady } from "./lib/variant-model.js";
import { choiceForStamp, finishFromNumber, finishFromVariants, finishSharedByNumber, stampAfterWizards, stampFromCorner } from "./lib/variant.js";
import { PROMO_STAR_MIN, choicesForSymbol, promoStarScore, symbolFromScores, symbolScores } from "./lib/set-symbol.js";
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

// Rectified card pictures are kept in IndexedDB per scan: the service worker sleeps
// between a scan and the user's pick, and memory does not survive that.
const _corrections = createCorrectionsStore();

// The key moves out of sync storage the first time the worker starts after the update.
getPptKey().catch(() => {});

// Persists _targetTabId across service-worker restarts (chrome.storage.session survives SW idle kills).
function _setTargetTabId(id) {
  _targetTabId = id;
  chrome.storage.session.set({ targetTabId: id }).catch(() => {});
}

// True for browser-internal pages. A tab whose address the extension may not read has no url;
// that is "unknown", not internal, or the scanner could never follow the user to a new tab.
function _isInternalUrl(url) {
  if (!url) return false;
  return url.startsWith("chrome-extension://")
      || url.startsWith("chrome://")
      || url.startsWith("about:")
      || url.startsWith("edge://")
      || url.startsWith("devtools://");
}

// ─── icon click → open popup window (gets camera permission prompt) ──────────

chrome.action.onClicked.addListener(async (clickedTab) => {
  // The tab the icon was clicked on is the one activeTab was granted for. Asking the browser for "the
  // current tab" instead could return the scanner window if that was the last thing focused.
  const activeTab = clickedTab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  // Nothing is injected here: the page is touched only when the user presses Scan.
  if (activeTab && !_isInternalUrl(activeTab.url)) _setTargetTabId(activeTab.id);

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
  const [existingTab] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [popupUrl] });
  if (existingTab?.windowId != null && existingTab.windowId >= 0) {
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
    // Page is navigating — tell the old page's script to drop its overlay. The new page has no script
    // until the next scan injects one.
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
  await pruneOldCaches().catch((err) => console.error("[BG] clearing old model caches failed:", err?.message || err));
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
    _loadHubPenalty();
    _loadNumberReader();
    _loadVariantModel();
    embedPendingReferences();
  })();
  try {
    await _loadPromise;
  } finally {
    _loading = false;
    _loadPromise = null;
  }
}

// The look-alike penalty file ships inside the extension when it was built for this catalog. Scanning
// and the setting work without it: the setting only takes effect where the file is present.
function _loadHubPenalty() {
  fetch(chrome.runtime.getURL(HUB_PENALTY_PATH))
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buffer) => { if (buffer) loadHubPenalty(buffer); })
    .catch((err) => console.log("[BG] hub penalty not available", err?.message || err));
}

let _numberReader = null;

// The variant model ships inside the extension. Scanning works without it.
function _loadVariantModel() {
  fetch(chrome.runtime.getURL("models/variant.onnx"))
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buffer) => (buffer ? loadVariantModel(buffer) : null))
    .then(() => { if (variantModelReady()) console.log("[BG] variant model loaded"); })
    .catch((err) => console.log("[BG] variant model not available", err?.message || err));
}

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

// Messages that drive the scanner come only from this extension's own pages. A page's content script may
// send newCardsDetected and nothing else.
const OWN_PAGE_ONLY = new Set([
  "checkReady", "startSetup", "detect", "priceCard", "scanPage",
  "clearPageOverlay", "overlayWithGrid", "relayOverlay", "relayClear",
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (OWN_PAGE_ONLY.has(msg.action) && !isOwnPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) {
    sendResponse({ error: "Not allowed." });
    return false;
  }
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

    default:
      // Corrections, references, and search: the extension's own pages only (checked in the handler).
      if (Object.hasOwn(_ownPageActions, msg.action)) return handleOwnPageMessage(msg, sender, sendResponse);
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

function readBitmap(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function handleScanPage(sendResponse, era) {
  console.log("[BG] handleScanPage start; _ready =", _ready, "_targetTabId =", _targetTabId, "era =", era?.id || "any");
  if (!(await _ensureReady(sendResponse))) return;
  // dev-only:start
  const collecting = await testSetCollecting();
  // dev-only:end

  // Resolve a scannable target tab — fall back to the most-recent non-popup active tab.
  let targetTab = null;
  if (_targetTabId !== null) {
    try { targetTab = await chrome.tabs.get(_targetTabId); } catch { targetTab = null; }
  }
  if (!targetTab || _isInternalUrl(targetTab.url) || targetTab.windowId === _popupWinId) {
    const open = await chrome.tabs.query({ active: true, windowType: "normal" }).catch(() => []);
    const choice = chooseFallbackTab(open, _popupWinId);
    targetTab = choice.tab;
    if (targetTab) _setTargetTabId(targetTab.id);
    else {
      sendResponse({
        error: choice.reason === "unreadable"
          ? "Card Scanner cannot read this tab. Click the Card Scanner icon while you are on the page you want to scan."
          : "No scannable tab — open a webpage first",
      });
      return;
    }
  }
  // Check before anything is injected: the user may have moved to another tab while the models loaded.
  const front = await chrome.tabs.get(targetTab.id).catch(() => null);
  if (!front?.active) {
    sendResponse({ error: "That tab is no longer in front. Scan again." });
    return;
  }
  console.log("[BG] scanning tab", targetTab.id, "url", targetTab.url, "window", targetTab.windowId);

  try {
    // Ask the page which images look like cards; sendToTab injects the content script if it is not there yet.
    let domResp = await sendToTab(chrome, targetTab.id, { action: "findCards" }).catch((e) => ({ error: e.message }));
    if (domResp?.error) {
      sendResponse({ error: "Could not query page for cards: " + domResp.error });
      return;
    }
    // Marketplace pages often paint the card frame before the photo arrives.
    // Scanning then would report "no cards" and run detection on a blank image.
    if ((domResp.pending || 0) > 0 && !(domResp.cards?.length) && !(domResp.photos?.length)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const again = await sendToTab(chrome, targetTab.id, { action: "findCards" }).catch((e) => ({ error: e.message }));
      if (!again?.error) domResp = again;
    }
    if (!(domResp.cards?.length) && !(domResp.photos?.length) && (domResp.pending || 0) > 0) {
      sendResponse({ error: "Card pictures are still loading. Scan again in a moment." });
      return;
    }
    console.log("[BG] DOM finder returned", (domResp?.cards || []).length, "card-shaped images");

    // A listing has one photo worth scanning; thumbnails and "similar items" belong to other cards.
    const focus = choosePageFocus({
      viewport: { w: domResp.viewportWidth, h: domResp.viewportHeight },
      photos: domResp?.photos || [],
      cards: domResp?.cards || [],
      ogImages: domResp?.page?.ogImages || [],
      headings: domResp?.page?.headings || [],
    });
    const sealed = focus.kind === "listing" && isSealedListing({
      titles: [domResp?.page?.title, domResp?.page?.ogTitle, domResp?.page?.h1],
      sealedLabel: focus.main?.ctx?.sealedLabel === true,
    });
    console.log("[BG] page focus:", focus.kind, focus.reason, focus.main ? "main " + imageKey(focus.main) : "", sealed ? "(sealed product: cards only if the detector finds some)" : "");
    // A sealed product's photo is not read as one card; cards the detector really finds in it are kept.
    const domCards = sealed ? [] : focus.cards;
    // Pixels the matcher can use for a card: what it is fed, no more than the picture holds. Grid tiles are
    // small by design, so no size cap there.
    const capFor = (fed, naturalPerFed) => capHeightFor(focus.kind, informationHeight(fed, naturalPerFed));

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
    const scanId = crypto.randomUUID().slice(0, 8);
    const crops = [];
    const pushCard = (card, cardCanvas) => {
      cards.push(card);
      crops.push(encodeCrop(cardCanvas));
    };
    const preemptedPhotoKeys = new Set();
    let lackedSiteAccess = false;

    // ── Multi-card photo split ────────────────────────────────────────────
    // Walk every DOM-flagged photo candidate (any sufficiently large image),
    // run YOLO inside it. When ≥ 2 cards are detected we treat it as a lot /
    // multi-card photo and skip the single-card interpretation below.
    // Outside a listing, a large image that is labelled as a sealed product is not scanned for cards.
    const photos = focus.kind === "listing" ? focus.photos : focus.photos.filter((ph) => ph.ctx?.sealedLabel !== true);
    if (photos.length) console.log("[BG]", photos.length, "photo candidates — running YOLO inside each");
    const scanPhotos = async (list) => { for (const ph of list) {
      let sx = Math.max(0, Math.round(ph.rect.vx * dpr));
      let sy = Math.max(0, Math.round(ph.rect.vy * dpr));
      let sw = Math.min(bitmap.width  - sx, Math.round(ph.rect.vw * dpr));
      let sh = Math.min(bitmap.height - sy, Math.round(ph.rect.vh * dpr));
      // A gallery slide that is not on screen can only be read from its source image.
      const offscreenSlide = (sw < 150 || sh < 150) && (ph.rect.pvw || 0) >= 150 && (ph.rect.pvh || 0) >= 150;
      if ((sw < 150 || sh < 150) && !offscreenSlide) continue;
      let photoBitmap = null;
      let fromSource = false;
      let sourceTransform = null;
      let upgrade = null;
      try {
        const sourceCanMap = ph.render?.fit !== "background" || ph.render?.repeat === "no-repeat";
        // Without access to the image's site there is nothing to fetch; go straight to the screenshot.
        const sourceReadable = sourceCanMap && await canReadPhotoSource(ph.src);
        if (sourceCanMap && !sourceReadable) lackedSiteAccess = true;
        // The page shows a thumbnail; a larger rendition of the same picture lets small cards be read.
        upgrade = sourceReadable ? await loadUpgradedSource(ph, domResp?.page?.ogImages, targetTab.url) : null;
        photoBitmap = upgrade ? upgrade.bitmap : sourceReadable ? await loadPhotoSource(ph.src) : null;
        if (!photoBitmap && offscreenSlide) continue;
        if (photoBitmap) {
          sourceTransform = upgrade
            ? rescaleTransform(
              imageToViewportTransform(ph.rect, ph.naturalWidth, ph.naturalHeight, ph.render || {}),
              ph.naturalWidth / photoBitmap.width, ph.naturalHeight / photoBitmap.height)
            : imageToViewportTransform(ph.rect, photoBitmap.width, photoBitmap.height, ph.render || {});
          if (!sourceTransform) {
            photoBitmap.close();
            photoBitmap = null;
          } else {
            fromSource = true;
          }
        }
        if (!photoBitmap) {
          // The listing's own photo: look at the picture, not at the bars around it in its slot.
          const picture = focus.main && imageKey(ph) === imageKey(focus.main)
            ? displayedRegion(ph.rect, ph.naturalWidth, ph.naturalHeight, ph.render, dpr) : null;
          if (picture && sx + picture.x + picture.w <= bitmap.width && sy + picture.y + picture.h <= bitmap.height) {
            sx += picture.x;
            sy += picture.y;
            sw = picture.w;
            sh = picture.h;
          }
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
        let boxes = filterPhotoDetections(detectedBoxes, imageW, imageH);
        // dev-only:start
        if (collecting) await collectTestPhoto(photoBitmap, boxes, targetTab.url);
        // dev-only:end
        // The listing's own photo may be one card that fills the frame, which the size filter drops, or
        // one the detector cannot see at all. Read it as a card instead of reporting an empty listing.
        let hero = null;
        let heroStrict = false;
        if (!boxes.length && focus.main && imageKey(ph) === imageKey(focus.main)) {
          const plan = planHeroCard({ imageW, imageH, detections: detectedBoxes });
          console.log("[BG]   hero photo, no usable boxes →", plan.kind, sealed ? "(sealed)" : "");
          if (plan.kind === "large-box") {
            boxes = [{ box: plan.box, score: plan.score }];
            hero = plan.kind;
          } else if (plan.kind === "whole-photo" && !sealed) {
            // A squarish photo may be a lot of cards the detector misses at full size: look at tiles first.
            const tiled = plan.strict ? await detectTiled(photoBitmap) : [];
            // One tile hit is as likely a piece of the hero card as a lot: it takes two to call it a lot.
            if (tiled.length >= 2) {
              console.log("[BG]   tiles found", tiled.length, "cards");
              boxes = tiled;
            } else {
              boxes = [{ box: await bestHeroCrop(photoBitmap, plan.crops), score: 0 }];
              hero = plan.kind;
              heroStrict = plan.strict === true;
            }
          }
        }
        const naturalPerFed = fromSource ? 1
          : ph.naturalHeight > 0 && sourceTransform === null
            ? (() => {
              const shown = imageToViewportTransform(ph.rect, ph.naturalWidth, ph.naturalHeight, ph.render || {});
              return shown ? 1 / (shown.scaleY * dpr) : undefined;
            })()
            : undefined;
        console.log("[BG]   photo", (ph.rect.x | 0) + "," + (ph.rect.y | 0),
                    imageW + "x" + imageH,
                    fromSource ? upgrade ? "(source image, upgraded " + imageW + "x" + imageH + " from " + ph.naturalWidth + "x" + ph.naturalHeight + ")" : "(source image)" : "(viewport crop)", "→ YOLO returned", detectedBoxes.length,
                    "boxes;", boxes.length, "passed card-size validation",
                    boxes.length ? "(scores: " + boxes.map(b => b.score.toFixed(2)).join(",") + ")" : "");

        if (!boxes.length) continue;
        console.log("[BG]   splitting", boxes.length, "cards");
        if (!hero) preemptedPhotoKeys.add(_photoKey(ph));
        const photoPixels = readBitmap(photoBitmap);
        const photoFirst = cards.length;
        for (const { box, score } of boxes) {
          const [bx1, by1, bx2, by2] = box;
          if ((bx2 - bx1) < 40 || (by2 - by1) < 60) continue;
          const cardBox = extendClippedBottom(photoPixels.data, photoPixels.width, photoPixels.height, box);
          let viewportBox;
          if (fromSource) {
            viewportBox = mapPhotoBoxToViewport(box, sourceTransform, ph.rect);
            if (!viewportBox) continue;
          } else {
            viewportBox = [sx + bx1, sy + by1, sx + bx2, sy + by2].map((v) => v / dpr);
          }
          const rectify = (rect) => fromSource
            ? rectifyCard(photoBitmap, rect)
            : rectifyCard(bitmap, [sx + rect[0], sy + rect[1], sx + rect[2], sy + rect[3]]);
          const cardCanvas = rectify(box);
          // The number is read from the detector box. The stamp is scored on the
          // box after a clipped yellow border is included, so the card is not stretched.
          const stampCanvas = cardBox[3] === box[3] ? null : rectify(cardBox);
          // One card that fails to read must not drop the rest of the photo.
          let read;
          try {
            read = await identifyCard(cardCanvas, era, by2 - by1, stampCanvas, capFor(by2 - by1, naturalPerFed));
          } catch (err) {
            console.error("[BG] card read failed:", err?.message || err);
            read = { identity: null, confidence: 0, abstain: true, market_price: null, price_variant: null, price_grid: null };
          }
          if (hero === "whole-photo" && !acceptWholePhoto(read, { strict: heroStrict, croppedView: !fromSource && ph.render?.fit === "cover" })) {
            console.log("[BG]   whole photo does not look like one card (catalog top", read.catalogTop?.toFixed?.(2), ") — dropped");
            // Dropped here, so the single-card path below must not read the same picture again.
            preemptedPhotoKeys.add(_photoKey(ph));
            continue;
          }
          if (hero) preemptedPhotoKeys.add(_photoKey(ph));
          // The framing was a guess, so the name is a suggestion for the picker, not an answer.
          if (heroStrict && !read.abstain) read = { ...read, unsure: true };
          pushCard({ box: viewportBox, score, ...read, via: hero ? "hero-" + hero : "yolo-in-photo" }, cardCanvas);
        }
        const photoReads = cards.slice(photoFirst);
        const checked = markRepeatedNames(photoReads);
        const repeated = checked.filter((card, i) => card !== photoReads[i]);
        if (repeated.length) {
          console.log("[BG]   ", repeated.length, "boxes named", JSON.stringify(repeated[0].identity?.name), "- held below high");
          cards.splice(photoFirst, checked.length, ...checked);
        }
      } catch (err) { console.error("[BG] YOLO-in-photo failed:", err?.message || err); }
      finally { photoBitmap?.close?.(); }
    } };
    await scanPhotos(photos);
    // The main photo held no card: the listing may be a lot photographed in the gallery's other pictures.
    // Related-item carousels are never part of this.
    if (!cards.length && !sealed && focus.kind === "listing" && focus.fallback?.length) {
      console.log("[BG] main photo held no card — trying", focus.fallback.length, "other gallery photos");
      await scanPhotos(focus.fallback);
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
      const naturalPerFed = dc.naturalHeight > 0 && dc.rect.h > 0 ? dc.naturalHeight / (dc.rect.h * dpr) : undefined;
      pushCard({
        box: [dc.rect.x, dc.rect.y, dc.rect.x + dc.rect.w, dc.rect.y + dc.rect.h],
        score: 1.0,
        ...(await identifyCard(cardCanvas, era, sh, null, capFor(sh, naturalPerFed))),
      }, cardCanvas);
    }

    // ── Fallback: YOLO viewport scan ───────────────────────────────────────
    // Last resort — a page with no <img> cards and no photo candidates
    // (CSS backgrounds, canvas renders, lightbox overlays).
    // Not on a listing: the other pictures on that page are other people's cards.
    if (cards.length === 0 && focus.kind !== "listing") {
      try {
        console.log("[BG] still nothing — running YOLO over whole viewport");
        const yoloBoxes = await detectCards(bitmap);
        console.log("[BG] YOLO found", yoloBoxes.length, "boxes in viewport");
        for (const { box, score } of yoloBoxes) {
          const [x1, y1, x2, y2] = box;
          if ((x2 - x1) < 40 || (y2 - y1) < 60) continue;
          const cardCanvas = rectifyCard(bitmap, box);
          pushCard({
            box: [x1 / dpr, y1 / dpr, x2 / dpr, y2 / dpr],
            score,
            ...(await identifyCard(cardCanvas, era, y2 - y1, null, capFor(y2 - y1))),
            via: "yolo-viewport",
          }, cardCanvas);
        }
      } catch (err) {
        console.error("[BG] YOLO viewport fallback failed:", err?.message || err);
      }
    }

    if (shouldSuppressCards({ sealed, detectedCards: cards.length })) console.log("[BG] sealed product: no cards reported");
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
    sendToTab(chrome, targetTab.id, { action: "startObserving" }).catch(() => {});

    const encoded = await Promise.all(crops);
    await _corrections.saveScan({ scanId, ts: Date.now(), pageUrl: pageUrlForStorage(targetTab.url), crops: encoded })
      .catch((err) => console.error("[BG] keeping scan pictures failed:", err?.message || err));
    const withCandidates = cards.map((card) => (isUnsure(card) ? { ...card, candidates: candidatesFor(card, _meta) } : card));
    const asked = applyTitlePrior(withCandidates, {
      kind: focus.kind,
      page: domResp?.page,
      knownNames: catalogNames(),
      log: (message) => console.log("[BG]", message),
    });

    sendResponse({ cards: asked, scanId, srcWidth, srcHeight, targetTabId: targetTab.id, pending: domResp.pending || 0, pageKind: focus.kind, sealedProduct: sealed,
      ...(lackedSiteAccess ? { usedScreenshotPath: true, reason: "no-site-access" } : {}) });
  } catch (err) {
    console.error("[BG] handleScanPage error:", err?.message || err);
    sendResponse({ error: String(err?.message || err) });
  }
}

// ─── corrections ─────────────────────────────────────────────────────────────

async function jpegDataUrl(source, width, height, quality) {
  const small = new OffscreenCanvas(width, height);
  small.getContext("2d").drawImage(source, 0, 0, width, height);
  const blob = await small.convertToBlob({ type: "image/jpeg", quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return "data:image/jpeg;base64," + btoa(binary);
}

// The same 375x525 size the stamp and edition checks read at.
async function encodeCrop(cardCanvas) {
  try {
    return await jpegDataUrl(cardCanvas, STAMP_CARD_W, STAMP_CARD_H, 0.85);
  } catch (err) {
    console.error("[BG] crop encode failed:", err?.message || err);
    return null;
  }
}

// dev-only:start
// ─── test-set collection ─────────────────────────────────────────────────────

async function testSetCollecting() {
  try {
    return (await chrome.storage.local.get("testSetCollection")).testSetCollection === true;
  } catch {
    return false;
  }
}

// Saves the picture the detector ran on and its boxes; never what the scanner made of them.
// Identical bytes get the same id and are kept once; near copies are dropped when the set is imported.
// Past the cap nothing more is kept; the options page says so.
async function collectTestPhoto(bitmap, detections, pageUrl) {
  try {
    if (limitReached(statsFromIds(await _corrections.photoIds()))) return;
    const boxes = detections
      .map(({ box }) => box)
      .filter((box) => box[2] - box[0] >= 40 && box[3] - box[1] >= 60);
    const fit = fitWithin(bitmap.width, bitmap.height);
    const photo = await jpegDataUrl(bitmap, fit.width, fit.height, 0.9);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(photo));
    const hash = [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const id = idWithSize(hash, photo.length);
    await _corrections.savePhoto(photoRecord({ id, ts: Date.now(), pageUrl, photo, boxes, scale: fit.scale }));
  } catch (err) {
    console.error("[BG] saving test photo failed:", err?.message || err);
  }
}
// dev-only:end

// Only the extension's own pages may read or write corrections; a web page's content script may not.
const _ownPageActions = {
  findCards: async (msg) => {
    await _ensureCatalog();
    return { cards: findCards(_meta, msg.query, { era: eraById(msg.era) }) };
  },
  saveCorrection: async (msg) => {
    await _ensureCatalog();
    if (!catalogCard(msg.pickedId)) throw new Error("That card isn't in the catalog.");
    // A scan older than the last two has lost its pictures; the answer is still worth keeping.
    const scan = msg.scanId ? await _corrections.getScan(msg.scanId).catch(() => null) : null;
    const record = correctionRecord({
      ts: Date.now(),
      scanId: msg.scanId,
      index: msg.index,
      pageUrl: scan?.pageUrl,
      guess: msg.guess,
      pickedId: msg.pickedId,
      via: msg.via,
      crop: scan?.crops?.[msg.index],
      extVersion: chrome.runtime.getManifest().version,
    });
    // The old answer's vector must not outlive it; a failed delete is caught by the ts check in correctionsToEmbed.
    if (record.id) {
      await _corrections.deleteReference(record.id).catch((err) => console.error("[BG] dropping the old reference failed:", err?.message || err));
      referencesChanged();
    }
    await _corrections.save(record);
    if (_ready) embedPendingReferences();
    return { ok: true };
  },
  countCorrections: async () => ({ count: await _corrections.count() }),
  exportCorrections: async () => exportCorrections(),
  clearCorrections: async () => {
    // References first: a failure after this leaves corrections without references, which are rebuilt, not references without corrections.
    await _corrections.clearReferences();
    referencesChanged();
    await _corrections.clear();
    return { ok: true };
  },
  countReferences: async () => ({ count: await _corrections.countReferences() }),
  startReferences: async () => {
    if (_ready) embedPendingReferences();
    else tryAutoLoad().catch((err) => console.error("[BG] model reload failed", err?.message || err));
    return { ok: true };
  },
  // dev-only:start
  importReferences: async (msg) => {
    const rows = (Array.isArray(msg.references) ? msg.references : []).flatMap((ref) => {
      const embedding = decodeEmbedding(ref?.embedding);
      return embedding && typeof ref.id === "string" && typeof ref.cardId === "string" && ref.cardId
        ? [{ id: `import:${ref.id}`, cardId: ref.cardId, ts: null, v: Number(ref.embeddingVersion) || 1, embedding }]
        : [];
    });
    await _corrections.replaceReferences(rows, { clearCorrections: msg.clearCorrections === true });
    referencesChanged();
    return { imported: rows.length };
  },
  countTestPhotos: async () => {
    const stats = statsFromIds(await _corrections.photoIds());
    return { ...stats, limitReached: limitReached(stats) };
  },
  testPhotoIds: async () => ({ ids: await _corrections.photoIds() }),
  getTestPhotos: async (msg) => {
    const ids = Array.isArray(msg.ids) ? msg.ids.filter((id) => typeof id === "string").slice(0, 20) : [];
    return { photos: await _corrections.getPhotos(ids) };
  },
  clearTestPhotos: async () => {
    await _corrections.clearPhotos();
    return { ok: true };
  },
  // dev-only:end
};

function handleOwnPageMessage(msg, sender, sendResponse) {
  if (!isOwnPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) {
    sendResponse({ error: "Not allowed." });
    return false;
  }
  if (!Object.hasOwn(_ownPageActions, msg.action)) {
    sendResponse({ error: "Not allowed." });
    return false;
  }
  _ownPageActions[msg.action](msg)
    .then(sendResponse)
    .catch((err) => {
      console.error("[BG]", msg.action, "failed", err?.message || err);
      sendResponse({ error: String(err?.message || err) });
    });
  return true;
}

// ─── references ──────────────────────────────────────────────────────────────

let _refs = null;
let _refsVersion = 0;
let _embedQueue = Promise.resolve();

function referencesChanged() {
  _refs = null;
  _refsVersion += 1;
}

async function loadedReferences() {
  if (_refs) return _refs;
  const version = _refsVersion;
  const [stored, heads] = await Promise.all([_corrections.allReferences(), _corrections.correctionHeads()]);
  const rows = currentReferences(stored, heads);
  if (version === _refsVersion) _refs = rows;
  return rows;
}

const HUB_PENALTY_PATH = "data/hub-penalty.bin";

// "Experimental: reduce look-alike matches" in the options page. Off until a sealed-set score shows a gain.
async function lookalikePenaltyInUse() {
  try {
    return (await chrome.storage.local.get("reduceLookalikes")).reduceLookalikes === true;
  } catch {
    return false;
  }
}

async function referencesInUse() {
  try {
    return (await chrome.storage.local.get("useReferences")).useReferences === true;
  } catch {
    return false;
  }
}

// A scan and a reference pass can both want the embedder, and one session cannot run twice at once.
function embedSerial(canvas) {
  const run = _embedQueue.then(() => embedCard(canvas));
  _embedQueue = run.catch(() => {});
  return run;
}

// A reference only reorders cards the catalog already returned, at the catalog's own top score, so a
// reprint of a corrected card is not made certain. Any failure leaves the catalog hits as they were.
async function withReferenceHit(embedding, hits) {
  try {
    if (!(await referencesInUse())) return { hits, referencedId: null };
    const hit = referenceHit(embedding, await loadedReferences(), hits[0]?.score ?? 0);
    const at = hit ? hits.findIndex((h) => _meta[h.index]?.id === hit.cardId) : -1;
    return at < 0 ? { hits, referencedId: null } : { hits: promoteHit(hits, hits[at].index), referencedId: hit.cardId };
  } catch (err) {
    console.error("[BG] reference lookup failed:", err?.message || err);
    return { hits, referencedId: null };
  }
}

async function embedCrop(cropDataUrl) {
  const bitmap = await b64ToBitmap(cropDataUrl.replace(/^data:image\/jpeg;base64,/, ""));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return embedSerial(canvas);
}

// Runs only when the user presses Export, never during a scan. Corrections without a fingerprint get one
// first so the exported file is complete whether or not the "recognize corrected cards" option is on.
// The new fingerprints are kept in the browser only when that option is on, as the privacy policy says.
async function exportCorrections() {
  const progress = (status) => chrome.runtime.sendMessage({ action: "exportProgress", ...status }).catch(() => {});
  const [heads, refs] = await Promise.all([_corrections.correctionHeads(), _corrections.allReferences()]);
  let rows = refs;
  let failed = 0;
  if (correctionsToEmbed(heads, refs).length) {
    progress({ phase: "models" });
    await tryAutoLoad();
    if (!_ready) throw new Error("The card models aren't downloaded yet. Finish setup in the scanner window, then export again.");
    const keep = await referencesInUse();
    ({ rows, failed } = await referencesForExport({
      heads,
      refs,
      getCorrection: (id) => _corrections.getCorrection(id),
      embedCrop,
      onProgress: (status) => progress({ phase: "embedding", ...status }),
      onEmbedded: async (row) => {
        if (!keep) return;
        // Cleared or replaced while the model ran: a reference with no correction behind it would be an orphan.
        const now = await _corrections.getCorrection(row.id);
        if (now?.ts !== row.ts || now.pickedId !== row.cardId) return;
        await _corrections.saveReference(row);
        referencesChanged();
      },
    }));
  }
  return { corrections: withEmbeddings(await _corrections.all(), rows), failed };
}

// Only made while the option is on, so nothing is embedded for someone who never asked for it.
async function embedPendingOnce() {
  if (!_ready || !(await referencesInUse())) return;
  const [heads, refs] = await Promise.all([_corrections.correctionHeads(), _corrections.allReferences()]);
  for (const head of correctionsToEmbed(heads, refs)) {
    try {
      const correction = await _corrections.getCorrection(head.id);
      if (!correction?.crop || correction.ts !== head.ts) continue;
      const embedding = await embedCrop(correction.crop);
      // The answer may have been replaced or cleared while the model ran.
      const now = await _corrections.getCorrection(correction.id);
      if (now?.ts !== correction.ts || now.pickedId !== correction.pickedId) continue;
      await _corrections.saveReference(referenceRow(correction, embedding));
      referencesChanged();
    } catch (err) {
      console.error("[BG] embedding a correction failed, will retry:", err?.message || err);
    }
  }
}

// Fire and forget: saving a correction never waits for the models, and one pass runs at a time.
const embedPendingReferences = singleFlight(embedPendingOnce, (err) => console.error("[BG] reference pass failed:", err?.message || err));

// The catalog alone is enough to search and to check a pick; no need to wait for the models.
async function _ensureCatalog() {
  _meta ??= await getAssetJson("meta.json");
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
      const embedding  = await embedSerial(cardCanvas);
      const catalogHits = physicalHits(searchCatalog(embedding, 20, { penalty: await lookalikePenaltyInUse() }), _meta);
      if (isCardBack(embedding, catalogHits[0]?.score ?? 0)) {
        cards.push({ box, score, identity: null, confidence: 0, abstain: true, cardBack: true, market_price: null, price_variant: null });
        continue;
      }
      const { hits }   = await withReferenceHit(embedding, catalogHits);
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
    const tabs = await chrome.tabs.query({ active: true, windowType: "normal" }).catch(() => []);
    const { tab: candidate } = chooseFallbackTab(tabs, _popupWinId);
    if (candidate) _setTargetTabId(candidate.id);
  }
  if (_targetTabId === null) return;
  const relayMsg = msg.action === "relayOverlay"
    ? { action: "showOverlay", cards: msg.cards, srcWidth: msg.srcWidth, srcHeight: msg.srcHeight }
    : { action: "clearOverlay" };
  // A page the extension may not touch (no access granted, or a browser page) just gets no overlay.
  await sendToTab(chrome, _targetTabId, relayMsg).catch(() => {});
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
async function identifyCard(cardCanvas, era = null, sourceHeight = 0, stampCanvas = null, capHeight = sourceHeight) {
  const read = await identifyFully(cardCanvas, era, sourceHeight, stampCanvas);
  console.log("[BG]   card h=" + Math.round(sourceHeight), "info=" + Math.round(capHeight), "conf=" + (read.confidence ?? 0).toFixed?.(2), read.abstain ? "abstain" : "named", read.identity?.name ?? "-", "top=" + (read.catalogTop?.toFixed?.(2) ?? "-"));
  // A set that is still open (several printings of the same art) is never shown as high; a number, symbol or stamp read has already settled it by now.
  return capSmallSource(capUnconfirmedSet(await withSetRange(read)), capHeight);
}

// A name whose set is still open is shown with what the candidate printings sell for, so the row is useful before anyone picks.
async function withSetRange(read) {
  const choices = read.setChoices || [];
  if (read.abstain || choices.length < 2 || read.setRange) return read;
  const priced = [];
  for (const choice of choices) {
    const card = catalogCard(choice.id);
    if (!card) continue;
    try {
      priced.push(await priceIdentity(card));
    } catch (err) {
      console.log("[BG] no price for", choice.id, err?.message || err);
    }
  }
  const setRange = setRangeOf(priced);
  return setRange ? { ...read, setRange } : read;
}

async function identifyFully(cardCanvas, era, sourceHeight, stampCanvas) {
  const result = await recognizeCard(cardCanvas, era, sourceHeight);
  const setCodes = result.setChoices ? result.setChoices.map((c) => c.setCode) : [result.identity?.setCode];
  if (sourceHeight < STAMP_MIN_HEIGHT) return result;
  if (variantModelReady()) {
    const seen = await readVariant(cardCanvas);
    result.variant = seen;
    if (seen?.edition === "first") result.firstEdition = true;
    console.log("[BG] variant", seen?.edition ?? "unsure", seen?.finish ?? "unsure", seen?.stamp ?? "none");
  }
  // On Base Set the stamp template decides 1st Edition. The border then
  // separates Shadowless from Unlimited. A model "first" without that stamp
  // is a Shadowless card, which has the same missing band. On other sets the
  // stamp template can still call 1st Edition after the model has spoken.
  const knownSets = setCodes.filter(Boolean);
  const modelEdition = editionForSets(result.variant?.edition, knownSets);
  if (result.variant?.edition === "first" && modelEdition !== "first") {
    result.firstEdition = false;
    result.variant = { ...result.variant, edition: modelEdition };
  }
  const baseSet = knownSets.length > 0 && knownSets.every((code) => code === "base1");
  const canBeFirst = knownSets.some((code) => hasFirstEdition(code));
  const setUncertain = (result.setChoices?.length || 0) > 1;
  // Fossil 30/62 is the non-holo Zapdos. The photo model calls that glare holofoil.
  const readTotal = Number(String(result.numberRead ?? "").split("/")[1]);
  const numberedFinish = finishFromNumber(result.identity?.setCode, result.identity?.number, readTotal) || result.agreedFinish || null;
  if (numberedFinish) {
    result.variant = {
      edition: result.variant?.edition ?? null,
      finish: numberedFinish,
      stamp: result.variant?.stamp ?? "none",
    };
  }
  const artText = await readOnce(cardCanvas, "art", readArtStamp);
  const cornerStamp = stampFromCorner(artText);
  if (cornerStamp === "setstamp" || (cornerStamp === "none" && result.variant?.stamp === "setstamp")) {
    result.variant = {
      edition: result.variant?.edition ?? null,
      finish: result.variant?.finish ?? null,
      stamp: cornerStamp,
    };
    console.log("[BG] art stamp", cornerStamp);
  }
  if (result.variant?.stamp === "setstamp") {
    const cleared = stampAfterWizards(result.variant.stamp, result.ocrText);
    if (cleared !== "setstamp") {
      result.variant = { ...result.variant, stamp: cleared };
      console.log("[BG] wizards copyright");
    }
  }
  if (setUncertain && !result.identity?.id) {
    const stamped = choiceForStamp(result.setChoices, artText);
    const stampedCard = stamped ? catalogCard(stamped.id) : null;
    if (stampedCard) {
      console.log("[BG] set stamp", stampedCard.id);
      result.identity = stampedCard;
      result.setChoices = undefined;
      result.abstain = false;
      Object.assign(result, await priceIdentity(stampedCard));
    }
  }
  if (setUncertain && result.setChoices?.length > 1) {
    const full = cardGrayFull(cardCanvas);
    const symbol = symbolFromScores(symbolScores(full.gray, full.width, full.height));
    const kept = choicesForSymbol(result.setChoices, symbol);
    if (kept.length < result.setChoices.length && kept.length === 1) {
      const identity = catalogCard(kept[0].id);
      if (identity) {
        console.log("[BG] set symbol", symbol);
        result.identity = identity;
        result.setChoices = undefined;
        result.abstain = false;
        Object.assign(result, await priceIdentity(identity));
      } else {
        result.setChoices = kept;
      }
    } else if (kept.length < result.setChoices.length) {
      console.log("[BG] set symbol", symbol);
      result.setChoices = kept;
    }
  }
  const full = cardGrayFull(cardCanvas);
  const promoStar = promoStarScore(full.gray, full.width, full.height) >= PROMO_STAR_MIN;
  const eReader = editionAfterEreader("first", artText) === "standard";
  if (result.variant?.edition === "first" && (promoStar || eReader)) {
    result.firstEdition = false;
    result.variant = { ...result.variant, edition: "standard" };
    console.log(promoStar ? "[BG] promo star" : "[BG] e-reader id");
  }
  if (promoStar && !result.numberRead) {
    const number = promoCollectorNumber(await readOnce(cardCanvas, "corner", readCollectorCorner));
    const promo = blackStarPromo(_meta, number);
    const current = result.identity?.name;
    if (promo && nameAgrees(promo.name, await readOnce(cardCanvas, "name", readCardName)) && (!current || choiceName(current) === choiceName(promo.name))) {
      const identity = catalogCard(promo.id);
      if (identity && result.identity?.id !== identity.id) {
        console.log("[BG] promo number", number, "→", identity.id);
        result.identity = identity;
        result.setUnconfirmed = false;
        result.setChoices = undefined;
        result.abstain = false;
        Object.assign(result, await priceIdentity(identity));
      }
    }
  }
  // The star is the Wizards promo, even when the corner number was not read.
  if (promoStar && !result.identity?.id) {
    const chosen = onlyPromoChoice(result.setChoices);
    const identity = chosen ? catalogCard(chosen.id) : null;
    if (identity) {
      console.log("[BG] promo star", identity.id);
      result.identity = identity;
      result.setChoices = undefined;
      result.abstain = false;
      Object.assign(result, await priceIdentity(identity));
    }
  }
  // A Black Star promo number is only one finish. Other sets stay with the
  // photo: a reverse Nidoqueen is catalogued as normal-only.
  if (result.identity?.setCode === "basep" && !numberedFinish) {
    const finish = finishFromVariants((await getTcgdexCard(result.identity.id))?.variants);
    if (finish) {
      result.variant = {
        edition: result.variant?.edition ?? null,
        finish,
        stamp: result.variant?.stamp ?? "none",
      };
      console.log("[BG] promo finish", finish);
    }
  }
  if (result.identity?.setCode === "basep" && !result.setChoices) return result;
  if (!baseSet && !canBeFirst) return result;
  const gray = cardGray(stampCanvas || cardCanvas);
  const border = borderEdition(gray, STAMP_CARD_W, STAMP_CARD_H);
  const stampValue = stampScore(gray, STAMP_CARD_W, STAMP_CARD_H, undefined, stampBelowText(knownSets));
  if (baseSet) {
    const stamped = stampValue >= FIRST_EDITION_MIN_SCORE;
    console.log("[BG] frame border", border ?? "unsure", stamped ? "stamp" : "no stamp");
    const finish = result.variant?.finish ?? null;
    const promo = result.variant?.stamp ?? "none";
    if (stamped && border === "unlimited") {
      // A 1st Edition Base Set card has no drop shadow. Both signals cannot be right.
      console.log("[BG] stamp and drop shadow disagree");
    } else if (stamped) {
      result.firstEdition = true;
      result.variant = { edition: "first", finish, stamp: stampAfterFirst(promo, true) };
    } else if (border === "shadowless") {
      result.firstEdition = false;
      result.variant = { edition: "shadowless", finish, stamp: promo };
    } else if (border === "unlimited" || shadowDepth(gray, STAMP_CARD_W, STAMP_CARD_H) >= SHADOW_MIN_DEPTH) {
      result.shadow = true;
      result.firstEdition = false;
      if (result.variant) result.variant = { ...result.variant, edition: "standard" };
    }
  } else {
    console.log("[BG] 1st Edition stamp", stampValue.toFixed(3));
    // A model "first" without the stamp prices an ordinary card as 1st Edition.
    const edition = editionAfterEreader(editionAfterPromo(pricedEdition(modelEdition, stampValue), promoStar), artText);
    if (edition === "first") {
      result.firstEdition = true;
      result.variant = {
        edition: "first",
        finish: result.variant?.finish ?? null,
        stamp: stampAfterFirst(result.variant?.stamp, true),
      };
    } else if (result.firstEdition || result.variant?.edition === "first") {
      result.firstEdition = false;
      if (result.variant) result.variant = { ...result.variant, edition };
    }
  }
  if (!result.firstEdition || !result.setChoices) return result;
  const stamped = result.setChoices.filter((c) => hasFirstEdition(c.setCode));
  if (stamped.length !== 1) return { ...result, setChoices: stamped.length ? stamped : result.setChoices };
  const identity = catalogCard(stamped[0].id);
  if (!identity) return { ...result, setChoices: stamped };
  return { ...result, identity, setChoices: undefined, ...(await priceIdentity(identity)) };
}

/** Card boxes from running the detector over overlapping tiles of a photo (2x2 and 3x3), in photo pixels. */
async function detectTiled(bitmap) {
  const tiles = [];
  const previousThreshold = getConfThreshold();
  setConfThreshold(0.12);
  try {
    for (const n of [2, 3]) {
      for (const rect of tileRects(bitmap.width, bitmap.height, n)) {
        const piece = await createImageBitmap(bitmap, rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
        try {
          tiles.push({ rect, detections: await detectCards(piece) });
        } finally {
          piece.close();
        }
      }
    }
  } finally {
    setConfThreshold(previousThreshold);
  }
  return mergeTileDetections(tiles);
}

/** Of a few centred zooms of a photo, the one the catalog resembles most: the card fills it best. */
async function bestHeroCrop(bitmap, crops) {
  let best = crops[0];
  let bestScore = -1;
  for (const crop of crops) {
    const hits = physicalHits(searchCatalog(await embedSerial(rectifyCard(bitmap, crop)), 5), _meta);
    const score = hits[0]?.score ?? 0;
    console.log("[BG]   hero crop", crop.join(","), "catalog top", score.toFixed(3));
    if (score > bestScore) {
      best = crop;
      bestScore = score;
    }
  }
  return best;
}

function cardGray(cardCanvas) {
  const small = new OffscreenCanvas(STAMP_CARD_W, STAMP_CARD_H);
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cardCanvas, 0, 0, STAMP_CARD_W, STAMP_CARD_H);
  const { data } = ctx.getImageData(0, 0, STAMP_CARD_W, STAMP_CARD_H);
  return grayFromRgba(data, STAMP_CARD_W, STAMP_CARD_H);
}

function cardGrayFull(cardCanvas) {
  const ctx = cardCanvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, cardCanvas.width, cardCanvas.height);
  return { gray: grayFromRgba(data, width, height), width, height };
}

/**
 * Recognize one rectified card. When close matches come from more than one set,
 * the card is not priced: the user picks the set and the popup asks "priceCard".
 */
async function recognizeCard(cardCanvas, era = null, sourceHeight = 0) {
  const seen = {};
  const result = await recognizeWith(cardCanvas, era, sourceHeight, seen);
  // catalogTop is saved with a correction so the margin can be measured later; referencedId puts that card first among the candidates.
  return { ...result, catalogTop: seen.catalogTop ?? null, ...(seen.referencedId ? { referencedId: seen.referencedId } : {}) };
}

async function recognizeWith(cardCanvas, era, sourceHeight, seen) {
  const embedding = await embedSerial(cardCanvas);
  const catalogHits = physicalHits(searchCatalog(embedding, 20, { penalty: await lookalikePenaltyInUse() }), _meta);
  seen.catalogTop = catalogHits[0]?.score ?? null;
  if (isCardBack(embedding, catalogHits[0]?.score ?? 0)) {
    return { identity: null, confidence: 0, abstain: true, cardBack: true, market_price: null, price_variant: null, price_grid: null };
  }
  const { hits, referencedId } = await withReferenceHit(embedding, catalogHits);
  seen.referencedId = referencedId;
  const { identity, confidence, abstain } = fuseResults(hits, null, _meta, _idMap);
  const unpriced = { market_price: null, price_variant: null, price_grid: null };
  const named = abstain || !identity ? null : identity.name;
  const numbered = sourceHeight >= NUMBER_MIN_HEIGHT ? await printingFromNumber(cardCanvas, named, hits, era) : null;
  const ocrText = numbered?.text || "";
  if (numbered?.card) {
    return { identity: numbered.card, confidence, abstain: false, numberRead: numbered.read, ocrText, ...(await priceIdentity(numbered.card)) };
  }
  if (!named) {
    const fromRules = era ? await cardFromNameAndRules(cardCanvas, era, null) : null;
    if (fromRules) {
      return { identity: fromRules, confidence, abstain: false, ocrText, ...(await priceIdentity(fromRules)) };
    }
    return {
      identity,
      confidence,
      abstain,
      ocrText,
      numberRead: numbered?.read,
      agreedFinish: numbered?.finish || null,
      ...unpriced,
    };
  }

  const eraRows = era ? eraPrintingsOf(identity.name, era) : null;
  // The user said when these cards are from; a name never printed then was misread.
  if (eraRows && !eraRows.length) return { identity: null, confidence, abstain: true, ocrText, ...unpriced };
  const inPeriod = eraRows ? eraPrintings(scoreIndices(embedding, eraRows)) : null;
  if (inPeriod?.pick != null) {
    const picked = _meta[inPeriod.pick];
    return { identity: picked, confidence, abstain, ocrText, ...(await priceIdentity(picked)) };
  }
  const choices = inPeriod?.choices
    ? inPeriod.choices.map((index) => _meta[index])
    : setChoices(identity, hits, _meta);
  if (choices.length > 1) {
    const fromRules = era ? await cardFromNameAndRules(cardCanvas, era, identity.name) : null;
    if (fromRules) {
      return { identity: fromRules, confidence, abstain: false, ocrText, ...(await priceIdentity(fromRules)) };
    }
    return {
      identity: { name: identity.name },
      confidence,
      abstain,
      setChoices: choices.map(({ id, name, set, setCode, number }) => ({ id, name, set, setCode, number })),
      ocrText,
      ...unpriced,
    };
  }
  // Other sets print this name: the printing rests on the picture alone until a number, symbol, stamp or title confirms it.
  const setUnconfirmed = physicalHits(printingsOf(identity.name).map((index) => ({ index })), _meta).length > 1;
  return { identity, confidence, abstain, ocrText, ...(setUnconfirmed ? { setUnconfirmed } : {}), ...(await priceIdentity(identity)) };
}

let _catalogNames = null;
/** Each card name in the catalog once, as printed. */
function catalogNames() {
  if (!_catalogNames) _catalogNames = [...new Set(_meta.map((card) => card.name).filter(Boolean))];
  return _catalogNames;
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

// Pikachu, including the delta printings, has 20 cards in the EX era.
const RULES_NAME_CAP = 20;

/**
 * The embedder missed the card. The title line names one Pokémon, and the
 * attack text is only printed on one of that Pokémon's cards in the era.
 */
async function cardFromNameAndRules(cardCanvas, era, knownName) {
  const title = knownName || await readOnce(cardCanvas, "name", readCardName);
  const seen = new Set();
  const cards = [];
  for (const card of _meta) {
    if (!card?.id || seen.has(card.id) || !inEra(card, era)) continue;
    const agrees = knownName
      ? choiceName(card.name) === choiceName(knownName)
      : nameAlmostAgrees(card.name, title);
    if (!agrees) continue;
    seen.add(card.id);
    cards.push(card);
  }
  const names = new Set(cards.map((card) => choiceName(card.name)));
  if (names.size !== 1 || cards.length < 2 || cards.length > RULES_NAME_CAP) return null;
  const describedCards = await Promise.all(cards.map(async (card) => {
    const payload = await getTcgdexCard(card.id);
    return {
      ...card,
      description: descriptionFromCard(payload),
      attacks: attacksFromCard(payload),
    };
  }));
  const rules = await readOnce(cardCanvas, "rules", readCardRules);
  const described = cardDescribedInText(describedCards, rules) || cardNamedByAttacks(describedCards, rules);
  if (!described) return null;
  console.log("[BG] name", JSON.stringify(title), "→", described.id, "(rules)");
  return cards.find((card) => card.id === described.id) || null;
}

// Source pixels of card height; below this the number does not read (measured on ShopGoodwill lots).
const NUMBER_MIN_HEIGHT = 600;
let _setSizes = null;

// Each fallback asks for the name and rules again. One OCR pass per region per card.
const _regionReads = new WeakMap();
function readOnce(cardCanvas, region, read) {
  let reads = _regionReads.get(cardCanvas);
  if (!reads) {
    reads = new Map();
    _regionReads.set(cardCanvas, reads);
  }
  if (!reads.has(region)) reads.set(region, read(cardCanvas));
  return reads.get(region);
}

/**
 * The printing named by the collector number on the card, or null. Printings of the
 * recognized name come first, then the closest-looking cards (the name may be wrong).
 */
async function printingFromNumber(cardCanvas, name, hits, era) {
  const read = await readCardNumber(cardCanvas);
  if (!read?.number) {
    if (read) console.log("[BG] no number in", JSON.stringify(read.text));
    return read?.text ? { text: read.text } : null;
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
    return { card: rows[at], read: `${read.number}/${read.total}`, text: read.text };
  }
  if (era) {
    const eraCards = _meta.filter((card) => inEra(card, era));
    const eraHits = exactTotalHits(eraCards, read, _setSizes);
    if (eraHits.length === 1) {
      const card = eraCards[eraHits[0]];
      // A wrong name (Dodrio for Doduo) stays until the title line names this card.
      // With no name at all, the title still has to agree: one misread digit can
      // land on another set's real size.
      const title = await readOnce(cardCanvas, "name", readCardName);
      const titleAgrees = name ? nameAgrees(card.name, title) : nameAlmostAgrees(card.name, title);
      if (titleAgrees) {
        console.log("[BG] number", JSON.stringify(read.text), "→", card.id, name ? "(era, name)" : "(era)");
        return { card, read: `${read.number}/${read.total}`, text: read.text };
      }
    }
    if (eraHits.length > 1) {
      const tied = eraHits.map((index) => eraCards[index]);
      const namedCard = cardNamedInText(tied, await readOnce(cardCanvas, "name", readCardName));
      if (namedCard) {
        console.log("[BG] number", JSON.stringify(read.text), "→", namedCard.id, "(name)");
        return { card: namedCard, read: `${read.number}/${read.total}`, text: read.text };
      }
      const describedCards = await Promise.all(tied.map(async (card) => ({
        ...card,
        description: descriptionFromCard(await getTcgdexCard(card.id)),
      })));
      const described = cardDescribedInText(describedCards, await readOnce(cardCanvas, "rules", readCardRules));
      if (described) {
        console.log("[BG] number", JSON.stringify(read.text), "→", described.id, "(rules)");
        return { card: tied.find((card) => card.id === described.id), read: `${read.number}/${read.total}`, text: read.text };
      }
      const finish = finishSharedByNumber(tied, read.total);
      if (finish) {
        console.log("[BG] number", JSON.stringify(read.text), "→", finish, "(tied sets)");
        return { read: `${read.number}/${read.total}`, text: read.text, finish };
      }
    }
  }
  // "18/132" with the last digit cut off is "18/13". The rules text has to
  // pick the card. A truncated total never names a card by itself.
  if (era) {
    const prefixes = prefixTotals(read.total);
    if (prefixes.length) {
      const eraCards = _meta.filter((card) => inEra(card, era));
      const tied = [];
      for (const total of prefixes) {
        for (const index of exactTotalHits(eraCards, { number: read.number, total }, _setSizes)) {
          tied.push(eraCards[index]);
        }
      }
      if (tied.length > 1) {
        const namedCard = cardNamedInText(tied, await readOnce(cardCanvas, "name", readCardName));
        if (namedCard) {
          console.log("[BG] number", JSON.stringify(read.text), "→", namedCard.id, "(short total, name)");
          return { card: namedCard, read: `${read.number}/${read.total}`, text: read.text };
        }
        const describedCards = await Promise.all(tied.map(async (card) => ({
          ...card,
          description: descriptionFromCard(await getTcgdexCard(card.id)),
        })));
        const described = cardDescribedInText(describedCards, await readOnce(cardCanvas, "rules", readCardRules));
        if (described) {
          console.log("[BG] number", JSON.stringify(read.text), "→", described.id, "(short total, rules)");
          return { card: tied.find((card) => card.id === described.id), read: `${read.number}/${read.total}`, text: read.text };
        }
      }
    }
  }
  console.log("[BG] number", JSON.stringify(read.text), "→ no printing of", name);
  return { text: read.text };
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

// The full-size photo is fetched only from sites the user gave the extension access to.
async function canReadPhotoSource(rawUrl) {
  // dev-only:start
  if (await forcedScreenshotPath()) return false;
  // dev-only:end
  return hasSiteAccess(chrome.permissions, rawUrl);
}

// dev-only:start
// Lets a test measure the screenshot path in a build that has site access.
async function forcedScreenshotPath() {
  try {
    return (await chrome.storage.local.get("forceScreenshotPath")).forceScreenshotPath === true;
  } catch {
    return false;
  }
}
// dev-only:end

const UPGRADE_TIMEOUT_MS = 4000;
const UPGRADE_MAX_SIDE = 1600;

// The displayed picture's larger rendition, when the page names one the extension may read.
async function loadUpgradedSource(ph, ogImages, pageUrl) {
  if (!(ph.naturalWidth > 0 && ph.naturalHeight > 0)) return null;
  const candidates = [];
  for (const url of fullSizeCandidates({ src: ph.src, naturalWidth: ph.naturalWidth, ...ph.sources, ogImages, base: pageUrl })) {
    if (await canReadPhotoSource(url)) candidates.push(url);
  }
  if (!candidates.length) return null;
  return loadFullSize(candidates, { width: ph.naturalWidth, height: ph.naturalHeight },
    (url) => loadPhotoSource(url, { timeoutMs: UPGRADE_TIMEOUT_MS, maxSide: UPGRADE_MAX_SIDE }));
}

async function loadPhotoSource(rawUrl, { timeoutMs = 0, maxSide = 0 } = {}) {
  let current = publicHttpsUrl(rawUrl);
  if (!current) return null;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    let response;
    for (let hop = 0; hop < 4; hop++) {
      response = await fetch(current.href, { credentials: "omit", redirect: "manual", cache: "force-cache", signal: controller?.signal });
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
    const longSide = Math.max(bitmap.width, bitmap.height);
    if (!(maxSide > 0 && longSide > maxSide)) return bitmap;
    // Bounds the memory and detector time a very large original would cost.
    const factor = maxSide / longSide;
    try {
      return await createImageBitmap(bitmap, {
        resizeWidth: Math.round(bitmap.width * factor), resizeHeight: Math.round(bitmap.height * factor), resizeQuality: "high",
      });
    } finally {
      bitmap.close();
    }
  } catch {
    // Cross-origin sources without CORS access use the already captured viewport crop.
    return null;
  } finally {
    clearTimeout(timer);
  }
}