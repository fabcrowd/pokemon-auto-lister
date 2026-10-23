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
import { acceptWholePhoto, displayedRegion, dropEdgeFragments, extendClippedBottom, filterPhotoDetections, imageToViewportTransform, mapPhotoBoxToViewport, mergeTileDetections, planHeroCard, rescaleTransform, tileRects } from "./photo-detection.js";
import { choosePageFocus, imageKey, isSealedListing, shouldSuppressCards } from "./lib/page-focus.js";
import { GALLERY_BUDGET_MS, MIN_GALLERY_SIDE, galleryPhotos, mergeAcrossPhotos } from "./lib/gallery.js";
import { cardRoom, captureWait, claimSlot, coveredByBetterView, createScanGate, isCaptureQuotaError, planScreens, samePage, screensCapped, toDocBox } from "./lib/page-scan.js";
import { loadEmbedder, embedCard }    from "./lib/embed.js";
import { rectifyCard }                 from "./lib/rectify.js";
import { adapterActive, catalogRowsWith, configureCatalog, loadCatalog, loadHubPenalty, searchCatalog, physicalHits, scoreIndices, eraHits } from "./lib/search.js";
import { isDemotable } from "./lib/stakes.js";
import { BELOW_HIGH_CONFIDENCE, SMALL_SOURCE_CONFIDENCE_CAP, CONFIRM_MIN_HEIGHT, capAdapterChange, capHeightFor, capUnconfirmedSet, fuseResults, informationHeight, markChoose, markRepeatedNames } from "./lib/fusion.js";
import { setChoices, choiceSummary, versionChoices, choiceName, cardDescribedInText, cardNamedByAttacks, cardNamedInText, descriptionFromCard, attacksFromCard, nameAgrees, nameAlmostAgrees, onlyPromoChoice, extendsTitle, titleVerdict } from "./lib/set-choice.js";
import { eraById, eraPrintings, inEra } from "./lib/era.js";
import { applyTitlePrior, pageSetHint } from "./lib/title-prior.js";
import { setRangeSummary } from "./lib/card-display.js";
import { looksLikeCard, mergeSourceRead, sourceRefineOrder, tileSource } from "./lib/refine.js";
import { asLowCertaintyGuess, candidatesFor, closestMatches, correctionRecord, findCards, isUnsure, pageUrlForStorage, wrongIdOf } from "./lib/card-picker.js";
import { createCorrectionsStore } from "./lib/corrections-store.js";
import { applyMemory, correctionsToEmbed, currentReferences, decodeEmbedding, referenceRow, referencesForExport, singleFlight, withEmbeddings } from "./lib/references.js";
import { CROP_QUALITY, MAX_CROP_CHARS, cropSize, modelTags } from "./lib/contribution.js";
import { agreeWithReference, holdExamPick, storeCorrection } from "./lib/correction-save.js";
import { memoryVerdict } from "./lib/memory-confirm.js";
import { referenceBar } from "./lib/reference-bars.js";
import { whyOf, withVerdicts } from "./lib/why.js";
import { adaptedRows, cardProbability, checkBundle, liveParts, loadStoredBundle, mergeExtra } from "./lib/bundle.js";
import { photoIdFromRgba } from "./lib/photo-id.js";
import { createShareStore } from "./lib/share-store.js";
import { createSharing } from "./lib/sharing.js";
import { PACK_MANIFEST_URL, PACK_PUBLIC_KEY, RELAY_URL } from "./lib/shared-config.js";
import { examGroups, examRows, shareFor, teachRow, wantsExamPrompt } from "./lib/share-rows.js";
import { createUploader } from "./lib/upload-queue.js";
// dev-only:start
import { fitWithin, idWithSize, limitReached, photoRecord, statsFromIds } from "./lib/test-photos.js";
// dev-only:end
import { sendToTab } from "./lib/tab-messaging.js";
import { FACEBOOK_MAX_SIDE, fullSizeCandidates, isFacebookCdn, largerRendition, loadFullSize } from "./lib/full-size.js";
import { applySetPrior, pageSetShares } from "./lib/set-prior.js";
import { hasSiteAccess, siteLabel, siteOrigins } from "./lib/site-access.js";
import { getPptKey } from "./lib/ppt-key.js";
import { chooseFallbackTab, isOwnPage } from "./lib/page-target.js";
import { isCardBack }                  from "./lib/card-back.js";
import { loadNumberReader, readArtStamp, readCardName, readCardNumber, readCardRules, readCollectorCorner, readSourceCorner } from "./lib/ocr.js";
import { choiceFromCorner, cornerRects, parseCornerText } from "./lib/corner-read.js";
import { decideGuesses, withGuess } from "./lib/page-prior.js";
import { setSizes, exactTotalHits, prefixTotals, printingByNumber, blackStarPromo, promoCollectorNumber } from "./lib/card-number.js";
import { publicHttpsUrl }              from "./lib/net.js";
import { loadTileSource as loadTileSourceWith } from "./lib/rendition.js";
import { MAX_PHOTO_BYTES, createBudget, decodePlan, finalUrlAllowed, imageSize, photoTypeVerdict, readCapped, sniffImageType } from "./lib/photo-fetch.js";
import { FIRST_EDITION_MIN_SCORE, editionAfterEreader, editionAfterPromo, editionForSets, grayFromRgba, hasFirstEdition, pricedEdition, stampAfterFirst, stampBelowText, stampScore } from "./lib/edition-stamp.js";
import { SHADOW_MIN_DEPTH, borderEdition, shadowDepth } from "./lib/frame-shadow.js";
import { loadVariantModel, readVariant, variantModelReady } from "./lib/variant-model.js";
import { choiceForStamp, finishFromNumber, finishFromVariants, finishSharedByNumber, stampAfterWizards, stampFromCorner } from "./lib/variant.js";
import { PROMO_STAR_MIN, choicesForSymbol, promoStarScore, symbolFromScores, symbolScores } from "./lib/set-symbol.js";
import { getPrice, getFullCardPayload, extractTcgPlayerId, getTcgdexCard } from "./lib/pricing.js";
import { applySnapshot, currentSnapshot, refreshPriceSnapshot } from "./lib/price-snapshot.js";
import {
  getConditionGrid, fromPokemontcgPayload, fromTcgdexPayload, tcgPlayerIdFromTcgdex,
} from "./lib/condition-pricing.js";

// ─── state ───────────────────────────────────────────────────────────────────

let _ready            = false;
let _meta             = null;
let _metaBase         = null; // meta.json as shipped; _meta is this plus the bundle's new cards
let _idMap            = null;
let _popupWinId       = null;
let _targetTabId      = null;
// Every scan path (button, rescan, lazy-load) goes through this: two scans on one tab would fight over its scroll.
const _scanGate = createScanGate();
// Shared by all scans, since Chrome limits captureVisibleTab per second across them.
let _lastCaptureAt = null;
const PAGE_CHANGED = "The page changed during the scan. Scan again.";

// Rectified card pictures are kept in IndexedDB per scan: the service worker sleeps
// between a scan and the user's pick, and memory does not survive that.
const _corrections = createCorrectionsStore();

// Opt-in shared learning (docs/plans/shared-learning.md). Inert while RELAY_URL is empty.
const local = {
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};
const _shareStore = createShareStore();
const _uploader = createUploader({
  store: _shareStore,
  relayUrl: RELAY_URL,
  backoff: {
    get: async () => (await local.get("shareBackoff")) ?? null,
    set: (state) => local.set("shareBackoff", state),
    clear: () => local.remove("shareBackoff"),
  },
});
const _sharing = createSharing({ storage: local, store: _shareStore, uploader: _uploader, relayUrl: RELAY_URL });
_sharing.enabled().then((on) => on && _uploader.flush()).catch((err) => console.error("[share] startup upload failed:", err?.message || err));

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
  } catch {
    // session storage unavailable (older Chrome or SW start race): keep the in-memory target
  }
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
    _metaBase = _meta;
    await firstBundleCheck();
    await applyBundle();

    _ready = true;
    _loadHubPenalty();
    _loadNumberReader();
    // dev-only:start
    _loadVariantModel();
    // dev-only:end
    embedPendingReferences();
  })();
  try {
    await _loadPromise;
  } finally {
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

// dev-only:start
// The store package excludes models/, so only the dev build looks for the variant model. Scanning works without it.
function _loadVariantModel() {
  fetch(chrome.runtime.getURL("models/variant.onnx"))
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buffer) => (buffer ? loadVariantModel(buffer) : null))
    .then(() => { if (variantModelReady()) console.log("[BG] variant model loaded"); })
    .catch((err) => console.log("[BG] variant model not available", err?.message || err));
}
// dev-only:end

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

// A scan that starts while the reader's files are still loading would read no numbers at all. Never held
// longer than this: a reader that fails to load must not stop scans.
const NUMBER_READER_WAIT_MS = 15000;

async function numberReaderReady() {
  if (!_numberReader) return;
  let timer;
  await Promise.race([_numberReader, new Promise((resolve) => { timer = setTimeout(resolve, NUMBER_READER_WAIT_MS); })]);
  clearTimeout(timer);
}

// ─── message handler ─────────────────────────────────────────────────────────

// Messages that drive the scanner come only from this extension's own pages. A page's content script may
// send newCardsDetected and nothing else.
const OWN_PAGE_ONLY = new Set([
  "checkReady", "startSetup", "detect", "priceCard", "scanPage",
  "clearPageOverlay", "overlayWithGrid", "relayOverlay", "relayClear", "highlightCard",
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
        ...(msg.fullSize ? { fullSize: msg.fullSize } : {}),
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

    case "highlightCard":
      relayToTab({ action: "relayHighlight", index: Number.isInteger(msg.index) ? msg.index : null, scroll: msg.scroll === true });
      sendResponse({ ok: true });
      return false;

    case "newCardsDetected":
      // Content script saw new card-shaped images load (lazy/infinite scroll).
      // Re-scan only when the popup is open, models are ready, and no scan is running.
      // A scan already running on that tab leaves one follow-up for when it ends.
      if (_popupWinId !== null && _ready) {
        const tabId = sender.tab?.id ?? _targetTabId;
        if (!_scanGate.queueFollowUp(tabId)) handleScanPage(sendRescanResult);
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

// A rescan nobody clicked for (pictures that loaded later): the open popup gets its result like a scan it started.
function sendRescanResult(data) {
  if (data && !data.error) chrome.runtime.sendMessage({ action: "rescanResult", data }).catch(() => {});
}

async function handleScanPage(sendResponse, era) {
  console.log("[BG] handleScanPage start; _ready =", _ready, "_targetTabId =", _targetTabId, "era =", era?.id || "any");
  if (!(await _ensureReady(sendResponse))) return;
  await numberReaderReady();
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
  console.log("[BG] scanning tab", targetTab.id, "url", targetTab.url, "window", targetTab.windowId, "photo adapter", adapterActive() ? "on" : "off");
  if (!_scanGate.begin(targetTab.id)) {
    sendResponse({ error: "A scan is already running on this tab." });
    return;
  }
  const scanTabId = targetTab.id;

  try {
    // Ask the page which images look like cards; sendToTab injects the content script if it is not there yet.
    let domResp = await sendToTab(chrome, targetTab.id, { action: "findCards", thumbs: true }).catch((e) => ({ error: e.message }));
    if (domResp?.error) {
      sendResponse({ error: "Could not query page for cards: " + domResp.error });
      return;
    }
    // Marketplace pages often paint the card frame before the photo arrives.
    // Scanning then would report "no cards" and run detection on a blank image.
    if ((domResp.pending || 0) > 0 && !(domResp.cards?.length) && !(domResp.photos?.length)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const again = await sendToTab(chrome, targetTab.id, { action: "findCards", thumbs: true }).catch((e) => ({ error: e.message }));
      if (!again?.error) domResp = again;
    }
    if (!(domResp.cards?.length) && !(domResp.photos?.length) && (domResp.pending || 0) > 0) {
      sendResponse({ error: "Card pictures are still loading. Scan again in a moment." });
      return;
    }
    console.log("[BG] DOM finder returned", (domResp?.cards || []).length, "card-shaped images");

    // A listing has one photo worth scanning; thumbnails and "similar items" belong to other cards.
    const pageFocus = choosePageFocus({
      viewport: { w: domResp.viewportWidth, h: domResp.viewportHeight },
      photos: domResp?.photos || [],
      cards: domResp?.cards || [],
      ogImages: domResp?.page?.ogImages || [],
      headings: domResp?.page?.headings || [],
    });
    const sealed = pageFocus.kind === "listing" && isSealedListing({
      titles: [domResp?.page?.title, domResp?.page?.ogTitle, domResp?.page?.h1],
      sealedLabel: pageFocus.main?.ctx?.sealedLabel === true,
    });
    // What the page says it is about: a set page's heading, its breadcrumb, a lot's title.
    const setHint = pageSetHint([domResp?.page?.h1, domResp?.page?.breadcrumb, domResp?.page?.title, domResp?.page?.ogTitle], catalogSets());
    if (setHint) console.log("[BG] page hint:", setHint);
    console.log("[BG] page focus:", pageFocus.kind, pageFocus.reason, pageFocus.main ? "main " + imageKey(pageFocus.main) : "", sealed ? "(sealed product: cards only if the detector finds some)" : "");
    // The tab may have changed while the content script was answering. Capturing now would
    // crop one page's boxes out of another page's pixels.
    const freshTab = await chrome.tabs.get(targetTab.id).catch(() => null);
    if (!freshTab?.active || freshTab.windowId !== targetTab.windowId) {
      sendResponse({ error: "That tab is no longer in front. Scan again." });
      return;
    }
    targetTab = freshTab;
    const cards = [];
    const scanId = crypto.randomUUID().slice(0, 8);
    const crops = [];
    // One entry per card: which photo it is in and where, for the opt-in sharing; null when that is unknown.
    const shares = [];
    // Where each card sits on the page, so a card seen twice (on two overlapping screens, or as an <img> and
    // the slot behind it) is kept once. A listing's single photo is left as it always was.
    const slots = [];
    const hints = []; // per card: where the page keeps its own picture of a grid tile, for the second look (lib/refine.js)
    const dropped = new Set();
    // Per card read from a listing photo: which photo, how tall it was there, and its embedding, so a card shown in
    // two photos of the gallery is kept once (lib/gallery.js).
    const photoMeta = [];
    let screenNo = 0;
    let offset = { x: 0, y: 0 };
    let capped = false;
    const claim = (box, anchor, area) => {
      const slot = { docBox: toDocBox(box, offset), anchor, area, screen: screenNo };
      if (pageFocus.kind === "listing") return slot;
      const judged = claimSlot(slots, dropped, slot, cards.length - dropped.size);
      if (judged.verdict === "skip") return null;
      if (judged.verdict === "full") { capped = true; return null; }
      // The earlier card is only given up once this one has been read and kept (see pushCard).
      return judged.verdict === "replace" ? { ...slot, replaces: judged.drop } : slot;
    };
    const pushCard = (card, cardCanvas, share = null, slot = null, hint = null) => {
      if (slot?.replaces != null) dropped.add(slot.replaces);
      cards.push(wholePage && slot ? { ...card, docBox: slot.docBox } : card);
      crops.push(encodeCrop(cardCanvas));
      shares.push(share);
      slots.push(slot);
      hints.push(hint);
    };
    // Full-size candidates and redirects may only land on hosts the page itself loaded images from.
    const pageImageHosts = new Set((domResp?.page?.imageHosts || []).map((host) => String(host).toLowerCase()));
    let lackedSiteAccess = false;
    // Photos whose cards came out small while a known-larger rendition stayed unread: offered to the user to open.
    const fullSizeOffers = [];
    // Photos the scan wanted at full size but had no access to read, and how many of them were gallery photos it then
    // skipped: the popup asks for exactly those sites and says what the access would add.
    const unreadSources = new Set();
    let galleryUnread = 0;
    // A grid tile the screenshot crop could not settle gets a second look at the page's own, larger picture of the card.
    // The service worker fetches it with the site access the extension already has (no new permission), so a site that
    // withholds access, a blocked or failed fetch, or a picture that is not card-shaped leaves the tile as it was.
    const refineFromSource = async (list, tileHints) => {
      const order = sourceRefineOrder(list, tileHints, MAX_REFINED_TILES);
      if (!order.length) return;
      const started = Date.now();
      const budget = createBudget(REFINE_BUDGET_MS);
      let failures = 0;
      let refined = 0;
      let settled = 0;
      for (const i of order) {
        if (budget.remaining() <= 0 || failures >= REFINE_MAX_FAILURES) break;
        let bitmap = null;
        try {
          if (!(await canReadPhotoSource(tileHints[i].src))) { failures = REFINE_MAX_FAILURES; break; }
          bitmap = await loadTileSource(tileHints[i].src, { allowedHosts: pageImageHosts, budget, timeoutMs: PHOTO_TIMEOUT_MS, maxSide: PHOTO_MAX_SIDE });
          if (!bitmap || !looksLikeCard(bitmap.width, bitmap.height)) { if (!bitmap) failures++; continue; }
          const tileCanvas = rectifyCard(bitmap, [0, 0, bitmap.width, bitmap.height]);
          const read = await identifyCard(tileCanvas, era, bitmap.height, null, bitmap.height);
          const merged = mergeSourceRead(list[i], read, (r) => asLowCertaintyGuess(r, catalogCard));
          if (merged !== list[i]) {
            refined++;
            if (!merged.lowCertainty) settled++;
            list[i] = merged;
          }
        } catch (err) {
          failures++;
          console.warn("[BG] source look failed", err?.message || err);
        } finally {
          bitmap?.close?.();
        }
      }
      console.log("[BG] source pictures:", order.length, "unsettled tiles looked at,", refined, "re-read,", settled, "settled,", failures, "fetch failures,", (Date.now() - started) + "ms");
    };

    const stops = pageFocus.kind !== "listing" ? planScreens(domResp.documentHeight, domResp.viewportHeight) : [0];
    const wholePage = stops.length > 1;
    const origin = { x: domResp.scrollX || 0, y: domResp.scrollY || 0 };
    let scrolled = false;
    const startUrl = targetTab.url;
    let navigated = false;
    const stayOnPage = async () => {
      if (typeof startUrl !== "string") return;
      const now = await chrome.tabs.get(targetTab.id).catch(() => null);
      if (!now || !samePage(startUrl, now.url)) {
        navigated = true;
        throw new Error(PAGE_CHANGED);
      }
    };
    let stillLoading = domResp.pending || 0;
    let srcWidth = 0;
    let srcHeight = 0;
    // Pictures that load while the page scrolls past must not start another scan.
    if (wholePage) await sendToTab(chrome, targetTab.id, { action: "stopObserving" }).catch(() => {});
    try {
      for (const [stop, y] of stops.entries()) {
        screenNo = stop;
        let screenResp = domResp;
        let focus = pageFocus;
        let domCards = sealed ? [] : pageFocus.cards;
        if (wholePage) {
          if (cardRoom(cards.length - dropped.size) <= 0) { capped = true; break; }
          chrome.runtime.sendMessage({ action: "scanProgress", screen: stop + 1, screens: stops.length }).catch(() => {});
          scrolled = true;
          await sendToTab(chrome, targetTab.id, { action: "scrollTo", x: origin.x, y });
          await stayOnPage();
          screenResp = await sendToTab(chrome, targetTab.id, { action: "findCards", keepAnchors: true });
          await stayOnPage();
          if (screenResp?.error) throw new Error("Could not query page for cards: " + screenResp.error);
          const found = choosePageFocus({
            viewport: { w: screenResp.viewportWidth, h: screenResp.viewportHeight },
            photos: screenResp.photos || [],
            cards: screenResp.cards || [],
            ogImages: domResp?.page?.ogImages || [],
            headings: screenResp?.page?.headings || [],
          });
          // One big picture lower down is still a tile of this page, not a listing's photo.
          focus = found.kind === "listing" ? { ...found, kind: pageFocus.kind, photos: screenResp.photos || [], cards: screenResp.cards || [] } : found;
          domCards = focus.cards;
          offset = { x: screenResp.scrollX || 0, y: screenResp.scrollY || 0 };
          stillLoading = Math.max(stillLoading, screenResp.pending || 0);
        }
        // Pixels the matcher can use for a card: what it is fed, no more than the picture holds. Grid tiles are
        // small by design, so no size cap there.
        const capFor = (fed, naturalPerFed) => capHeightFor(focus.kind, informationHeight(fed, naturalPerFed));

        await sendToTab(chrome, targetTab.id, { action: "hideOverlay" }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, captureWait(_lastCaptureAt, Date.now())));
        await stayOnPage();
        if (wholePage) {
          const current = await chrome.tabs.get(targetTab.id).catch(() => null);
          if (!current?.active || current.windowId !== targetTab.windowId) throw new Error("That tab is no longer in front. Scan again.");
        }
        let dataUrl;
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, { format: "jpeg", quality: 92 });
        } catch (err) {
          if (!isCaptureQuotaError(err)) throw err;
          await new Promise((resolve) => setTimeout(resolve, 600));
          dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, { format: "jpeg", quality: 92 });
        }
        _lastCaptureAt = Date.now();
        const b64 = dataUrl.split(",")[1];
        const bitmap = await b64ToBitmap(b64);
        try {
          // Prefer actual-vs-viewport ratio over DOM-reported devicePixelRatio — some
          // environments (Playwright + Windows HiDPI) report dpr=1 but still capture at 1.5x.
          const dprReported = Number(domResp.devicePixelRatio) || 1;
          const dprMeasured = domResp.viewportWidth ? bitmap.width / domResp.viewportWidth : dprReported;
          const dpr = Math.abs(dprMeasured - dprReported) < 0.05 ? dprReported : dprMeasured;
          console.log("[BG] bitmap", bitmap.width + "x" + bitmap.height, "viewport", domResp.viewportWidth + "x" + domResp.viewportHeight, "dpr reported", dprReported, "measured", dprMeasured.toFixed(3), "using", dpr.toFixed(3));
          const preemptedPhotoKeys = new Set();

          // ── Multi-card photo split ────────────────────────────────────────────
          // Walk every DOM-flagged photo candidate (any sufficiently large image),
          // run YOLO inside it. When ≥ 2 cards are detected we treat it as a lot /
          // multi-card photo and skip the single-card interpretation below.
          // Outside a listing, a large image that is labelled as a sealed product is not scanned for cards.
          const photos = focus.kind === "listing" ? focus.photos : focus.photos.filter((ph) => ph.ctx?.sealedLabel !== true);
          if (photos.length) console.log("[BG]", photos.length, "photo candidates — running YOLO inside each");
          // gallery: the listing's other photos, read from their source images only, within one time budget.
          const scanPhotos = async (list, { gallery = null, firstPhoto = 1 } = {}) => { for (const [listIndex, ph] of list.entries()) {
            const photoNo = focus.kind === "listing" ? firstPhoto + listIndex : undefined;
            if (gallery && gallery.budget.remaining() <= 0) {
              console.log("[BG]   gallery out of time:", list.length - listIndex, "photo(s) left unread");
              break;
            }
            let sx = Math.max(0, Math.round(ph.rect.vx * dpr));
            let sy = Math.max(0, Math.round(ph.rect.vy * dpr));
            let sw = Math.min(bitmap.width  - sx, Math.round(ph.rect.vw * dpr));
            let sh = Math.min(bitmap.height - sy, Math.round(ph.rect.vh * dpr));
            // A gallery slide that is not on screen can only be read from its source image.
            const offscreenSlide = (sw < 150 || sh < 150) && (ph.rect.pvw || 0) >= 150 && (ph.rect.pvh || 0) >= 150;
            const sourceOnly = offscreenSlide || (gallery !== null && (sw < 150 || sh < 150));
            if ((sw < 150 || sh < 150) && !sourceOnly) continue;
            let photoBitmap = null;
            let fromSource = false;
            let sourceTransform = null;
            let upgrade = null;
            try {
              const sourceCanMap = ph.render?.fit !== "background" || ph.render?.repeat === "no-repeat";
              // Without access to the image's site there is nothing to fetch; go straight to the screenshot.
              const sourceReadable = sourceCanMap && await canReadPhotoSource(ph.src);
              if (sourceCanMap && !sourceReadable) {
                lackedSiteAccess = true;
                if (ph.src) unreadSources.add(ph.src);
                if (gallery) galleryUnread += 1;
              }
              // The page shows a thumbnail; a larger rendition of the same picture lets small cards be read.
              const fetchLimits = { allowedHosts: pageImageHosts, budget: createBudget(Math.min(PHOTO_BUDGET_MS, gallery ? gallery.budget.remaining() : Infinity)) };
              upgrade = sourceReadable ? await loadUpgradedSource(ph, domResp?.page?.ogImages, targetTab.url, fetchLimits) : null;
              photoBitmap = upgrade ? upgrade.bitmap
                : sourceReadable ? await loadPhotoSource(ph.src, { ...fetchLimits, timeoutMs: PHOTO_TIMEOUT_MS, maxSide: PHOTO_MAX_SIDE }) : null;
              if (!photoBitmap && sourceOnly) continue;
              if (gallery && photoBitmap && Math.max(photoBitmap.width, photoBitmap.height) < MIN_GALLERY_SIDE) {
                console.log("[BG]   gallery photo", photoNo, "too small to read:", photoBitmap.width + "x" + photoBitmap.height);
                continue;
              }
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
              const shaped = filterPhotoDetections(detectedBoxes, imageW, imageH);
              // A card cut off by the photo edge reads as some other card: leave it out.
              let boxes = dropEdgeFragments(shaped, imageW, imageH);
              if (boxes.length < shaped.length) console.log("[BG]   dropped", shaped.length - boxes.length, "card piece(s) cut off by the photo edge");
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
              const naturalPerFed = fromSource ? upgrade?.naturalPerFed ?? 1
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
              const photoId = photoIdOf(photoPixels);
              const photoFirst = cards.length;
              for (const { box, score } of boxes) {
                const [bx1, by1, bx2, by2] = box;
                if ((bx2 - bx1) < 40 || (by2 - by1) < 60) continue;
                const cardBox = extendClippedBottom(photoPixels.data, photoPixels.width, photoPixels.height, box);
                let viewportBox;
                if (fromSource) {
                  // A card in a gallery thumbnail may lie outside its cropped view: the thumbnail stands for it.
                  viewportBox = mapPhotoBoxToViewport(box, sourceTransform, ph.rect)
                    || (gallery ? [ph.rect.x, ph.rect.y, ph.rect.x + ph.rect.w, ph.rect.y + ph.rect.h] : null);
                  if (!viewportBox) continue;
                } else {
                  viewportBox = [sx + bx1, sy + by1, sx + bx2, sy + by2].map((v) => v / dpr);
                }
                const rectify = (rect) => fromSource
                  ? rectifyCard(photoBitmap, rect)
                  : rectifyCard(bitmap, [sx + rect[0], sy + rect[1], sx + rect[2], sy + rect[3]]);
                const cardCanvas = rectify(box);
                // The hero fallback is never checked: it may be the listing's only card.
                if (!hero && !(await boxLooksLikeCard(cardCanvas))) continue;
                // The number is read from the detector box. The stamp is scored on the
                // box after a clipped yellow border is included, so the card is not stretched.
                const stampCanvas = cardBox[3] === box[3] ? null : rectify(cardBox);
                // One card that fails to read must not drop the rest of the photo.
                const claimed = claim(viewportBox, undefined, (viewportBox[2] - viewportBox[0]) * (viewportBox[3] - viewportBox[1]));
                if (!claimed) continue;
                let read;
                try {
                  read = await identifyCard(cardCanvas, era, by2 - by1, stampCanvas, capFor(by2 - by1, naturalPerFed), { bitmap: photoBitmap, box });
                } catch (err) {
                  console.error("[BG] card read failed:", err?.message || err);
                  read = { identity: null, confidence: 0, abstain: true, market_price: null, price_variant: null, price_grid: null };
                  // An unread view must not replace a card that was read from an earlier screen.
                  if (claimed.replaces != null) continue;
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
                if (gallery && read.cardBack) continue;
                if (photoNo !== undefined) {
                  photoMeta[cards.length] = { photo: photoNo, height: by2 - by1, embedding: await embedSerial(cardCanvas).catch(() => null) };
                }
                pushCard({ box: viewportBox, score, ...read, via: hero ? "hero-" + hero : "yolo-in-photo", photoBoxes: boxes.length,
                  readHeight: Math.round(informationHeight(by2 - by1, naturalPerFed)),
                  ...(photoNo !== undefined ? { photo: photoNo } : {}), ...(gallery ? { inGallery: true } : {}) }, cardCanvas,
                  shareOf(photoId, box, imageW, imageH, read), claimed);
              }
              cards.splice(photoFirst, cards.length - photoFirst, ...await withBestGuesses(cards.slice(photoFirst), setHint));
              {
                // Small cards and a larger picture the scan could not read itself: the user can open that one.
                const read = cards.slice(photoFirst).filter((c) => !c.cardBack);
                const small = read.filter((c) => c.readHeight > 0 && c.readHeight < FULL_SIZE_SMALL_PX).length;
                if (read.length && small >= Math.max(2, read.length / 2)) {
                  if (upgrade) console.log("[BG]   cards small (" + small + "/" + read.length + " under " + FULL_SIZE_SMALL_PX + " px) even in the full-size photo");
                  else {
                    const larger = largerRendition({ src: ph.src, naturalWidth: ph.naturalWidth, naturalHeight: ph.naturalHeight,
                      srcset: ph.sources?.srcset || "", ogImages: domResp?.page?.ogImages, base: targetTab.url });
                    if (larger) {
                      fullSizeOffers.push({ ...larger, shown: [ph.naturalWidth, ph.naturalHeight], small, cards: read.length, ...(photoNo !== undefined ? { photo: photoNo } : {}) });
                      console.log("[BG]   cards small (" + small + "/" + read.length + "); a larger photo is available but unread:", larger.side ? larger.side + " px" : "original upload");
                    }
                  }
                }
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
          const triedFallback = !cards.length && !sealed && focus.kind === "listing" && focus.fallback?.length ? focus.fallback : [];
          if (triedFallback.length) {
            console.log("[BG] main photo held no card — trying", triedFallback.length, "other gallery photos");
            await scanPhotos(triedFallback, { firstPhoto: 2 });
          }

          // A grid tile is its <img> and the slot behind it: read the better view once, not both.
          const betterView = pageFocus.kind === "listing" ? new Set() : coveredByBetterView(domCards.map((dc) => ({
            docBox: toDocBox([dc.rect.x, dc.rect.y, dc.rect.x + dc.rect.w, dc.rect.y + dc.rect.h], offset),
            area: dc.rect.vw * dc.rect.vh,
          })));
          // The picture the page keeps of a tile: its own <img>, or that of the view lying over the same spot.
          const tileHint = (index, shownPx) => {
            const found = tileSource(domCards, index);
            return found ? { ...found, shownPx } : null;
          };
          for (const [dcIndex, dc] of domCards.entries()) {
            if (betterView.has(dcIndex)) continue;
            // Skip the single-card interpretation when this image was already split by YOLO
            // into multiple cards (handled above). Compare by key constructed the same way.
            if (preemptedPhotoKeys.has(_photoKey(dc))) continue;

            // Crop the visible slice of this image in physical pixels.
            const sx = Math.max(0, Math.round(dc.rect.vx * dpr));
            const sy = Math.max(0, Math.round(dc.rect.vy * dpr));
            const sw = Math.min(bitmap.width  - sx, Math.round(dc.rect.vw * dpr));
            const sh = Math.min(bitmap.height - sy, Math.round(dc.rect.vh * dpr));
            if (sw < 20 || sh < 30) continue;
            const claimed = claim([dc.rect.x, dc.rect.y, dc.rect.x + dc.rect.w, dc.rect.y + dc.rect.h], dc.anchor, dc.rect.vw * dc.rect.vh);
            if (!claimed) continue;

            // Build the 750x1050 rectified canvas the embedder expects.
            const cardCanvas = rectifyCard(bitmap, [sx, sy, sx + sw, sy + sh]);
            const naturalPerFed = dc.naturalHeight > 0 && dc.rect.h > 0 ? dc.naturalHeight / (dc.rect.h * dpr) : undefined;
            // A tile nothing could settle is shown as its best guess, unsure, with the closest cards to pick from.
            const read = asLowCertaintyGuess(await identifyCard(cardCanvas, era, sh, null, capFor(sh, naturalPerFed)), catalogCard);
            if (focus.kind === "listing") photoMeta[cards.length] = { photo: 1, height: sh, embedding: await embedSerial(cardCanvas).catch(() => null) };
            pushCard({
              box: [dc.rect.x, dc.rect.y, dc.rect.x + dc.rect.w, dc.rect.y + dc.rect.h],
              score: 1.0,
              ...read,
              readHeight: Math.round(informationHeight(sh, naturalPerFed)),
              ...(focus.kind === "listing" ? { photo: 1 } : {}),
            }, cardCanvas, shareOf(photoIdOf(readBitmap(cardCanvas)), [0, 0, cardCanvas.width, cardCanvas.height], cardCanvas.width, cardCanvas.height, read), claimed,
            read.lowCertainty ? tileHint(dcIndex, sh) : null);
          }

          // The listing's other photos: close-ups of a lot are where its cards can be read. Related-item carousels are
          // never part of this. Without site access their sources cannot be fetched and only the main photo is read.
          if (!sealed && focus.kind === "listing" && focus.main) {
            const gallery = galleryPhotos({
              main: focus.main,
              candidates: [...(focus.fallback || []), ...(screenResp.thumbs || [])].filter((ph) => !triedFallback.includes(ph)),
              headings: screenResp?.page?.headings || [],
              pageUrl: targetTab.url,
            });
            if (gallery.length) {
              console.log("[BG] gallery:", gallery.length, "more photo(s) of this listing");
              await scanPhotos(gallery, { gallery: { budget: createBudget(GALLERY_BUDGET_MS) }, firstPhoto: 2 + triedFallback.length });
            }
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
              let viewportId;
              for (const { box, score } of yoloBoxes) {
                const [x1, y1, x2, y2] = box;
                if ((x2 - x1) < 40 || (y2 - y1) < 60) continue;
                const claimed = claim([x1 / dpr, y1 / dpr, x2 / dpr, y2 / dpr], undefined, (x2 - x1) * (y2 - y1) / (dpr * dpr));
                if (!claimed) continue;
                const cardCanvas = rectifyCard(bitmap, box);
                const read = await identifyCard(cardCanvas, era, y2 - y1, null, capFor(y2 - y1));
                viewportId ??= photoIdOf(readBitmap(bitmap));
                pushCard({
                  box: [x1 / dpr, y1 / dpr, x2 / dpr, y2 / dpr],
                  score,
                  ...read,
                  via: "yolo-viewport",
                }, cardCanvas, shareOf(viewportId, box, bitmap.width, bitmap.height, read), claimed);
              }
            } catch (err) {
              console.error("[BG] YOLO viewport fallback failed:", err?.message || err);
            }
          }


          // Read the size before closing the bitmap. A missing viewport size used to throw
          // after close() and the scan died after the cards were already found.
          srcWidth  = domResp.viewportWidth  || Math.round(bitmap.width  / dpr);
          srcHeight = domResp.viewportHeight || Math.round(bitmap.height / dpr);
        } finally {
          bitmap.close();
        }
      }
    } finally {
      if (scrolled && !navigated) await sendToTab(chrome, targetTab.id, { action: "scrollTo", x: origin.x, y: origin.y }).catch(() => {});
      if (wholePage && !navigated) await sendToTab(chrome, targetTab.id, { action: "startObserving" }).catch(() => {});
    }

    // A card shown in more than one photo of the listing is kept once, as its best read.
    if (pageFocus.kind === "listing" && new Set(photoMeta.filter(Boolean).map((r) => r.photo)).size > 1) {
      const indexes = photoMeta.map((r, i) => (r && !dropped.has(i) ? i : -1)).filter((i) => i >= 0);
      const { drop, photos: seenIn, similar } = mergeAcrossPhotos(indexes.map((i) => ({ ...photoMeta[i], card: cards[i] })));
      for (const k of drop) dropped.add(indexes[k]);
      for (const [k, seen] of seenIn) cards[indexes[k]] = { ...cards[indexes[k]], photos: seen };
      console.log("[BG] gallery:", drop.size, "card(s) seen in more than one photo kept once", similar?.length ? "(closest cross-photo pairs " + similar.join(" ") + ")" : "");
    }
    // Cards outside any split photo (a single listing picture, a grid tile) still get a best guess.
    if (dropped.size) {
      const keep = (_, i) => !dropped.has(i);
      cards.splice(0, cards.length, ...cards.filter(keep));
      crops.splice(0, crops.length, ...crops.filter(keep));
      shares.splice(0, shares.length, ...shares.filter(keep));
      hints.splice(0, hints.length, ...hints.filter(keep));
    }
    await refineFromSource(cards, hints);
    if (pageFocus.kind !== "listing") {
      const shares = pageSetShares(cards, { hint: setHint });
      const before = cards.map((c) => c.identity?.id);
      cards.splice(0, cards.length, ...cards.map((card) => applySetPrior(card, shares, catalogCard)));
      const moved = cards.filter((c, i) => c.identity?.id !== before[i]).length;
      if (shares.size) console.log("[BG] set prior", JSON.stringify([...shares].map(([k, v]) => [k, Math.round(v * 100) / 100])), "moved", moved, "best guesses");
    }
    cards.splice(0, cards.length, ...await withBestGuesses(cards, setHint));
    if (shouldSuppressCards({ sealed, detectedCards: cards.length })) console.log("[BG] sealed product and no cards detected: nothing to report");
    const identified = cards.filter((c) => !c.abstain).length;
    console.log("[BG] identified", identified, "/", cards.length, "cards");
    const guessed = cards.filter((c) => c.lowCertainty).length;
    if (guessed) console.log("[BG] best guesses (low certainty, user picks)", guessed, "of those", identified);

    await relayToTab({ action: "relayOverlay", cards, srcWidth, srcHeight }, targetTab.id);
    console.log("[BG] overlay relayed");

    // Ask the content script to start watching for lazy-loaded card images.
    sendToTab(chrome, targetTab.id, { action: "startObserving" }).catch(() => {});

    const encoded = await Promise.all(crops);
    await _corrections.saveScan({ scanId, ts: Date.now(), pageUrl: pageUrlForStorage(targetTab.url), crops: encoded, shares })
      .catch((err) => console.error("[BG] keeping scan pictures failed:", err?.message || err));
    // An asked card carries the picture it was read from, so the user can see which card the question is about.
    // `ranked` (id, rank, cosine score) rides along so the popup can judge how far the first candidate leads; the set prior ran before.
    // A confirmed card the stakes rule may still demote (lib/stakes.js) carries them too, so a demotion has a picker to show.
    const withCandidates = cards.map(({ rankedScores, ...card }, i) => (isUnsure(card) || isDemotable(card)
      ? { ...card, candidates: candidatesFor(card, _meta, 5, era), ...(card.ranked || !rankedScores?.length ? {} : { ranked: rankedScores }), crop: encoded[i] ?? null }
      : card));
    const asked = applyTitlePrior(withCandidates, {
      kind: pageFocus.kind,
      page: domResp?.page,
      knownNames: catalogNames(),
      log: (message) => console.log("[BG]", message),
    });

    // Offered only to someone who opted in; the exam photos themselves are held out of local learning either way.
    const shareExam = wantsExamPrompt(shares) && await _sharing.enabled().catch(() => false);
    sendResponse({ cards: asked, scanId, srcWidth, srcHeight, targetTabId: targetTab.id, pending: stillLoading, pageKind: pageFocus.kind, sealedProduct: sealed, shareExam,
      ...(fullSizeOffers.length ? { fullSizePhoto: fullSizeOffers.sort((a, b) => b.small - a.small)[0] } : {}),
      truncated: capped ? "cards" : wholePage && screensCapped(domResp.documentHeight, domResp.viewportHeight) ? "screens" : null,
      ...(lackedSiteAccess ? { usedScreenshotPath: true, reason: "no-site-access", accessSite: siteLabel(targetTab.url),
        accessOrigins: siteOrigins(targetTab.url, [...unreadSources]), galleryUnread } : {}) });
  } catch (err) {
    console.error("[BG] handleScanPage error:", err?.message || err);
    sendToTab(chrome, targetTab.id, { action: "restoreOverlay" }).catch(() => {});
    sendResponse({ error: String(err?.message || err) });
  } finally {
    if (_scanGate.end(scanTabId) && _popupWinId !== null) handleScanPage(sendRescanResult);
  }
}

// ─── corrections ─────────────────────────────────────────────────────────────

function photoIdOf(pixels) {
  try {
    return photoIdFromRgba(pixels);
  } catch (err) {
    console.error("[BG] photo id failed:", err?.message || err);
    return null;
  }
}

const shareOf = (photoId, box, width, height, card) => (photoId ? shareFor({ photoId, box, width, height, card }) : null);

// A scan keeps its pictures at 375x525; the relay gets them smaller (docs/plans/shared-learning.md). Null when none fits.
async function shareCrop(cropDataUrl) {
  if (typeof cropDataUrl !== "string") return null;
  const bitmap = await b64ToBitmap(cropDataUrl.replace(/^data:image\/jpeg;base64,/, ""));
  try {
    const { width, height } = cropSize(bitmap.width, bitmap.height);
    for (const quality of [CROP_QUALITY, 0.6, 0.45]) {
      const text = (await jpegDataUrl(bitmap, width, height, quality)).replace(/^data:image\/jpeg;base64,/, "");
      if (text.length <= MAX_CROP_CHARS) return text;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

// Never lets sharing break the pick the user made.
async function contributeTeachPick(scan, msg) {
  try {
    const share = scan?.shares?.[msg.index];
    if (!share || share.split !== "teach" || !(await _sharing.enabled())) return;
    const crop = await shareCrop(scan.crops?.[msg.index]);
    if (!crop) return;
    await _sharing.contribute({ photoId: share.photoId, cards: [teachRow({ share, crop, pickedId: msg.pickedId, via: msg.via })] });
  } catch (err) {
    console.error("[BG] sharing a pick failed:", err?.message || err);
  }
}

async function confirmExam(msg) {
  if (!(await _sharing.enabled())) return { ok: false };
  await _ensureCatalog();
  const scan = typeof msg.scanId === "string" ? await _corrections.getScan(msg.scanId).catch(() => null) : null;
  if (!scan?.shares || scan.examSent) return { ok: Boolean(scan?.examSent) };
  const displayed = {};
  for (const answer of Array.isArray(msg.answers) ? msg.answers : []) {
    if (Number.isInteger(answer?.index)) displayed[answer.index] = answer;
  }
  const crops = await Promise.all(scan.crops.map((crop) => shareCrop(crop).catch(() => null)));
  const known = (id) => Boolean(catalogCard(id));
  let sent = 0;
  for (const [photoId, indices] of examGroups(scan.shares)) {
    const cards = examRows({ shares: scan.shares, indices, crops, picks: scan.examPicks || {}, displayed, known });
    if (!cards) continue;
    try {
      if (await _sharing.contribute({ photoId, cards })) sent += 1;
    } catch (err) {
      console.error("[BG] sharing an exam photo failed:", err?.message || err);
    }
  }
  await _corrections.saveScan({ ...scan, examSent: true }).catch(() => {});
  return { ok: true, sent };
}

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
    // An exam photo's answers leave only as a whole, when sharing is on and the user confirms the photo; they never enter
    // the shared training queue. That is the only thing the exam split decides: the correction itself is always kept here.
    await holdExamPick(_corrections, scan, msg, await _sharing.enabled().catch(() => false));
    // The same card the user corrected before, confirmed again from a different crop: that counts as "x2" on the earlier
    // correction instead of storing a near-duplicate picture.
    const agreed = await agreeWithReference(_corrections, msg);
    if (agreed) {
      referencesChanged();
      contributeTeachPick(scan, msg);
      return { ok: true, count: agreed.count, agreed: true, remembered: await referencesInUse() };
    }
    const wrongId = wrongIdOf(msg.guess?.id, msg.pickedId, (id) => catalogCard(id)?.name);
    const draft = correctionRecord({
      ts: Date.now(),
      scanId: msg.scanId,
      index: msg.index,
      pageUrl: scan?.pageUrl,
      guess: msg.guess,
      pickedId: msg.pickedId,
      via: msg.via,
      crop: scan?.crops?.[msg.index],
      extVersion: chrome.runtime.getManifest().version,
      why: msg.guess?.why,
      wrongId,
    });
    // History, the x2 count, the cap and a full disk are handled in lib/correction-save.js.
    const record = await storeCorrection(_corrections, draft);
    referencesChanged();
    if (_ready) embedPendingReferences();
    contributeTeachPick(scan, msg);
    return { ok: true, count: record.count, remembered: await referencesInUse() };
  },
  confirmExam: (msg) => confirmExam(msg),
  shareStatus: async () => ({ available: _sharing.available(), enabled: await _sharing.enabled(), installId: await _sharing.installId() }),
  setSharing: async (msg) => {
    if (msg.enabled === true) await _sharing.enable();
    else await _sharing.disable();
    return { available: _sharing.available(), enabled: await _sharing.enabled(), installId: await _sharing.installId() };
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

let _packRows = [];
let _photoCheck = null;

const packBuild = () => {
  const { clip, crop } = modelTags();
  return { model: clip, crop };
};

let _applying = Promise.resolve();

// Puts the stored bundle live without a reload: memory rows, the "is this a card" check, new catalog cards and
// the photo adapter. Everything slow is done first and the swap is synchronous, so a scan sees the old bundle or
// the new one, never half of it. A failure leaves what was live.
function applyBundle() {
  _applying = _applying.then(applyBundleOnce).catch((err) => console.error("[BG] bundle not applied:", err?.message || err));
  return _applying;
}

async function applyBundleOnce() {
  if (!_metaBase) return;
  const stored = await loadStoredBundle(_shareStore, packBuild());
  const merged = stored?.extra ? mergeExtra(_metaBase, stored.extra) : null;
  let adapter = null;
  let adapted = null;
  if (stored?.adapter) {
    try {
      const rows = catalogRowsWith(merged?.rows);
      const key = [stored.manifest.assets.adapter.sha256, stored.manifest.assets.catalogExtra?.sha256 ?? "-", rows.length, modelTags().catalog].join(":");
      adapted = await adaptedRows({ store: _shareStore, key, rows, adapter: stored.adapter });
      adapter = stored.adapter;
    } catch (err) {
      console.error("[BG] photo adapter not applied:", err?.message || err);
    }
  }
  configureCatalog({ extra: merged?.rows ?? null, adapter, adapted });
  _meta = merged ? _metaBase.concat(merged.meta) : _metaBase;
  _catalogNames = _indicesByName = _setSizes = _metaById = _catalogSets = _metaRank = null;
  _packRows = stored?.memory ?? [];
  _photoCheck = stored?.check ?? null;
  console.log("[BG] bundle live:", liveParts(stored, { adapter, extra: merged }));
  if (adapter) console.log("[BG] photo adapter in use: rank", adapter.rank, "sha", stored.manifest.assets.adapter.sha256.slice(0, 8), "seq", stored.manifest.seq);
  else console.log("[BG] photo adapter not in use:", stored ? "the bundle has none" : "no bundle stored yet");
}

// At most one check a day (lib/bundle.js); nothing about the user is sent.
const _bundleCheck = checkBundle({
  manifestUrl: PACK_MANIFEST_URL,
  publicKey: PACK_PUBLIC_KEY,
  expected: packBuild(),
  store: _shareStore,
  state: { get: () => local.get("packCheck"), set: (value) => local.set("packCheck", value) },
}).then((result) => {
  if (result.status === "ok") applyBundle();
  else if (result.status !== "inert" && result.status !== "skipped") console.log("[BG] bundle not used:", result.status);
}).catch((err) => console.error("[BG] bundle check failed:", err?.message || err));

const FIRST_BUNDLE_WAIT_MS = 8000;

// Right after install nothing is stored yet, and the first scans ran on the bare catalog while the bundle (with
// the photo adapter) was still downloading. With nothing stored, the models wait a few seconds for that check.
async function firstBundleCheck() {
  const stored = await _shareStore.getPack().catch(() => null);
  if (stored) return;
  let timer;
  await Promise.race([_bundleCheck, new Promise((resolve) => { timer = setTimeout(resolve, FIRST_BUNDLE_WAIT_MS); })]);
  clearTimeout(timer);
}

// The data repo publishes one price file a day. A failed download keeps the copy already stored.
refreshPriceSnapshot().catch((err) => console.error("[BG] price snapshot not updated:", err?.message || err));

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
    // On unless the user switched it off.
    return (await chrome.storage.local.get("useReferences")).useReferences !== false;
  } catch {
    return false;
  }
}

// A scan and a reference pass can both want the embedder, and one session cannot run twice at once.
// A canvas is embedded once: the photo check and the read that follows it share the result.
const _embedded = new WeakMap();
function embedSerial(canvas) {
  const known = _embedded.get(canvas);
  if (known) return known;
  const run = _embedQueue.then(() => embedCard(canvas));
  _embedQueue = run.catch(() => {});
  _embedded.set(canvas, run);
  run.catch(() => _embedded.delete(canvas));
  return run;
}

// The pipeline's "is this a card" check, on the raw embedding of a detected box. A failure keeps the box.
async function boxLooksLikeCard(canvas) {
  if (!_photoCheck) return true;
  try {
    const p = cardProbability(await embedSerial(canvas), _photoCheck);
    if (p >= _photoCheck.threshold) return true;
    console.log("[BG]   box dropped by the card check, p=" + p.toFixed(2));
    return false;
  } catch (err) {
    console.error("[BG] card check failed:", err?.message || err);
    return true;
  }
}

// A reference only reorders cards the catalog already returned, at the catalog's own top score, so a
// reprint of a corrected card is not made certain. Any failure leaves the catalog hits as they were.
async function withReferenceHit(embedding, hits, rawTop = hits[0]?.score ?? 0, height = 0) {
  try {
    // The community pack is in use only after it passed the exam gate (lib/bundle.js); the user's own rows need their setting.
    const own = (await referencesInUse()) ? await loadedReferences() : [];
    const pack = _packRows;
    // Same as pipeline/gate.py: the raw embedding against the rows, beaten against the raw catalog top score.
    return applyMemory(embedding, own, hits, rawTop, _meta, { height, pack });
  } catch (err) {
    console.error("[BG] reference lookup failed:", err?.message || err);
    return { hits, referencedId: null, memory: null };
  }
}

// The normal (adapted, when a photo adapter is live) hits, and the raw ones the gate also scores. They are the
// same array when no adapter is live.
async function searchBoth(embedding) {
  const penalty = await lookalikePenaltyInUse();
  const hits = physicalHits(searchCatalog(embedding, 20, { penalty }), _meta);
  const rawHits = adapterActive() ? physicalHits(searchCatalog(embedding, 20, { penalty, raw: true }), _meta) : hits;
  return { hits, rawHits };
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
      const { hits: catalogHits, rawHits } = await searchBoth(embedding);
      if (isCardBack(embedding, rawHits[0]?.score ?? 0)) {
        cards.push({ box, score, identity: null, confidence: 0, abstain: true, cardBack: true, market_price: null, price_variant: null });
        continue;
      }
      const { hits }   = await withReferenceHit(embedding, catalogHits, rawHits[0]?.score ?? 0);
      const { identity, confidence, abstain } = capAdapterChange(fuseResults(hits, null, _meta, _idMap), hits, rawHits, _meta);
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
    ? { action: "showOverlay", cards: msg.cards, srcWidth: msg.srcWidth, srcHeight: msg.srcHeight, ...(msg.fullSize ? { fullSize: msg.fullSize } : {}) }
    : msg.action === "relayHighlight"
      ? { action: "highlightCard", index: msg.index, scroll: msg.scroll }
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

// The number is read from the source picture's own pixels when a set is still open: a card in a lot photo is a
// few hundred pixels tall, too small for the 750x1050 rectified copy to carry its collector number.
// Each try costs about a second. On 67 HiBid lot photos no card under 400 source px gave a number that settled its set.
const CORNER_MIN_HEIGHT = 400;

async function settleFromCorners(result, numberSource) {
  if (!numberSource || result.abstain || (result.setChoices?.length || 0) < 2) return;
  if (numberSource.box[3] - numberSource.box[1] < CORNER_MIN_HEIGHT) return;
  await numberReaderReady();
  _setSizes ??= setSizes(_meta);
  const { bitmap, box } = numberSource;
  for (const { side, rect } of cornerRects(box, bitmap.width, bitmap.height)) {
    for (const enhance of [false]) {
      let text = "";
      try {
        text = await readSourceCorner(bitmap, rect, box[3] - box[1], enhance);
      } catch (err) {
        console.log("[BG] corner read failed:", err?.message || err);
        continue;
      }
      const read = parseCornerText(text);
      console.log("[BG] corner", side, enhance ? "+" : "=", JSON.stringify(text), read ? "→ " + read.number + (read.total ? "/" + read.total : "") + (read.code ? " " + read.code : "") : "no number");
      const hit = choiceFromCorner(result.setChoices, read, _setSizes);
      const identity = hit ? catalogCard(hit.choice.id) : null;
      if (!identity) continue;
      console.log("[BG] corner number", hit.via, identity.id);
      result.identity = identity;
      result.setChoices = undefined;
      result.abstain = false;
      result.setEvidence = hit.via === "code" ? "code" : "number";
      result.numberRead = read.total ? `${read.number}/${read.total}` : read.number;
      Object.assign(result, await priceIdentity(identity));
      return;
    }
  }
}

// Source pixels of card height; below this the stamp is a few blurry pixels.
const STAMP_MIN_HEIGHT = 400;
const STAMP_CARD_W = 375;
const STAMP_CARD_H = 525;

/**
 * Recognize one card, then look for the 1st Edition stamp when its set (or any set
 * the user may pick) was printed in 1st Edition. `firstEdition` stays unset otherwise.
 * A stamp rules out the set choices that never had a 1st Edition.
 */
async function identifyCard(cardCanvas, era = null, sourceHeight = 0, stampCanvas = null, capHeight = sourceHeight, numberSource = null) {
  const read = await identifyFully(cardCanvas, era, sourceHeight, stampCanvas, numberSource, capHeight);
  console.log("[BG]   card h=" + Math.round(sourceHeight), "info=" + Math.round(capHeight), "conf=" + (read.confidence ?? 0).toFixed?.(2), read.abstain ? "abstain" : "named", read.identity?.name ?? "-", "top=" + (read.catalogTop?.toFixed?.(2) ?? "-"));
  // A set that is still open (several printings of the same art) is never shown as high; a number, symbol or stamp read has already settled it by now.
  const settled = capUnconfirmedSet(await withSetRange(read));
  const checked = await checkTitle(markChoose(settled, capHeight), cardCanvas, capHeight, era);
  // The title verdict, the stripe and a number read are only known now: they complete the why-record.
  return checked?.why ? { ...checked, why: withVerdicts(checked.why, checked) } : checked;
}

// The title line is read from crops this tall up: the confirm rule (lib/fusion.js) uses it before it decides, and
// nothing below the rule's own minimum height can confirm.
const TITLE_MIN_HEIGHT = CONFIRM_MIN_HEIGHT;
const TITLE_RERANK_DEPTH = 20;

/**
 * The card's own title line as a second opinion on the picture match (lib/set-choice.js titleVerdict).
 * Its demotion already acted inside the confirm rule (recognizeWith). Naming another catalog card, that card
 * becomes the guess when it is among the closest matches, else the picture's name is only asked about.
 * Silent, nothing changes. A changed name is always asked about, never shown as identified.
 */
async function checkTitle(result, cardCanvas, height, era) {
  if (!result || result.cardBack || result.numberRead || !(height >= TITLE_MIN_HEIGHT)) return result;
  const name = result.abstain ? null : result.identity?.name || null;
  let text = "";
  try {
    text = await readOnce(cardCanvas, "name", readCardName);
  } catch (err) {
    console.log("[BG]   title read failed:", err?.message || err);
    return result;
  }
  const verdict = titleVerdict(name, text, catalogNames());
  if (verdict.kind === "silent") return result;
  // Agreeing adds nothing to the confirm rule (no bonus), so a CHOOSE stays one.
  if (verdict.kind === "agree") return { ...result, titleConfirmed: true };
  const { hits } = await searchBoth(await embedSerial(cardCanvas));
  const wanted = choiceName(verdict.titleName);
  const hit = hits.slice(0, TITLE_RERANK_DEPTH).find((h) => {
    const card = _meta[h.index];
    return card && choiceName(card.name) === wanted && (!era || inEra(card, era));
  });
  // "Gyarados" also names "Gyarados EX", whose logo is not on the line read: no rerank when such a card is close.
  const longer = hits.slice(0, TITLE_RERANK_DEPTH).some((h) => _meta[h.index] && extendsTitle(_meta[h.index].name, verdict.titleName));
  if (hit && !longer) {
    console.log("[BG]   title says", JSON.stringify(verdict.titleName), "not", JSON.stringify(name ?? "-"), "- asked with that name");
    return guessFromTitle(_meta[hit.index], hits, result);
  }
  if (!name) return result;
  console.log("[BG]   title says", JSON.stringify(verdict.titleName), "not", JSON.stringify(name), "- asked");
  return { ...result, confidence: Math.min(result.confidence ?? 0, SMALL_SOURCE_CONFIDENCE_CAP), unsure: true, titleContradicts: verdict.titleName };
}

async function guessFromTitle(card, hits, before) {
  const base = {
    confidence: Math.min(Math.max(before.confidence ?? 0, 0), SMALL_SOURCE_CONFIDENCE_CAP),
    abstain: false,
    unsure: true,
    titleReranked: true,
    catalogTop: before.catalogTop ?? null,
    ocrText: before.ocrText || "",
    nearest: closestIds(hits),
    ranked: rankedIds(hits),
  };
  const choices = setChoices(card, hits, _meta);
  if (choices.length > 1) {
    return withSetRange({
      ...base,
      identity: { name: card.name },
      setChoices: choices.map((row) => ({ ...choiceSummary(row), score: hitScore(hits, row.id) })),
      market_price: null, price_variant: null, price_grid: null,
    });
  }
  return { ...base, identity: card, ...(await priceIdentity(card)) };
}

// The closest cards with the rank they were ordered by and their cosine score, for the page's set prior to re-order (lib/set-prior.js).
function rankedIds(hits, limit = 10) {
  const out = [];
  for (const hit of hits || []) {
    const id = _meta[hit?.index]?.id;
    if (id && !out.some((o) => o.id === id)) out.push({ id, rank: Math.round((hit.rank ?? hit.score) * 10000) / 10000, score: Math.round(hit.score * 10000) / 10000 });
    if (out.length >= limit) break;
  }
  return out;
}

// A row whose printing is still open is shown as its best guess: the set the page names, else the set the page's settled cards share, else
// the printing the picture scored highest. The Set? menu stays, and a correction there is saved like any other.
async function withBestGuesses(reads, setHint = null) {
  const decisions = decideGuesses(reads, { hint: setHint, rank: catalogRank });
  const out = [];
  for (let i = 0; i < reads.length; i++) {
    const decision = decisions[i];
    const card = decision ? catalogCard(decision.choice.id) : null;
    if (!card) {
      out.push(reads[i]);
      continue;
    }
    let priced = { market_price: null, price_variant: null, price_grid: null };
    try {
      priced = await priceIdentity(card);
    } catch (err) {
      console.log("[BG] no price for", card.id, err?.message || err);
    }
    console.log("[BG] best guess", card.id, decision.source);
    out.push(withGuess(reads[i], decision, card, priced));
  }
  return out;
}

// A name whose set is still open is shown with what the candidate printings sell for, so the row is useful before anyone picks.
async function withSetRange(read) {
  const choices = read.setChoices || [];
  if (read.abstain || choices.length < 2 || read.setRange) return read;
  const setRange = await rangeOfChoices(choices);
  return setRange ? { ...read, setRange } : read;
}

// Every candidate counts toward "N of M sets priced", including one whose price could not be fetched.
async function rangeOfChoices(choices) {
  const priced = [];
  for (const choice of choices) {
    const card = catalogCard(choice.id);
    let price = {};
    try {
      if (card) price = await priceIdentity(card);
    } catch (err) {
      console.log("[BG] no price for", choice.id, err?.message || err);
    }
    priced.push(price);
  }
  return setRangeSummary(priced);
}

async function identifyFully(cardCanvas, era, sourceHeight, stampCanvas, numberSource = null, capHeight = sourceHeight) {
  const result = await recognizeCard(cardCanvas, era, sourceHeight, capHeight);
  if (result.numberRead && result.identity?.id && !result.setChoices) result.setEvidence = "number";
  await settleFromCorners(result, numberSource);
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
    // Read from the printed number, not the picture, so it may price without the user's confirmation.
    result.finishSure = numberedFinish;
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
      result.setEvidence = "stamp";
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
        result.setEvidence = "symbol";
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
        result.setEvidence = "number";
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
      result.finishSure = finish;
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
  // The stamp is a template score on pixels, not text: it points at the one 1st Edition set but only preselects it.
  // The choices stay open (a range) until the user confirms with the "?" control.
  return { ...result, suggestedSetId: stamped[0].id };
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
const closestIds = (hits) => closestMatches(hits, _meta).map((row) => row.id);

async function recognizeCard(cardCanvas, era = null, sourceHeight = 0, capHeight = sourceHeight) {
  const seen = {};
  const result = await recognizeWith(cardCanvas, era, sourceHeight, seen, capHeight);
  // catalogTop is saved with a correction so the margin can be measured later; referencedId puts that card first among the candidates.
  return { ...result, rankedScores: seen.ranked, catalogTop: seen.catalogTop ?? null, ...(seen.referencedId ? { referencedId: seen.referencedId } : {}), ...(seen.memory ? { memory: seen.memory } : {}),
    ...(seen.confirmedBy ? { confirmedBy: seen.confirmedBy } : {}), ...(seen.why && !result.abstain ? { why: seen.why } : {}), ...(seen.choose && !result.numberRead ? { choose: true } : {}),
    ...(seen.smallRowCos != null && !result.numberRead ? { smallRow: true, smallRowCos: seen.smallRowCos } : {}) };
}

// What the confirm rule (lib/fusion.js) needs besides the matches: the card's read height and, from crops tall
// enough to read, whether the title line spells another catalog name than a candidate's. A failed read is silent.
async function confirmContext(cardCanvas, capHeight) {
  const options = { height: capHeight };
  if (!(capHeight >= TITLE_MIN_HEIGHT)) return options;
  let text = "";
  try {
    text = await readOnce(cardCanvas, "name", readCardName);
  } catch (err) {
    console.log("[BG]   title read failed:", err?.message || err);
    return options;
  }
  const known = catalogNames();
  return { ...options, contradicts: (name) => Boolean(name) && titleVerdict(name, text, known).kind === "contradict" };
}

async function recognizeWith(cardCanvas, era, sourceHeight, seen, capHeight = sourceHeight) {
  const embedding = await embedSerial(cardCanvas);
  const { hits: catalogHits, rawHits } = await searchBoth(embedding);
  seen.catalogTop = rawHits[0]?.score ?? null;
  if (isCardBack(embedding, rawHits[0]?.score ?? 0)) {
    return { identity: null, confidence: 0, abstain: true, cardBack: true, market_price: null, price_variant: null, price_grid: null };
  }
  // The user said when these cards are from: the name, the set choices and the closest cards offered all come from that era's rows,
  // so a modern card that outscores every printing from the era can neither name the card nor be suggested for it.
  const inEraHits = era ? eraHits(embedding, _meta, era) : null;
  const { hits, referencedId, memory } = await withReferenceHit(embedding, inEraHits ?? catalogHits, rawHits[0]?.score ?? 0, capHeight);
  seen.referencedId = referencedId;
  seen.memory = memory;
  seen.ranked = rankedIds(hits);
  const confirm = await confirmContext(cardCanvas, capHeight);
  const pictureRead = capAdapterChange(fuseResults(hits, null, _meta, _idMap, confirm), hits, inEraHits ? hits : rawHits, _meta, confirm);
  // The user's own earlier correction may confirm the card (source "your correction"), or stop a card they called wrong.
  const verdict = memoryVerdict(pictureRead, memory, { hits, meta: _meta });
  const fused = verdict.fused;
  seen.confirmedBy = verdict.confirmedBy;
  const whyFor = (src) => whyOf({
    src,
    hits, ranked: seen.ranked, meta: _meta, height: capHeight, tags: modelTags(),
    ref: memory && !memory.pack ? { id: memory.refId, cos: memory.cos, n: memory.n, ts: memory.ts, bar: referenceBar(capHeight)?.confirm } : undefined,
  });
  seen.why = whyFor(verdict.confirmedBy ? "correction" : "picture");
  const { identity, confidence, abstain } = fused;
  seen.choose = fused.choose === true;
  seen.smallRowCos = fused.smallRow === true ? fused.smallRowCos : null;
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
      // Kept so a card nothing could name still asks the user, with what the search found closest.
      nearest: closestIds(hits),
      ranked: rankedIds(hits),
      ...unpriced,
    };
  }

  const eraRows = era ? eraPrintingsOf(identity.name, era) : null;
  // The user said when these cards are from; a name never printed then was misread.
  if (eraRows && !eraRows.length) return { identity: null, confidence, abstain: true, ocrText, nearest: closestIds(hits), ...unpriced };
  const inPeriod = eraRows ? eraPrintings(scoreIndices(embedding, eraRows)) : null;
  if (inPeriod?.pick != null) {
    const picked = _meta[inPeriod.pick];
    return { identity: picked, confidence, abstain, ocrText, ...(await priceIdentity(picked)) };
  }
  const choices = inPeriod?.choices
    ? inPeriod.choices.map((index) => _meta[index])
    : setChoices(identity, hits, _meta);
  // A near-duplicate of the corrected crop (PRINT_C) settles the exact printing the user picked; the evidence is their label.
  const setOpen = choices.length > 1 || physicalHits(printingsOf(identity.name).map((index) => ({ index })), _meta).length > 1;
  if (verdict.printingExact && memory?.cardId === identity.id && setOpen) {
    seen.confirmedBy = "correction";
    seen.why = whyFor("correction");
    return { identity, confidence: Math.min(confidence, BELOW_HIGH_CONFIDENCE), abstain, ocrText, ...(await priceIdentity(identity)), ...(await versionsAlongside(identity, hits, abstain)) };
  }
  if (choices.length > 1) {
    const fromRules = era ? await cardFromNameAndRules(cardCanvas, era, identity.name) : null;
    if (fromRules) {
      return { identity: fromRules, confidence, abstain: false, ocrText, ...(await priceIdentity(fromRules)) };
    }
    return {
      identity: { name: identity.name },
      confidence,
      abstain,
      setChoices: choices.map((row) => ({ ...choiceSummary(row), score: hitScore(hits, row.id) })),
      ocrText,
      ...unpriced,
      ...(await versionsAlongside(identity, hits, abstain)),
    };
  }
  // Other sets print this name: the printing rests on the picture alone until a number, symbol, stamp or title confirms it.
  const setUnconfirmed = physicalHits(printingsOf(identity.name).map((index) => ({ index })), _meta).length > 1;
  return { identity, confidence, abstain, ocrText, ...(setUnconfirmed ? { setUnconfirmed } : {}), ...(await priceIdentity(identity)), ...(await versionsAlongside(identity, hits, abstain)) };
}

// Pikachu ex and Pikachu V can score alike on art. The row keeps the best hit's own price; the lookalikes
// ride along with theirs so the popup can offer "Other version?" without another round trip.
async function versionsAlongside(identity, hits, abstain) {
  if (abstain || !identity?.name) return {};
  const entries = [];
  for (const card of versionChoices(identity, hits, _meta)) {
    let priced = { market_price: null, price_variant: null, price_grid: null };
    let priceError = null;
    try {
      priced = await priceIdentity(card);
    } catch (err) {
      console.log("[BG] no price for", card.id, err?.message || err);
      priceError = "Couldn't get a price. Try again.";
    }
    entries.push({ ...choiceSummary(card), ...priced, ...(priceError ? { priceError } : {}), ...(await ownSetState(card, hits)) });
  }
  return entries.length ? { versionChoices: entries } : {};
}

// How well the picture matched this card, so a best guess among the set choices can follow the picture.
function hitScore(hits, id) {
  const hit = hits.find((h) => _meta[h.index]?.id === id);
  return hit ? Math.round(hit.score * 1000) / 1000 : undefined;
}

// A version printed in several sets stays set-unconfirmed when the popup swaps to it, so it brings its own choices and range.
async function ownSetState(card, hits) {
  const own = setChoices(card, hits, _meta);
  if (own.length < 2) return {};
  const setRange = await rangeOfChoices(own);
  return {
    setChoices: own.map(choiceSummary),
    ...(setRange ? { setRange } : {}),
  };
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
  // Prefer the richer grid from condition-pricing (backend/PPT), then the shared daily snapshot, then TCGdex, then pokemontcg.io.
  let grid = await getConditionGrid({ ...identity, tcgPlayerId });
  if (!grid && tcgdexGrid) grid = applySnapshot(tcgdexGrid, await currentSnapshot());
  if (!grid) grid = tcgdexGrid || fromPokemontcgPayload(prices, full?.tcgplayer?.updatedAt);
  const legacyPrice = extractLegacyPrice(prices);
  return {
    market_price: legacyPrice?.price ?? null,
    price_variant: legacyPrice?.variant ?? null,
    price_grid: grid || null,
  };
}

let _catalogSets = null;
function catalogSets() {
  if (!_catalogSets) {
    const sets = new Map();
    for (const card of _meta) if (card.setCode && card.set && !sets.has(card.setCode)) sets.set(card.setCode, { setCode: card.setCode, set: card.set });
    _catalogSets = [...sets.values()];
  }
  return _catalogSets;
}

// The catalog lists sets in release order, so a card's place in it settles near-equal picture scores the same way every scan.
let _metaRank = null;
function catalogRank(choice) {
  _metaRank ??= new Map(_meta.map((card, i) => [card.id, i]));
  return _metaRank.get(choice.id) ?? Infinity;
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

const PHOTO_TIMEOUT_MS = 4000;
const PHOTO_MAX_SIDE = 1600;
// Second look at the page's own picture of unsettled grid tiles: how many, how long in all, and how many failed fetches end it.
const MAX_REFINED_TILES = 40;
const REFINE_BUDGET_MS = 30000;
const REFINE_MAX_FAILURES = 3;
// Everything one photo may spend fetching: its larger renditions and its own source together.
const PHOTO_BUDGET_MS = 8000;
// Cards read from fewer pixels than this are where a larger photo pays (89% right names from 200 px, far fewer below).
const FULL_SIZE_SMALL_PX = 200;

// The displayed picture's larger rendition, when the page names one the extension may read.
async function loadUpgradedSource(ph, ogImages, pageUrl, { allowedHosts, budget } = {}) {
  if (!(ph.naturalWidth > 0 && ph.naturalHeight > 0)) return null;
  const candidates = [];
  for (const url of fullSizeCandidates({ src: ph.src, naturalWidth: ph.naturalWidth, ...ph.sources, ogImages, base: pageUrl, allowedHosts })) {
    if (await canReadPhotoSource(url)) candidates.push(url);
  }
  if (!candidates.length) return null;
  return loadFullSize(candidates, { width: ph.naturalWidth, height: ph.naturalHeight },
    (url) => {
      // A Facebook original is kept up to 2048 px: its lot photos hold 50 cards, each ~100 px tall at the shown size.
      const host = new URL(url).hostname.toLowerCase();
      const facebook = isFacebookCdn(host);
      // fullSizeCandidates only names another Facebook CDN host when the page loaded its photos from that CDN.
      const hosts = facebook && allowedHosts && !allowedHosts.has(host) ? new Set([...allowedHosts, host]) : allowedHosts;
      return loadPhotoSource(url, { timeoutMs: PHOTO_TIMEOUT_MS, maxSide: facebook ? FACEBOOK_MAX_SIDE : PHOTO_MAX_SIDE, allowedHosts: hosts, budget });
    }).then((found) => {
      if (found && isFacebookCdn(new URL(found.url).hostname)) {
        console.log("[BG] reading the Facebook original:", found.bitmap.width + "x" + found.bitmap.height, "(shown", ph.naturalWidth + "x" + ph.naturalHeight + ")");
        // The original sharpens the match, but how sure a card is shown stays judged on the photo the seller's
        // buyers see: at 2048 px, 50-card lots put many crops just past the size cap, and those were the wrong ones.
        return { ...found, naturalPerFed: ph.naturalWidth / found.bitmap.width };
      }
      return found;
    });
}

// A grid tile's own picture: the site's largest rendition first, the shown one when that is not a read of one card.
const loadTileSource = (rawUrl, limits) => loadTileSourceWith(rawUrl, {
  load: loadPhotoSource,
  readable: canReadPhotoSource,
  limits,
  fits: (bitmap) => looksLikeCard(bitmap.width, bitmap.height),
});

function photoRejected(reason, url) {
  console.log("[BG] photo fetch rejected:", reason, url?.hostname || "");
  return null;
}

async function loadPhotoSource(rawUrl, { timeoutMs = 0, maxSide = 0, allowedHosts = null, budget = null } = {}) {
  const start = publicHttpsUrl(rawUrl);
  if (!start) return photoRejected("not a public https address");
  const allowedMs = Math.min(timeoutMs > 0 ? timeoutMs : Infinity, budget ? budget.remaining() : Infinity);
  if (allowedMs <= 0) return photoRejected("out of time", start);
  const controller = new AbortController();
  const timer = Number.isFinite(allowedMs) ? setTimeout(() => controller.abort(), allowedMs) : null;
  try {
    // Redirects are followed by the browser, so the host they ended on is checked afterwards.
    const response = await fetch(start.href, { credentials: "omit", redirect: "follow", cache: "force-cache", signal: controller.signal });
    const landed = finalUrlAllowed(response.url || start.href, allowedHosts);
    if (!landed) return photoRejected("ended on a disallowed host", publicHttpsUrl(response.url) || start);
    const typeVerdict = photoTypeVerdict(response.headers.get("content-type"));
    if (!response.ok || typeVerdict === "reject") return photoRejected("not an image", landed);
    if ((Number(response.headers.get("content-length")) || 0) > MAX_PHOTO_BYTES) return photoRejected("too large", landed);
    const read = await readCapped(response, MAX_PHOTO_BYTES);
    if (!read) return photoRejected("too large", landed);
    let blob = read.blob;
    if (typeVerdict === "sniff") {
      // Declared as no type or a generic binary: only bytes that really are a picture get through.
      const sniffed = sniffImageType(read.head);
      if (!sniffed) return photoRejected("not an image", landed);
      blob = read.blob.slice(0, read.blob.size, sniffed);
    }
    // The header gives the size before any pixels are decoded.
    const plan = decodePlan(imageSize(read.head), maxSide);
    if (plan.reject) return photoRejected("dimensions too large", landed);
    const bitmap = plan.resize ? await createImageBitmap(blob, plan.resize) : await createImageBitmap(blob);
    if (bitmap.width > 10000 || bitmap.height > 10000) {
      bitmap.close();
      return photoRejected("dimensions too large", landed);
    }
    const longSide = Math.max(bitmap.width, bitmap.height);
    if (!(maxSide > 0 && longSide > maxSide)) return bitmap;
    // Header unreadable, or a rotated picture: bounds the memory and detector time a very large original would cost.
    const factor = maxSide / longSide;
    try {
      return await createImageBitmap(bitmap, {
        resizeWidth: Math.round(bitmap.width * factor), resizeHeight: Math.round(bitmap.height * factor), resizeQuality: "high",
      });
    } finally {
      bitmap.close();
    }
  } catch (err) {
    // Cross-origin sources without CORS access use the already captured viewport crop.
    return photoRejected(controller.signal.aborted ? "timed out" : `failed (${err?.name || "error"})`, start);
  } finally {
    clearTimeout(timer);
  }
}
