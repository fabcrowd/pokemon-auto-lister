import { truncationNote } from "./lib/page-scan.js";
import { confTier, detectedVariant, editionNote, explainScanError, isSetConfirmed, lotValue, modelFileLabel, printingNote, quotedPrice, needsPrinting, fromSeveralPhotos, photoLabel, scanStatus, setRangeSpan, setRangeNote, sourceFooter, splitByRecognition, swapVersion, confirmGuess, readFromSmallCrop, lotEstimate, sureNote, formatUsd, chosenPrintingHasNoPrice, isIdentified, isStale, staleDays, suggestedVariant, setRangeOf, needsEdition, editionVariant, LOT_EDITIONS } from "./lib/card-display.js";
import { ERAS, eraById } from "./lib/era.js";
import { downloadSizeText, missingAssets } from "./lib/setup.js";
import { cropThumb, escHtml, guessOf, guessWithWhy, matchesLabel, renderPickList, renderUnrecognisedGroup, setMenuCorrection, unrecognisedLabel } from "./lib/card-picker.js";
import { bulkPairs, bulkRememberedPairs, candidateView, candidatesOfCard, chooseState, confirmLabel, overlayStateOf, renderCandidateCards, renderChooseGroup, renderSkipButton, renderSkippedGroup, renderSkippedRow, tickAllLabel } from "./lib/choose-flow.js";
import { putBackCard, skipCard, skippedCount } from "./lib/skip.js";
import { finishChips, formatPrinting, renderChipGroup, renderTileStrip, setTiles, versionTiles } from "./lib/option-strip.js";
import { correctedMark, memoryChipHtml, whyHtml } from "./lib/memory-ui.js";
import { userWhy } from "./lib/why.js";
import { demoteCard, isDemotable, priceHighOf, priceTypicalOf, promoteCard, stakesDecision } from "./lib/stakes.js";
import { DEFAULT_FILTERS, mergeFilters } from "./lib/price-prefs.js";
import { CONDITION_TIP, conditionName, lotExportLabels, lotExportRows, lotFileName, lotToCsv, lotToTsv } from "./lib/lot-export.js";
import { getPptKey } from "./lib/ppt-key.js";
import { accessOfferText, dismissedFor, hasAllSites, requestAllSites, requestSites, shouldOfferSiteAccess } from "./lib/site-access.js";

const btnScan      = document.getElementById("btn-scan");
const btnClear     = document.getElementById("btn-clear");
const btnLabel     = document.getElementById("btn-label");
const btnOptions   = document.getElementById("open-options");
const examStrip    = document.getElementById("exam-strip");
const examYes      = document.getElementById("exam-yes");
const examDismiss  = document.getElementById("exam-dismiss");
const wizStep1     = document.getElementById("wiz-step-1");
const wizStep2     = document.getElementById("wiz-step-2");
const wizStepAccess = document.getElementById("wiz-step-access");
const btnWizAccess  = document.getElementById("btn-wiz-access");
const btnWizAccessSkip = document.getElementById("btn-wiz-access-skip");
const btnWizUpgrade = document.getElementById("btn-wiz-upgrade");
const btnWizSkip    = document.getElementById("btn-wiz-skip");
const sValue       = document.getElementById("s-value");
const statValue    = document.getElementById("stat-value");
const lotTotalsEl  = document.getElementById("lot-totals");
const sCond        = document.getElementById("s-cond");
const lotEditionEl = document.getElementById("lot-edition");
const lotEditionSelect = document.getElementById("lot-edition-select");
const fullSizeNotice = document.getElementById("fullsize-notice");
const fullSizeText = document.getElementById("fullsize-text");
const fullSizeOpen = document.getElementById("fullsize-open");
const resultsEl    = document.getElementById("results");
const emptyHint    = document.getElementById("empty-hint");
const msgBar       = document.getElementById("msg-bar");
const setupOverlay = document.getElementById("setup-overlay");
const btnSetup     = document.getElementById("btn-setup");
const setupStatus  = document.getElementById("setup-status");
const setupBars    = document.getElementById("setup-bars");
const eraSelect    = document.getElementById("era-select");
const accessNotice  = document.getElementById("access-notice");
const accessText    = document.getElementById("access-text");
const accessOutcome = document.getElementById("access-outcome");
const accessAllow   = document.getElementById("access-allow");
const accessAllowAll = document.getElementById("access-allow-all");
const accessSkip    = document.getElementById("access-skip");
const accessRescan  = document.getElementById("access-rescan");
const bulkPanel     = document.getElementById("bulk-panel");
const bulkList      = document.getElementById("bulk-list");
const bulkConfirm   = document.getElementById("bulk-confirm");
const bulkClose     = document.getElementById("bulk-close");
const bulkCancel    = document.getElementById("bulk-cancel");
const bulkHint      = document.getElementById("bulk-hint");
const bulkTickAll   = document.getElementById("bulk-tick-all");

const MIN_ART_PX = 20;
const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];

let isScanning = false;
let _lastResult = null;
let _scanSeq = 0;
let _filters   = mergeFilters(DEFAULT_FILTERS);
let _variantChoice = new Map(); // card index -> printing the user chose, or one settled by the printed number
let _variantSuggest = new Map(); // card index -> printing the picture suggests: preselected, never priced until confirmed
let _variantPicked = new Set(); // card indexes whose printing the user set themselves: the lot edition leaves them alone
let _lotEdition = "";           // the edition applied to every Base Set row not picked individually
let _stripMore = new Set();     // "idx:kind" of the picker strips expanded past their first 8 tiles
let _whyOpen = new Set();       // card indexes whose "Why this card?" text is open
let _picker = new Map();        // card index -> { via, query, results } while its search box is open
let _showUnrecognised = false;  // the "not recognised" group is open
let _showChoose = true;         // the "To confirm" group is open
let _showSkipped = false;       // the "Skipped" group is open
let _bulk = null;               // { pairs, skipped, opener, scan } while the review-all panel is open
let _searchTimer = null;
let _pickSeq = 0;
const _pickToken = new Map();   // card index -> its latest pick; a slower earlier price is dropped

let _statusTail = "";       // what follows the scan status line: truncation and still-loading notes
let _statusShown = false;   // the message bar currently shows the scan status, so card changes may refresh it

function showMessage(text, isError = false, isStatus = false) {
  _statusShown = isStatus;
  msgBar.textContent = text;
  msgBar.classList.toggle("error", isError);
  msgBar.setAttribute("role", isError ? "alert" : "status");
  msgBar.classList.toggle("hidden", !text);
}

async function checkReady() {
  const resp = await chrome.runtime.sendMessage({ action: "checkReady" });
  const ready = Boolean(resp?.ready);
  btnScan.disabled = !ready;
  await maybeStartWizard(ready);
  return ready;
}

/* ─── Wizard (first-run flow) ─── */

// Onboarding state: { step: 1 | 'access' | 2 | 'done' }
async function getOnboarding() {
  return new Promise((r) =>
    chrome.storage.sync.get("onboarding", (res) => r(res?.onboarding || { step: 1 })),
  );
}
async function setOnboarding(state) {
  return new Promise((r) => chrome.storage.sync.set({ onboarding: state }, r));
}

function showWizStep(n) {
  wizStep1.classList.toggle("active", n === 1);
  wizStepAccess.classList.toggle("active", n === "access");
  wizStep2.classList.toggle("active", n === 2);
  setupOverlay.style.display = "flex";
}
function hideWizard() { setupOverlay.style.display = "none"; }

/**
 * Decide what to show on popup load:
 *   - models not ready → wizard step 1 (download)
 *   - models ready + onboarding not done + site access not granted or declined → optional site-access step
 *   - models ready + onboarding not done + no PPT key → wizard step 2 (optional upsell)
 *   - otherwise → hidden
 */
async function maybeStartWizard(modelsReady) {
  const onboarding = await getOnboarding();
  const pptApiKey = await getPptKey();
  if (!modelsReady) {
    showWizStep(1);
    // After the step shows, so the size lookup never delays the wizard.
    missingAssets()
      .then((missing) => { document.getElementById("setup-size").textContent = downloadSizeText(missing); })
      .catch((err) => console.warn("[popup] could not size the download", err));
    return;
  }
  if (onboarding.step !== "done" && onboarding.step !== 2 && !(await hasAllSites(chrome.permissions))) {
    showWizStep("access");
    return;
  }
  if (onboarding.step !== "done" && !pptApiKey) {
    showWizStep(2);
    return;
  }
  // Already finished OR already has a key → mark done + skip
  if (onboarding.step !== "done") await setOnboarding({ step: "done" });
  hideWizard();
}

btnSetup.addEventListener("click", async () => {
  btnSetup.disabled = true;
  setupStatus.textContent = "Downloading models…";
  setupBars.innerHTML = "";
  chrome.runtime.onMessage.addListener(onSetupProgress);
  const resp = await chrome.runtime.sendMessage({ action: "startSetup" });
  chrome.runtime.onMessage.removeListener(onSetupProgress);
  if (resp?.ok) {
    btnScan.disabled = false;
    // The download is over: no "Downloading 5 of 5" may outlive it.
    setupStatus.textContent = "";
    setupBars.innerHTML = "";
    // Move the wizard forward: site access, then the PPT upsell (each skipped when already settled)
    await setOnboarding({ step: "access" });
    await maybeStartWizard(true);
  } else {
    console.error("model download failed", resp?.error || "unknown error");
    setupStatus.textContent = /HTTP 404/.test(String(resp?.error))
      ? "This update isn't available yet. Try again later."
      : "The download stopped. Check your connection and try again.";
    btnSetup.disabled = false;
  }
});

btnWizAccess.addEventListener("click", async () => {
  // The permission prompt is allowed only when asked for straight from this click.
  await requestAllSites(chrome.permissions);
  await setOnboarding({ step: 2 });
  await maybeStartWizard(true);
});

btnWizAccessSkip.addEventListener("click", async () => {
  await setOnboarding({ step: 2 });
  await maybeStartWizard(true);
});

btnWizUpgrade.addEventListener("click", async () => {
  // Open signup + settings — user comes back when they're done
  chrome.tabs.create({ url: "https://www.pokemonpricetracker.com/api-keys" });
  chrome.runtime.openOptionsPage();
  await setOnboarding({ step: "done" });
  hideWizard();
});

btnWizSkip.addEventListener("click", async () => {
  await setOnboarding({ step: "done" });
  hideWizard();
});

function onSetupProgress(msg) {
  if (msg.action !== "setupProgress") return;
  const { file, fileIndex, fileDone, totalFiles, bytesLoaded, bytesTotal } = msg;
  const pct = bytesTotal > 0 ? Math.round((bytesLoaded / bytesTotal) * 100) : 0;
  const label = modelFileLabel(file);
  setupStatus.textContent = `Downloading ${fileIndex + 1} of ${totalFiles}: ${label}`;
  let bar = document.getElementById(`bar-${fileIndex}`);
  if (!bar) {
    bar = document.createElement("div");
    bar.id = `bar-${fileIndex}`;
    bar.className = "setup-file";
    bar.innerHTML = `<span class="setup-file-name">${escHtml(label)}</span>
      <div class="setup-file-track"><div class="setup-file-fill" id="fill-${fileIndex}"></div></div>
      <span class="setup-file-pct" id="pct-${fileIndex}">0%</span>`;
    setupBars.appendChild(bar);
  }
  document.getElementById(`fill-${fileIndex}`).style.width = pct + "%";
  document.getElementById(`pct-${fileIndex}`).textContent   = pct + "%";
  if (fileDone) {
    document.getElementById(`fill-${fileIndex}`).style.width = "100%";
    document.getElementById(`pct-${fileIndex}`).textContent   = "✓";
  }
}

/* ─── Options page ─── */

btnOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

/* ─── Scan page ─── */

btnScan.addEventListener("click", scanPage);

/* ─── Era ─── */

for (const era of ERAS) eraSelect.add(new Option(era.label, era.id));
chrome.storage.local.get("scanEra", ({ scanEra }) => {
  if (eraById(scanEra)) eraSelect.value = scanEra;
});
eraSelect.addEventListener("change", () => {
  chrome.storage.local.set({ scanEra: eraSelect.value });
  if (_lastResult && !isScanning) scanPage();
});

btnClear.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "clearPageOverlay" }).catch(() => {});
  _lastResult = null;
  _variantChoice = new Map();
  _variantSuggest = new Map();
  _variantPicked = new Set();
  _lotEdition = "";
  _picker = new Map();
  _whyOpen = new Set();
  _stripMore = new Set();
  _showUnrecognised = false;
  _showSkipped = false;
  _showChoose = true;
  closeBulk(false);
  examStrip.hidden = true;
  resetResults();
  showMessage("");
});

async function scanPage() {
  if (isScanning) return;
  isScanning = true;
  btnScan.classList.add("scanning");
  btnLabel.textContent = "SCANNING…";
  btnScan.disabled = true;
  btnScan.setAttribute("aria-busy", "true");
  eraSelect.disabled = true;
  accessNotice.hidden = true;
  if (fullSizeNotice) fullSizeNotice.hidden = true;
  showMessage("Capturing page and running detection…");

  let data;
  chrome.runtime.onMessage.addListener(onScanProgress);
  try {
    data = await chrome.runtime.sendMessage({ action: "scanPage", era: eraSelect.value || null });
  } catch (err) {
    finishScan();
    showMessage(explainScanError(err?.message || err), true);
    return;
  }

  if (!data || data.error) {
    finishScan();
    showMessage(explainScanError(data?.error || "Scan didn't finish. Try again."), true);
    return;
  }

  applyScanResult(data);
  finishScan();
}

// A scan's result in the list, the stats and the page overlay. A rescan the page started (pictures that loaded
// later) comes here too, so the list always matches what the overlay shows.
function applyScanResult(data) {
  const cards = (data.cards || []).map((card) => ({ ...card, guess: guessOf(card) }));
  _lastResult = { scanId: ++_scanSeq, bgScanId: data.scanId, cards, srcWidth: data.srcWidth, srcHeight: data.srcHeight,
    fullSize: data.fullSizePhoto?.url ? data.fullSizePhoto : null };
  _variantChoice = new Map();
  _variantSuggest = new Map();
  _variantPicked = new Set();
  _lotEdition = "";
  _picker = new Map();
  _stripMore = new Set();
  _userEdits = false;
  _showUnrecognised = false;
  _showChoose = true;
  closeBulk(false);
  _lastResult.cards.forEach(seedVariant);
  _lastResult = { ..._lastResult, cards: demoteExpensive(_lastResult.cards) };
  // Offered only to someone who opted in, on a photo picked for checking; it never blocks anything.
  examStrip.hidden = data.shareExam !== true;
  updateStats(_lastResult.cards);
  renderResults();
  maybeOfferSiteAccess(data).catch(() => { accessNotice.hidden = true; });
  showFullSizeOffer(_lastResult.fullSize);

  if (cards.length === 0) {
    showMessage("No Pokémon cards detected on this page.");
  } else {
    const stillLoading = data.pending > 0
      ? ` ${data.pending} picture${data.pending === 1 ? " is" : "s are"} still loading.`
      : "";
    _statusTail = `${truncationNote(data.truncated)}.${stillLoading}`;
    refreshStatus(true);
  }

  // Push the overlay snapshot with current filter state baked in
  pushOverlay();
  promoteCheap(_lastResult);
}

// The top status line always counts the cards as they are now. A pick's own message ("Getting price...") replaces it
// until the next scan; while the status is showing, every change to the cards (a promotion, a demotion, a pick) refreshes it.
function refreshStatus(force = false) {
  const cards = _lastResult?.cards;
  if (!cards?.length || !(force || _statusShown)) return;
  showMessage(`${scanStatus(cards)}${_statusTail}`, false, true);
}

/* ─── Stakes: price decides how much picture evidence a card needs (lib/stakes.js) ─── */

// Only small-photo cards (smallRow) are priced here, a few at a time, one price per candidate id, from the same
// priceCard call a pick uses. No other host is asked.
const STAKES_FETCH_LIMIT = 6;
const _candidatePrice = new Map();
const _stakesQueue = [];
let _stakesActive = 0;

function limitedFetch(task) {
  return new Promise((resolve) => {
    const run = async () => {
      _stakesActive += 1;
      try { resolve(await task()); } finally {
        _stakesActive -= 1;
        _stakesQueue.shift()?.();
      }
    };
    if (_stakesActive < STAKES_FETCH_LIMIT) run(); else _stakesQueue.push(run);
  });
}

function candidatePrice(id) {
  if (!_candidatePrice.has(id)) {
    const asked = limitedFetch(async () => {
      try { return await chrome.runtime.sendMessage({ action: "priceCard", id }); } catch (err) { return { error: explainScanError(err?.message || err) }; }
    }).then((resp) => {
      if (!resp || resp.error) _candidatePrice.delete(id);
      return resp;
    });
    _candidatePrice.set(id, asked);
  }
  return _candidatePrice.get(id);
}

// A card the picture confirmed, without the "high" tier or a title that agrees, whose price is high, is asked about instead.
function demoteExpensive(cards) {
  return cards.map((card, idx) => {
    if (chooseState(card) !== "confirmed" || !isDemotable(card)) return card;
    const decision = stakesDecision({
      state: "confirmed",
      tier: confTier(card.confidence),
      titleConfirmed: Boolean(card.titleConfirmed),
      userConfirmed: Boolean(card.userConfirmed),
      confirmedBy: card.confirmedBy,
      correctionCos: card.memory?.cos,
      priceTypical: priceTypicalOf(card, chosenPrinting(card, idx), enabledConditions()),
    });
    return decision === "demote" ? demoteCard(card) : card;
  });
}

// A small-photo card to choose is confirmed without asking only when EVERY close candidate (the top PROMOTE_CANDIDATES
// shown in Choose) is cheap, so a pricier reprint or promo among them keeps it a CHOOSE. A candidate whose price is not
// known also blocks it. This is not the user's answer: nothing is saved as a correction or sent for learning, and
// "Wrong card?" is still on the row.
const PROMOTE_CANDIDATES = 5;
function promoteCheap(scan) {
  scan.cards.forEach((card, idx) => {
    if (card.smallRow !== true || card.skippedBefore === true || chooseState(card) !== "choose") return;
    const close = candidatesOfCard(card).slice(0, PROMOTE_CANDIDATES);
    const top = close[0];
    if (!top?.id) return;
    Promise.all(close.map((candidate) => (candidate?.id ? candidatePrice(candidate.id) : null))).then((resps) => {
      if (_lastResult?.scanId !== scan.scanId) return;
      const current = _lastResult.cards[idx];
      if (!current || current.smallRow !== true || chooseState(current) !== "choose" || _picker.has(idx)) return;
      if (candidatesOfCard(current)[0]?.id !== top.id) return;
      const highs = resps.map((resp) => {
        if (!resp || resp.error) return null;
        const probe = { identity: resp.identity, setChoices: [], setConfirmed: true, price_grid: resp.price_grid, market_price: resp.market_price };
        return priceHighOf(probe, null, enabledConditions());
      });
      const decision = stakesDecision({
        state: "choose",
        tier: confTier(current.confidence),
        smallRow: true,
        userConfirmed: Boolean(current.userConfirmed),
        priceHigh: highs[0],
        rivalHighs: highs.slice(1),
      });
      if (decision === "promote") replaceCard(idx, promoteCard(current, resps[0]));
    });
  });
}

// The background rescans on its own when more card pictures load. A pick in progress is never thrown away: the list
// and overlay stay as they are and the user is told to scan again.
let _userEdits = false;
resultsEl.addEventListener("change", () => { _userEdits = true; }, true);
resultsEl.addEventListener("click", (e) => { if (e.target?.closest?.("button, select, a, input")) _userEdits = true; }, true);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action !== "rescanResult" || !msg.data || isScanning) return;
  if (_picker.size || _userEdits) {
    pushOverlay();
    showMessage("More cards loaded on the page. Scan again to add them.");
    return;
  }
  applyScanResult(msg.data);
});

/* ─── Site access offer ─── */

// The site the offer is about, and the origins "Allow" asks for: the page and the hosts of the photos it could not read.
let _accessOffer = { site: "", origins: [] };

async function maybeOfferSiteAccess(scan) {
  const { siteAccessDismissedAt, siteAccessDismissed } = await chrome.storage.local.get(["siteAccessDismissedAt", "siteAccessDismissed"]);
  const now = Date.now();
  const site = typeof scan?.accessSite === "string" ? scan.accessSite : "";
  const dismissed = dismissedFor({ site, dismissedSites: siteAccessDismissed, dismissedAt: siteAccessDismissedAt, now });
  const offer = shouldOfferSiteAccess({ scan, hasAll: await hasAllSites(chrome.permissions), dismissedAt: dismissed ? now : undefined, now });
  _accessOffer = { site, origins: Array.isArray(scan?.accessOrigins) ? scan.accessOrigins : [] };
  accessText.textContent = accessOfferText({ site, galleryUnread: Number(scan?.galleryUnread) || 0 });
  accessText.hidden = false;
  accessOutcome.textContent = "";
  const oneSite = Boolean(site) && _accessOffer.origins.length > 0;
  accessAllow.textContent = oneSite ? `Allow on ${site}` : "Allow";
  accessAllow.hidden = false;
  accessAllowAll.hidden = !oneSite;
  accessSkip.hidden = false;
  accessRescan.hidden = true;
  accessNotice.hidden = !offer;
}

async function dismissAccessOffer() {
  const { siteAccessDismissed } = await chrome.storage.local.get("siteAccessDismissed");
  if (!_accessOffer.site) return chrome.storage.local.set({ siteAccessDismissedAt: Date.now() });
  return chrome.storage.local.set({ siteAccessDismissed: { ...(siteAccessDismissed || {}), [_accessOffer.site]: Date.now() } });
}

function accessGranted() {
  accessText.hidden = true;
  accessAllow.hidden = true;
  accessAllowAll.hidden = true;
  accessSkip.hidden = true;
  accessOutcome.textContent = "Done — scan again to read the original photos";
  accessRescan.hidden = false;
  accessRescan.focus();
}

// Must run straight from the click: the browser refuses a permission request made later.
accessAllow.addEventListener("click", async () => {
  // Called first thing in the click, before any other await: the browser refuses a request made later.
  const granted = _accessOffer.site && _accessOffer.origins.length
    ? await requestSites(chrome.permissions, _accessOffer.origins)
    : await requestAllSites(chrome.permissions);
  if (!granted) {
    dismissAccessOffer().catch(() => {});
    accessNotice.hidden = true;
    return;
  }
  accessGranted();
});
accessAllowAll.addEventListener("click", async () => {
  if (!(await requestAllSites(chrome.permissions))) return;
  accessGranted();
});
accessSkip.addEventListener("click", () => {
  dismissAccessOffer().catch(() => {});
  accessNotice.hidden = true;
  btnScan.focus();
});
accessRescan.addEventListener("click", () => {
  accessNotice.hidden = true;
  scanPage();
});

function onScanProgress(msg) {
  if (msg.action !== "scanProgress") return;
  showMessage(`Scanning screen ${msg.screen} of ${msg.screens}…`);
}

function finishScan() {
  chrome.runtime.onMessage.removeListener(onScanProgress);
  isScanning = false;
  btnScan.classList.remove("scanning");
  btnLabel.textContent = "SCAN PAGE";
  btnScan.disabled = false;
  btnScan.setAttribute("aria-busy", "false");
  eraSelect.disabled = false;
}

/* ─── Filters ─── */

function loadFilters() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("filters", (res) => {
      _filters = mergeFilters(res?.filters);
      resolve();
    });
  });
}

// Filters are edited on the Settings page; a change there shows up here without a rescan.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.filters) return;
  _filters = mergeFilters(changes.filters.newValue);
  if (!_lastResult) return;
  renderResults();
  updateStats(_lastResult.cards);
  pushOverlay();
});

function enabledConditions() { return CONDITIONS.filter((c) => _filters.raw[c]); }
function enabledGraders()    { return Object.keys(_filters.graded).filter((g) => _filters.graded[g]); }

/* ─── Stats + results ─── */

function updateStats(cards) {
  const choiceFor = (card) => _variantChoice.get(cards.indexOf(card)) || null;
  const lot = lotValue(cards, choiceFor, enabledConditions());
  sValue.textContent = lot.value ?? "—";
  setStatDetail(lot.detail);
  sCond.textContent = enabledConditions()[0] || "NM";
  sCond.hidden = false;
  renderLotTotals(cards, choiceFor);
  renderLotEdition(cards);
}

for (const edition of LOT_EDITIONS) lotEditionSelect.add(new Option(edition.label, edition.id));

// Shown only while some row has its finish settled by the printed number but its edition open.
function renderLotEdition(cards) {
  lotEditionEl.hidden = !(cards || []).some(needsEdition);
  lotEditionSelect.value = _lotEdition;
}

// One edition for the whole lot: every eligible row the user has not set themselves takes it, or loses it when cleared.
lotEditionSelect.addEventListener("change", () => {
  const cards = _lastResult?.cards;
  if (!cards) return;
  _lotEdition = lotEditionSelect.value;
  cards.forEach((card, idx) => {
    if (_variantPicked.has(idx) || !needsEdition(card)) return;
    const key = _lotEdition ? editionVariant(card, _lotEdition) : null;
    if (key) _variantChoice.set(idx, key);
    else _variantChoice.delete(idx);
    _variantSuggest.delete(idx);
  });
  renderResults();
  pushOverlay();
  updateStats(cards);
  lotEditionSelect.focus();
});

// The lot in two figures: what the confirmed cards are worth (a range while a printing is open), and how many
// cards are still to confirm. A guessed card adds nothing until the user confirms it.
function renderLotTotals(cards, choiceFor) {
  if (!lotTotalsEl) return;
  const list = (cards || []).filter((card) => !card.cardBack);
  if (!list.length) { lotTotalsEl.hidden = true; return; }
  const skipped = skippedCount(cards);
  const t = lotEstimate(cards, choiceFor, enabledConditions());
  const span = (low, high) => (Math.abs(high - low) < 0.005 ? formatUsd(high) : `${formatUsd(low)}–${formatUsd(high)}`);
  const cond = enabledConditions()[0] || "NM";
  const note = sureNote(t);
  const labels = lotExportLabels(...currentLotCounts(cards, choiceFor));
  const actions = labels
    ? `<span class="lt-actions" title="${escHtml(labels.tip)}">`
      + `<button type="button" class="lt-btn" data-lot-copy aria-label="${escHtml(labels.copy)}" title="${escHtml(labels.tip)}">${escHtml(labels.copy)}</button>`
      + `<button type="button" class="lt-btn" data-lot-csv aria-label="${escHtml(labels.csv)}" title="${escHtml(labels.tip)}">${escHtml(labels.csv)}</button></span>`
    : "";
  const hadCopyFocus = lotTotalsEl.contains(document.activeElement) ? document.activeElement.closest("[data-lot-copy], [data-lot-csv]") : null;
  lotTotalsEl.innerHTML = `<span class="lt-item"><span class="lt-lbl">Confirmed value</span> <b>${escHtml(span(t.low, t.high))}</b> <span class="lt-n"${note.title ? ` title="${escHtml(note.title)}"` : ""}>${escHtml(note.text)}</span> <span class="lt-cond" title="${escHtml(CONDITION_TIP)}">${escHtml(conditionName(cond))}</span></span>`
    + `<span class="lt-item lt-guess" title="Cards still to confirm. Confirm each card to see its price."><span class="lt-lbl">To confirm</span> <b>${t.toIdentify}</b></span>`
    + (skipped ? `<span class="lt-item lt-skipped" title="Cards you skipped. They are not priced or exported."><span class="lt-lbl">Skipped</span> <b>${skipped}</b></span>` : "")
    + actions;
  lotTotalsEl.hidden = false;
  // The strip is rewritten on every card change; a keyboard user on Copy or Download stays on it.
  if (hadCopyFocus) lotTotalsEl.querySelector(hadCopyFocus.hasAttribute("data-lot-csv") ? "[data-lot-csv]" : "[data-lot-copy]")?.focus();
}

// Copy and Download write only the confirmed cards, on the user's click; nothing leaves the browser otherwise.
function currentLot() {
  const cards = _lastResult?.cards || [];
  const choiceFor = (card) => _variantChoice.get(cards.indexOf(card)) || null;
  return lotExportRows(cards, choiceFor, enabledConditions());
}
function currentLotCounts(cards, choiceFor) {
  const { count, notIncluded, skipped } = lotExportRows(cards, choiceFor, enabledConditions());
  return [count, notIncluded, skipped];
}

// The clipboard API needs no extra permission from a click; the textarea route is for when it refuses.
function copyWithTextarea(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(area);
  area.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { area.remove(); }
}

async function copyLot() {
  const lot = currentLot();
  const labels = lotExportLabels(lot.count, lot.notIncluded, lot.skipped);
  if (!labels) return;
  const text = lotToTsv(lot.rows);
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = copyWithTextarea(text);
  }
  showMessage(copied ? labels.copied : "Copy failed: use Download CSV", !copied);
}

function downloadLot() {
  const lot = currentLot();
  const labels = lotExportLabels(lot.count, lot.notIncluded, lot.skipped);
  if (!labels) return;
  const name = lotFileName(new Date());
  // The byte order mark makes Excel read the file as UTF-8.
  const url = URL.createObjectURL(new Blob(["﻿", lotToCsv(lot.rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showMessage(`Saved ${lot.count} ${lot.count === 1 ? "card" : "cards"} as ${name}`);
}

lotTotalsEl?.addEventListener("click", (event) => {
  if (event.target.closest("[data-lot-copy]")) copyLot();
  else if (event.target.closest("[data-lot-csv]")) downloadLot();
});

/* ─── Full-size photo offer ─── */

// The scan found the photo's cards small and knows a larger rendition it could not read itself (no site access, or
// the fetch failed). Opening it in a tab lets the next scan read it; the popup scans it as soon as it has loaded.
let _fullSizeTabId = null;
function showFullSizeOffer(offer) {
  if (!fullSizeNotice) return;
  if (!offer?.url) { fullSizeNotice.hidden = true; return; }
  const size = offer.side ? ` (${offer.side} px)` : "";
  fullSizeText.textContent = `${offer.small} of ${offer.cards} cards in this photo are small. The full-size photo${size} gives better results.`;
  fullSizeOpen.dataset.url = offer.url;
  fullSizeNotice.hidden = false;
}

fullSizeOpen?.addEventListener("click", async () => {
  const offer = _lastResult?.fullSize;
  if (!offer?.url) return;
  let origin = null;
  try { origin = new URL(offer.url).origin + "/*"; } catch { return; }
  // Asked straight from the click, which the browser requires: without access the new tab cannot be scanned.
  const allowed = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  const tab = await chrome.tabs.create({ url: offer.url, active: true }).catch(() => null);
  fullSizeNotice.hidden = true;
  if (!tab) return;
  _fullSizeTabId = tab.id;
  showMessage(allowed ? "Opening the full-size photo — it is scanned when it has loaded." : "Opened the full-size photo. Press Scan Page there.");
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== _fullSizeTabId || info.status !== "complete") return;
  _fullSizeTabId = null;
  // The background follows the active tab while this window is open, so the scan reads the new tab.
  setTimeout(() => { if (!isScanning) scanPage(); }, 600);
});

// A click on a Choose tag on the page: the card's row and its picks, ready to choose.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action !== "overlayPick" || !Number.isInteger(msg.index)) return;
  if (!_showChoose) { _showChoose = true; renderResults(); }
  const row = resultsEl.querySelector(`.card-row[data-idx="${msg.index}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1600);
  (row.querySelector("button[data-pick]") || row.querySelector("[data-open-search]"))?.focus({ preventScroll: true });
  highlightOnPage(msg.index);
});

function setStatDetail(detail) {
  sValue.title = detail;
  if (detail) statValue.setAttribute("aria-label", detail);
  else statValue.removeAttribute("aria-label");
}

// For the "total" stat, use first enabled condition price (NM-first). Falls back
// to the single legacy market_price when there's no grid.
function chosenPrinting(card, idx) {
  const stored = _variantChoice.get(idx);
  if (stored && card.price_grid?.variants?.[stored]) return stored;
  const names = Object.keys(card.price_grid?.variants || {});
  return names.length === 1 ? names[0] : null;
}

function resetResults() {
  sValue.textContent    = "—";
  setStatDetail("");
  sCond.hidden          = true;
  lotEditionEl.hidden   = true;
  if (lotTotalsEl) { lotTotalsEl.hidden = true; lotTotalsEl.innerHTML = ""; }
  if (fullSizeNotice) fullSizeNotice.hidden = true;
  resultsEl.innerHTML   = "";
  resultsEl.appendChild(emptyHint);
}

function renderResults() {
  const cards = _lastResult?.cards || [];
  if (cards.length === 0) { resetResults(); return; }
  emptyHint.remove();

  const { shown, hidden, skipped } = splitByRecognition(cards);
  const toChoose = shown.filter((idx) => chooseState(cards[idx]) === "choose");
  const confirmed = shown.filter((idx) => chooseState(cards[idx]) !== "choose");
  resultsEl.innerHTML = renderChooseGroup(toChoose.map((idx) => renderChooseRow(cards[idx], idx)).join(""), toChoose.length, _showChoose, bulkPairs(cards).length)
    + confirmed.map((idx) => renderCardRow(cards[idx], idx)).join("")
    + renderUnrecognisedGroup(hidden.map((idx) => renderUnrecognisedRow(cards[idx], idx)).join(""), hidden.length, _showUnrecognised)
    + renderSkippedGroup(skipped.map((idx) => renderSkippedRow(idx, cropThumb(cards[idx]))).join(""), skipped.length, _showSkipped);
}

function renderCardRow(card, idx) {
  const id   = card.identity || {};
  const name = id.name    || "Card";
  const code = id.setCode || "";
  const set  = id.set     || "";
  const num  = id.number  || "";
  const tier = card.abstain ? "abstain" : confTier(card.confidence);
  const grid = card.price_grid;
  const setKnown = isSetConfirmed(card);

  const setHtml = code ? `<span class="set-chip">${escHtml(code)}</span>` : "";
  const subHtml = setKnown
    ? `${setHtml}${escHtml(set)}${num ? ` <span class="card-number">#${escHtml(num)}</span>` : ""}`
    : "Set not sure";
  const photo = fromSeveralPhotos(_lastResult?.cards) ? photoLabel(card) : "";
  const photoHtml = photo ? ` <span class="photo-chip" title="Read from this photo of the listing">${escHtml(photo)}</span>` : "";

  // A confirmed row offers search as "Wrong card?" in its head; the box opens under the head.
  const searchRow  = renderSearchPanel(idx);
  const setRow     = renderSetRow(card, idx);
  const versionRow = renderVersionRow(card, idx);
  const variantRow = setKnown ? renderVariantRow(card, idx) : "";
  const gradedRow  = setKnown ? renderGradedGrid(card, grid) : "";
  const loneEdition = setKnown && Object.keys(grid?.variants || {}).length <= 1 ? editionNote(card) : null;
  const repeatMark = card.repeatedName
    ? ` <span class="repeat-mark" role="img" title="${REPEAT_NOTE}" aria-label="${REPEAT_NOTE}">⚠</span>`
    : "";

  return `<div class="card-row" data-idx="${idx}">
    <div class="card-head">
      <div class="conf-stripe ${tier}"></div>
      <div class="card-meta">
        <div class="card-name"${loneEdition ? ` title="${escHtml(loneEdition)}"` : ""}>${escHtml(name)}${loneEdition ? ` <span class="sr-only">${escHtml(loneEdition)}</span>` : ""}${guessMark(card, idx)}${repeatMark}${memoryChipHtml(card)}</div>
        <div class="card-sub">${subHtml}${photoHtml}</div>
      </div>
      ${renderPrice(card, idx)}
      <button type="button" class="link-btn" data-open-search data-via="wrong-card" data-idx="${idx}" aria-label="Wrong card? Search for the right one for ${escHtml(name)}">Wrong card?</button>
    </div>
    ${whyHtml(card, idx, _whyOpen.has(idx))}
    ${searchRow}
    ${setRow}
    ${versionRow}
    ${variantRow}
    ${gradedRow}
  </div>`;
}

const REPEAT_NOTE = "Same name found several times in this photo. Check it.";

// One price per card, always in the head: a quote, a range while the set is open, or a dash that says why.
function renderPrice(card, idx) {
  const cell = (text, title) => `<div class="card-price" title="${escHtml(title)}" aria-label="${escHtml(`${text}. ${title}`)}">${escHtml(text)}</div>`;
  if (card.pricing) return cell("…", "Getting price…");
  if (card.priceError) return cell("—", card.priceError);
  if (card.cardBack) return cell("—", "Turn it over to identify it");
  // A card still to choose has no price: it is quoted only once the user picks it.
  if (!isIdentified(card)) return cell("—", "Choose the card to see a price");
  const conditions = enabledConditions();
  // Name sure, printing open: the range across the printings it could be, until the user picks one.
  const openSpan = needsPrinting(card) ? setRangeSpan(card.setRange, conditions) : null;
  if (openSpan) return cell(openSpan, "Printing not picked — pick it for one price");
  const printing = chosenPrinting(card, idx);
  const quote = quotedPrice(card, printing, conditions);
  if (quote) {
    const others = Object.entries(card.price_grid?.variants?.[quote.printing]?.conditions || {})
      .filter(([cond, price]) => cond !== quote.condition && price != null)
      .map(([cond, price]) => `${cond} $${Number(price).toFixed(2)}`);
    const oldDays = staleDays(card.price_grid);
    const oldTag = isStale(card) ? (oldDays != null ? `Old price: ${oldDays} days` : "Old price") : null;
    const title = [quote.condition, quote.printing ? formatPrinting(quote.printing) : null, sourceFooter(card.price_grid), oldTag, ...others]
      .filter(Boolean).join(" · ");
    return cell("$" + Number(quote.price).toFixed(2), title);
  }
  // A printing the user picked has no price: say so, never borrow another printing's.
  if (chosenPrintingHasNoPrice(card, printing, conditions)) return cell("—", "No price for this printing");
  // Set settled, printing open: the range over its printings, the same one the lot total uses.
  const printings = isSetConfirmed(card) ? setRangeOf([card], conditions) : null;
  if (printings) return cell(setRangeSpan(printings), "Printing not picked — pick it for one price");
  const span = isSetConfirmed(card) ? null : setRangeSpan(card.setRange, conditions);
  if (span) return cell(span, "Set not sure — pick the set for one price");
  return cell("—", "No price data");
}

// Nothing is known about this card, so no name, price or picker: just a way to look it up.
function renderUnrecognisedRow(card, idx) {
  const thumb = cropThumb(card);
  const inPhoto = fromSeveralPhotos(_lastResult?.cards) ? photoLabel(card) : "";
  const label = (card.cardBack ? `Card ${idx + 1}: card back, turn it over to identify it` : `Card ${idx + 1}`) + (inPhoto ? ` · ${inPhoto}` : "");
  const search = card.cardBack || _picker.get(idx)
    ? ""
    : `<button type="button" class="link-btn" data-open-search data-via="search" data-idx="${idx}" aria-label="Search for card ${idx + 1}">Search for this card</button>`;
  return `<div class="card-row unrec-row" data-idx="${idx}">
    <div class="unrec-line">
      ${thumb ? `<img class="unrec-thumb" src="${escHtml(thumb)}" alt="" width="34" height="48">` : ""}
      <span class="unrec-name">${escHtml(label)}</span>
      ${search}
    </div>
    ${renderSearchPanel(idx)}
  </div>`;
}

function searchResultsHtml(state, idx) {
  if (!state.results) return "";
  if (state.results.length === 0) return `<div class="no-price">No matches. Try the name, the number, or both.</div>`;
  return renderPickList(state.results, idx);
}

// A card to choose: the picture beside the closest cards (art, name, set, number), the best one preselected and
// confirmed with one press. No name is asserted for the card and no price is shown until it is picked.
function renderChooseRow(card, idx) {
  const candidates = candidatesOfCard(card);
  const best = candidates[0] ? candidateView(card, candidates[0], { best: true }) : null;
  const state = _picker.get(idx);
  const photo = fromSeveralPhotos(_lastResult?.cards) ? photoLabel(card) : "";
  const photoHtml = photo ? ` <span class="photo-chip" title="Read from this photo of the listing">${escHtml(photo)}</span>` : "";
  const smallHtml = readFromSmallCrop(card)
    ? ` <span class="small-chip" title="Read from a small picture (${Math.round(card.readHeight)} px tall). A full-size photo reads better.">small photo</span>`
    : "";
  const valueHtml = card.valueCheck
    ? ` <span class="value-chip" title="This card is worth enough that the picture alone is not trusted. Check it.">Check: high value</span>`
    : "";
  const repeatMark = card.repeatedName
    ? ` <span class="repeat-mark" role="img" title="${REPEAT_NOTE}" aria-label="${REPEAT_NOTE}">⚠</span>`
    : "";
  const confirm = best
    ? `<button type="button" class="choose-confirm" data-confirm-best data-idx="${idx}" aria-label="${escHtml(`Confirm the best match for card ${idx + 1}: ${best.label}`)}">Confirm ${escHtml(best.name)}</button>`
    : "";
  const search = state
    ? ""
    : `<button type="button" class="link-btn" data-open-search data-via="search" data-idx="${idx}" aria-label="None of these? Search for card ${idx + 1}">None of these? Search</button>`;
  return `<div class="card-row choose-row asking" data-idx="${idx}">
    <div class="card-head">
      <div class="conf-stripe abstain"></div>
      <div class="card-meta">
        <div class="card-name">Card ${idx + 1}${repeatMark}</div>
        <div class="card-sub">Choose the right card${photoHtml}${smallHtml}${valueHtml}${memoryChipHtml(card, { choose: true })}</div>
      </div>
      ${renderPrice(card, idx)}
    </div>
    <div class="picker" role="group" aria-labelledby="picker-title-${idx}">
      <div class="picker-title" id="picker-title-${idx}">Which card is this?</div>
      <div class="picker-sub">${candidates.length ? "Closest matches, best one first" : "No close matches"}</div>
      <div class="pick-row">${renderScannedCard(card, idx)}${renderCandidateCards(card, idx)}</div>
      <div class="choose-actions">${confirm}${search}${renderSkipButton(idx, card.skippedBefore === true)}</div>
    </div>
    ${renderSearchPanel(idx)}
  </div>`;
}

// The picture the question is about; pressing it scrolls the page to that card.
function renderScannedCard(card, idx) {
  const crop = cropThumb(card);
  return `<button type="button" class="scanned-card" data-show-on-page data-idx="${idx}" title="Show this card on the page" aria-label="The card on the page. Show it on the page.">
    ${crop ? `<img src="${escHtml(crop)}" alt="">` : `<span class="pick-blank" aria-hidden="true"></span>`}
    <span class="scanned-label">${card.inGallery ? escHtml(photoLabel(card) || "Another photo") : "On the page"}</span>
  </button>`;
}

function renderSearchPanel(idx) {
  const state = _picker.get(idx);
  return state
    ? `<div class="picker">
        <div class="picker-bar">
          <input class="picker-input" type="search" data-idx="${idx}" value="${escHtml(state.query)}" placeholder="Name or number, e.g. charizard 4/102" aria-label="Search cards by name or number" autocomplete="off">
          <button type="button" class="link-btn" data-close-search data-idx="${idx}">Close</button>
        </div>
        <div class="sr-only" role="status" data-search-status="${idx}">${matchesLabel(state.results?.length)}</div>
        <div class="pick-row picker-results" data-idx="${idx}">${searchResultsHtml(state, idx)}</div>
      </div>`
    : "";
}

function openSearch(idx, via) {
  const open = _picker.get(idx);
  if (open) open.via = via;
  else _picker.set(idx, { via, query: _lastResult?.cards?.[idx]?.titleQuery ?? "", results: null });
  renderResults();
  const input = resultsEl.querySelector(`.picker-input[data-idx="${idx}"]`);
  input?.focus();
  if (!open && input?.value) onSearchInput(idx, input.value);
}

// Re-rendering drops the focused element, so keyboard users land back on a button in the same card: the opener
// they used, else the row's one search opener (asked rows have only "search", identified rows only "wrong-card"),
// else the first pick or other button in the row, so focus never falls back to the page.
function focusOpener(idx, via = null, strip = null) {
  const row = resultsEl.querySelector(`.card-row[data-idx="${idx}"]`);
  if (!row) return;
  // After a pick in a strip or chip group, focus stays in that group: on its newly checked tile, else the one tapped.
  const group = strip ? row.querySelector(`[data-strip="${strip.kind}"]`) : null;
  const inGroup = group && (group.querySelector('[role="radio"][aria-checked="true"]')
    || [...group.querySelectorAll("[data-strip-pick]")].find((el) => el.dataset.stripPick === strip.id));
  const target = inGroup || (via && row.querySelector(`[data-open-search][data-via="${via}"]`))
    || row.querySelector("[data-open-search]")
    || row.querySelector("button[data-pick], button, select, input");
  target?.focus();
}

function closeSearch(idx) {
  const via = _picker.get(idx)?.via;
  _picker.delete(idx);
  renderResults();
  focusOpener(idx, via);
}

function onSearchInput(idx, query) {
  const state = _picker.get(idx);
  if (!state) return;
  state.query = query;
  clearTimeout(_searchTimer);
  const scan = _lastResult;
  if (!query.trim()) {
    state.results = null;
    showSearchResults(idx);
    return;
  }
  _searchTimer = setTimeout(async () => {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ action: "findCards", query, era: eraSelect.value || null });
    } catch (err) {
      resp = { error: explainScanError(err?.message || err) };
    }
    // The box was closed, retyped, or a new scan replaced the cards while this was loading.
    if (_lastResult !== scan || _picker.get(idx) !== state || state.query !== query) return;
    if (resp?.error) { showMessage(resp.error, true); return; }
    state.results = resp?.cards || [];
    showSearchResults(idx);
  }, 200);
}

// Rewrites only the results so the box being typed in keeps focus.
function showSearchResults(idx) {
  const state = _picker.get(idx);
  const box = resultsEl.querySelector(`.picker-results[data-idx="${idx}"]`);
  if (state && box) box.innerHTML = searchResultsHtml(state, idx);
  const status = resultsEl.querySelector(`[data-search-status="${idx}"]`);
  if (state && status) status.textContent = matchesLabel(state.results?.length);
}

// What each row shows now, after any fixes: the answers "All right" confirms.
function shownAnswers(cards) {
  return cards.map((card, index) => {
    if (card.cardBack) return { index, notACard: true };
    return card.identity?.id ? { index, cardId: card.identity.id } : { index, unknown: true };
  });
}

examDismiss.addEventListener("click", () => { examStrip.hidden = true; });

examYes.addEventListener("click", async () => {
  const scan = _lastResult;
  if (!scan) return;
  examYes.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ action: "confirmExam", scanId: scan.bgScanId, answers: shownAnswers(scan.cards) });
    if (resp?.error || !resp?.ok) throw new Error(resp?.error || "not sent");
    examStrip.hidden = true;
    showMessage("Thanks. Those results were sent to help check the scanner.");
  } catch {
    showMessage("Couldn't send that. Try again later.", true);
  } finally {
    examYes.disabled = false;
  }
});

function pickCard(idx, id, via, row, remember = true) {
  const scan = _lastResult;
  if (!scan?.cards?.[idx]) return;
  _picker.delete(idx);
  const card = scan.cards[idx];
  const advance = chooseState(card) === "choose" && resultsEl.contains(document.activeElement);
  if (advance) _advanceNote.add(idx); else _advanceNote.delete(idx);
  // What the scanner believed (its why-record, the price shown) is saved with the answer, before the row says "you chose".
  const price = priceTypicalOf(card, chosenPrinting(card, idx), enabledConditions());
  const guess = guessWithWhy(card, price);
  if (remember) {
    scan.cards[idx] = { ...card, why: userWhy(card.why) };
    chrome.runtime.sendMessage({
      action: "saveCorrection", scanId: scan.bgScanId, index: idx, guess, pickedId: id, via,
    }).then((resp) => {
      if (resp?.error) { showMessage(resp.error, true); return; }
      const corrected = correctedMark(guess, id, resp);
      const current = _lastResult?.scanId === scan.scanId ? _lastResult.cards[idx] : null;
      if (corrected && current) replaceCard(idx, { ...current, corrected });
    }).catch((err) => showMessage(explainScanError(err?.message || err), true));
  }
  const priced = pickSet(idx, id, row ?? { id });
  if (advance) advanceAfterConfirm(idx, row?.name || card.identity?.name);
  return priced;
}

// A confirmed Choose row leaves the group, so keyboard focus moves to what is next to do: the next row's preselected
// Confirm button, else the lot's Copy button, else Scan. The change is spoken through the message bar.
const _advanceNote = new Set();   // card indexes confirmed from a Choose row: their message says what is left
function toConfirmCount() {
  const cards = _lastResult?.cards || [];
  return splitByRecognition(cards).shown.filter((i) => chooseState(cards[i]) === "choose").length;
}
function confirmedNote(name) {
  const left = toConfirmCount();
  return `Confirmed ${name || "card"}. ${left ? `${left} to confirm.` : "Nothing left to confirm."}`;
}
function advanceAfterConfirm(idx, name, note = null) {
  const rows = [...resultsEl.querySelectorAll(".choose-row[data-idx]")];
  const next = rows.find((row) => Number(row.dataset.idx) > idx) || rows[0];
  const target = (next?.querySelector("button[data-confirm-best]") || next?.querySelector("button[data-pick], [data-open-search]"))
    || lotTotalsEl?.querySelector("[data-lot-copy]") || btnScan;
  target.focus({ preventScroll: false });
  showMessage(note ?? confirmedNote(name));
}

// "Can't price this": the card leaves the list, the lot and the export, and the scanner remembers it locally (a similar
// crop is then never confirmed on its own). Focus goes where a confirm sends it: the next row's Confirm button.
function skipAt(idx) {
  const scan = _lastResult;
  const card = scan?.cards?.[idx];
  if (!card || chooseState(card) !== "choose") return;
  _picker.delete(idx);
  const guess = guessWithWhy(card);
  chrome.runtime.sendMessage({ action: "saveSkip", scanId: scan.bgScanId, index: idx, guess })
    .then((resp) => { if (resp?.error) showMessage(resp.error, true); })
    .catch((err) => showMessage(explainScanError(err?.message || err), true));
  replaceCard(idx, skipCard(card));
  const left = toConfirmCount();
  advanceAfterConfirm(idx, null, `Skipped. ${left ? `${left} to confirm.` : "Nothing left to confirm."}`);
}

function putBackAt(idx) {
  const scan = _lastResult;
  const card = scan?.cards?.[idx];
  if (!card?.skipped) return;
  chrome.runtime.sendMessage({ action: "unskip", scanId: scan.bgScanId, index: idx })
    .then((resp) => { if (resp?.error) showMessage(resp.error, true); })
    .catch((err) => showMessage(explainScanError(err?.message || err), true));
  _showChoose = true;
  replaceCard(idx, putBackCard(card));
  resultsEl.querySelector(`.choose-row[data-idx="${idx}"] [data-confirm-best], .choose-row[data-idx="${idx}"] [data-open-search]`)?.focus();
  showMessage(`Put back. ${toConfirmCount()} to confirm.`);
}

resultsEl.addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button || !resultsEl.contains(button)) return;
  if ("unrecToggle" in button.dataset) {
    // Changed in place, not re-rendered, so keyboard focus stays on the button.
    _showUnrecognised = !_showUnrecognised;
    button.setAttribute("aria-expanded", String(_showUnrecognised));
    button.textContent = unrecognisedLabel(resultsEl.querySelectorAll(".unrec-row").length, _showUnrecognised);
    resultsEl.querySelector("#unrec-list").hidden = !_showUnrecognised;
    return;
  }
  if ("skippedToggle" in button.dataset) {
    _showSkipped = !_showSkipped;
    button.setAttribute("aria-expanded", String(_showSkipped));
    resultsEl.querySelector("#skipped-list").hidden = !_showSkipped;
    return;
  }
  if ("chooseToggle" in button.dataset) {
    _showChoose = !_showChoose;
    button.setAttribute("aria-expanded", String(_showChoose));
    resultsEl.querySelector("#choose-list").hidden = !_showChoose;
    return;
  }
  if ("reviewAll" in button.dataset) {
    openBulk(button);
    return;
  }
  const idx = Number(button.dataset.idx);
  if ("confirmBest" in button.dataset) {
    const best = candidatesOfCard(_lastResult?.cards?.[idx])[0];
    if (best?.id) pickCard(idx, best.id, "candidates", best);
  } else if ("skipCard" in button.dataset) {
    skipAt(idx);
  } else if ("putBack" in button.dataset) {
    putBackAt(idx);
  } else if ("variantConfirm" in button.dataset) {
    const suggested = _variantSuggest.get(idx);
    if (!suggested) return;
    _variantChoice.set(idx, suggested);
    _variantPicked.add(idx);
    _variantSuggest.delete(idx);
    renderResults();
    pushOverlay();
    updateStats(_lastResult.cards);
  } else if ("why" in button.dataset) {
    if (_whyOpen.has(idx)) _whyOpen.delete(idx); else _whyOpen.add(idx);
    renderResults();
    resultsEl.querySelector(`.why-btn[data-idx="${idx}"]`)?.focus();
  } else if ("guessConfirm" in button.dataset) {
    confirmSuggestedSet(idx);
  } else if ("stripMore" in button.dataset) {
    const key = `${idx}:${button.dataset.stripMore}`;
    if (_stripMore.has(key)) _stripMore.delete(key); else _stripMore.add(key);
    renderResults();
    resultsEl.querySelector(`.strip-more[data-strip-more="${button.dataset.stripMore}"][data-idx="${idx}"]`)?.focus();
  } else if ("stripPick" in button.dataset) {
    onStripPick(idx, button);
  } else if (button.dataset.pick) {
    const fromSearch = Boolean(button.closest(".picker-results"));
    const shown = fromSearch ? _picker.get(idx)?.results : candidatesOfCard(_lastResult?.cards?.[idx]);
    pickCard(
      idx,
      button.dataset.pick,
      fromSearch ? _picker.get(idx)?.via || "search" : "candidates",
      shown?.find((card) => card.id === button.dataset.pick),
    );
  } else if ("openSearch" in button.dataset) {
    openSearch(idx, button.dataset.via);
  } else if ("closeSearch" in button.dataset) {
    closeSearch(idx);
  } else if ("showOnPage" in button.dataset) {
    highlightOnPage(idx, true);
  }
});

// The "?" beside the name and a tap on the suggested printing's picture do the same thing.
function confirmSuggestedSet(idx) {
  const card = _lastResult?.cards?.[idx];
  if (!card?.bestGuess) return;
  saveSetCorrection(idx, card.identity?.id, "guess-confirmed");
  replaceCard(idx, confirmGuess(card));
}

// One tap on a thumbnail or chip. Each kind goes through exactly what its menu did: the printing saves the same
// correction (via "set-menu") and prices the same way, a version swaps the row, a finish sets the printing for the row.
function onStripPick(idx, button) {
  const card = _lastResult?.cards?.[idx];
  if (!card || button.getAttribute("aria-disabled") === "true") return;
  // The checked tile is the current answer: a no-op, unless it is the suggested printing, which a tap confirms.
  if (button.getAttribute("aria-checked") === "true") {
    if (button.dataset.stripKind === "set" && button.classList.contains("strip-suggested")) confirmSuggestedSet(idx);
    return;
  }
  const value = button.dataset.stripPick;
  const kind = button.dataset.stripKind;
  if (kind === "set") {
    saveSetCorrection(idx, value, "set-menu");
    pickSet(idx, value);
  } else if (kind === "version") {
    replaceCard(idx, swapVersion(card, value));
    // An earlier "Price updated for <old name>" no longer describes this row.
    refreshStatus(true);
  } else if (kind === "finish") {
    _variantSuggest.delete(idx);
    _variantChoice.set(idx, value);
    _variantPicked.add(idx);
    renderResults();
    pushOverlay();
    updateStats(_lastResult.cards);
    focusOpener(idx, null, { kind: "finish", id: value });
  }
}

// Arrow keys move through a strip or chip group; Enter and Space press the focused one like any button.
function moveInGroup(e) {
  const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const radio = e.target.closest?.('[role="radio"]');
  const group = radio?.closest('[role="radiogroup"]');
  if (!group || !(e.key in keys || e.key === "Home" || e.key === "End")) return false;
  const items = [...group.querySelectorAll('[role="radio"]')];
  const at = items.indexOf(radio);
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.min(items.length - 1, Math.max(0, at + keys[e.key]));
  e.preventDefault();
  for (const item of items) item.tabIndex = item === items[next] ? 0 : -1;
  items[next].focus();
  return true;
}

// A thumbnail that fails to load becomes a text tile (name and set), so the choice is never lost.
function failStripArt(img) {
  const art = img?.tagName === "IMG" ? img.closest(".strip-art") : null;
  if (!art) return;
  art.classList.add("no-art");
  img.remove();
}
resultsEl.addEventListener("error", (e) => failStripArt(e.target), true);
// A picture that decodes to a speck is a placeholder, not a card.
resultsEl.addEventListener("load", (e) => {
  if (e.target?.naturalWidth < MIN_ART_PX) failStripArt(e.target);
}, true);

/* ─── Review all: every card to choose beside its preselected candidate, kept or skipped, one Confirm N ─── */

function bulkPairHtml(pair) {
  const card = _bulk.scan.cards[pair.idx];
  const view = candidateView(card, pair.candidate, { best: true });
  const crop = cropThumb(card);
  const kept = !_bulk.skipped.has(pair.idx);
  const check = pair.decisive ? "" : ` <span class="bulk-check">Check</span>`;
  const sub = [view.set, view.number ? `#${view.number}` : "", view.printing].filter(Boolean).join(" · ");
  return `<li class="bulk-pair${kept ? "" : " skipped"}" data-idx="${pair.idx}">
    <label class="bulk-label">
      <input type="checkbox" class="bulk-keep" data-bulk-keep data-idx="${pair.idx}"${kept ? " checked" : ""} aria-label="${escHtml(`Keep card ${pair.idx + 1}: ${view.label}`)}">
      ${crop ? `<img class="bulk-img" src="${escHtml(crop)}" alt="" width="63" height="88">` : `<span class="pick-blank bulk-img" aria-hidden="true"></span>`}
      <span class="bulk-arrow" aria-hidden="true">&rarr;</span>
      ${view.art ? `<img class="bulk-img" src="${escHtml(view.art)}" alt="" loading="lazy" width="63" height="88">` : `<span class="pick-blank bulk-img" aria-hidden="true"></span>`}
      <span class="bulk-text"><b>${escHtml(view.name)}</b>${view.agrees ? ` <span class="pick-agree" title="The name on the card matches">&#10003; name</span>` : ""}${check}<br><span class="bulk-sub">${escHtml(sub)}</span></span>
    </label>
  </li>`;
}

function updateBulkCount() {
  const kept = _bulk.pairs.filter((pair) => !_bulk.skipped.has(pair.idx)).length;
  bulkConfirm.textContent = confirmLabel(kept);
  bulkConfirm.disabled = kept === 0;
  bulkHint.hidden = kept !== 0;
  bulkTickAll.textContent = tickAllLabel(kept === _bulk.pairs.length);
  return kept;
}

function openBulk(opener) {
  const scan = _lastResult;
  const pairs = bulkPairs(scan?.cards);
  if (!pairs.length) return;
  _bulk = { pairs, explicit: new Set(), skipped: new Set(pairs.filter((pair) => !pair.decisive).map((pair) => pair.idx)), opener: opener || document.activeElement, scan };
  bulkList.innerHTML = pairs.map(bulkPairHtml).join("");
  updateBulkCount();
  bulkPanel.hidden = false;
  bulkList.querySelector("input")?.focus();
}

// restoreFocus: false when the list is about to be replaced anyway.
function closeBulk(restoreFocus = true) {
  if (!_bulk) return;
  const opener = _bulk.opener;
  _bulk = null;
  bulkPanel.hidden = true;
  bulkList.innerHTML = "";
  if (!restoreFocus) return;
  const target = opener?.isConnected ? opener : resultsEl.querySelector("[data-review-all], [data-choose-toggle], .card-row button") || btnScan;
  target.focus();
}

function confirmBulk() {
  if (!_bulk) return;
  const { pairs, skipped, scan, explicit } = _bulk;
  const kept = pairs.filter((pair) => !skipped.has(pair.idx));
  const remembered = new Set(bulkRememberedPairs(kept, explicit).map((pair) => pair.idx));
  closeBulk(false);
  if (_lastResult !== scan) return;
  // Each pair goes through the same pick as a single confirm, so the price is the same. Only a Check pair the user
  // ticked by hand is saved as their correction; ticking the scanner's own preselection confirms it for this session.
  for (const pair of kept) pickCard(pair.idx, pair.candidate.id, "candidates", pair.candidate, remembered.has(pair.idx));
  showMessage(`Confirmed ${kept.length} ${kept.length === 1 ? "card" : "cards"}. Prices are loading.`);
  (resultsEl.querySelector("[data-review-all], [data-choose-toggle]") || btnScan).focus();
}

bulkList.addEventListener("change", (e) => {
  if (!_bulk || !e.target.matches("[data-bulk-keep]")) return;
  const idx = Number(e.target.dataset.idx);
  if (e.target.checked) { _bulk.skipped.delete(idx); _bulk.explicit.add(idx); }
  else { _bulk.skipped.add(idx); _bulk.explicit.delete(idx); }
  e.target.closest(".bulk-pair").classList.toggle("skipped", !e.target.checked);
  updateBulkCount();
});
// Only the checkboxes change; nothing is confirmed until "Confirm N".
bulkTickAll.addEventListener("click", () => {
  if (!_bulk) return;
  const tick = _bulk.skipped.size > 0;
  _bulk.skipped = tick ? new Set() : new Set(_bulk.pairs.map((pair) => pair.idx));
  for (const box of bulkList.querySelectorAll("[data-bulk-keep]")) {
    box.checked = tick;
    box.closest(".bulk-pair").classList.toggle("skipped", !tick);
  }
  updateBulkCount();
});
bulkConfirm.addEventListener("click", confirmBulk);
bulkClose.addEventListener("click", () => closeBulk());
bulkCancel.addEventListener("click", () => closeBulk());
bulkPanel.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeBulk();
    return;
  }
  if (e.key !== "Tab") return;
  // The panel covers the popup: keep Tab inside it.
  const focusable = [...bulkPanel.querySelectorAll("input, button")].filter((el) => !el.disabled);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

let _highlighted = null;

function highlightOnPage(idx, scroll = false) {
  if (idx === _highlighted && !scroll) return;
  _highlighted = idx;
  chrome.runtime.sendMessage({ action: "highlightCard", index: idx, scroll }).catch(() => {});
}

function rowIndex(target) {
  const row = target?.closest?.(".card-row[data-idx]");
  return row && resultsEl.contains(row) ? Number(row.dataset.idx) : null;
}

resultsEl.addEventListener("mouseover", (e) => highlightOnPage(rowIndex(e.target)));
resultsEl.addEventListener("focusin", (e) => highlightOnPage(rowIndex(e.target)));
resultsEl.addEventListener("mouseleave", () => highlightOnPage(null));

resultsEl.addEventListener("keydown", (e) => {
  if (moveInGroup(e)) return;
  if (e.key === "Escape" && e.target.classList.contains("picker-input")) {
    e.preventDefault();
    closeSearch(Number(e.target.dataset.idx));
  }
});

resultsEl.addEventListener("input", (e) => {
  if (e.target.classList.contains("picker-input")) onSearchInput(Number(e.target.dataset.idx), e.target.value);
});

// The only sign that a printing is a guess; why it was chosen is in the tooltip, not in a sentence.
function guessMark(card, idx) {
  if (!card.bestGuess || card.setConfirmed === true) return "";
  const why = escHtml(card.bestGuess.reason || "Suggested set");
  return ` <button type="button" class="guess-mark" data-guess-confirm data-idx="${idx}" title="${why}" aria-label="Suggested set: ${why}. Press to confirm this set.">?</button>`;
}

// A set the user picked, or a guess they accepted, is an answer worth keeping like any other pick.
function saveSetCorrection(idx, id, via) {
  const message = setMenuCorrection(_lastResult, idx, id, via);
  if (!message) return;
  chrome.runtime.sendMessage(message).then((resp) => {
    if (resp?.error) showMessage(resp.error, true);
  }).catch((err) => showMessage(explainScanError(err?.message || err), true));
}

// Printings of the same card: a strip of thumbnails, one tap picks (same saveCorrection and pickSet as the old menu).
function renderSetRow(card, idx) {
  const tiles = setTiles(card);
  if (!tiles.length) return "";
  const open = needsPrinting(card);
  return `<div class="variant-select-row strip-row set-select-row">
    <span class="lbl${open ? " pick-printing" : ""}">${open ? "Pick printing" : "Set?"}</span>
    ${renderTileStrip({ kind: "set", idx, label: "Choose the printing", tiles, expanded: _stripMore.has(`${idx}:set`), locked: Boolean(card.pricing) })}
  </div>`;
}

// The matcher's best card is shown with its own price; a look-alike version (Pikachu ex beside Pikachu V) is one tap away.
function renderVersionRow(card, idx) {
  const tiles = versionTiles(card, enabledConditions());
  if (!tiles.length) return "";
  return `<div class="variant-select-row strip-row version-select-row">
    <span class="lbl">Other version?</span>
    ${renderTileStrip({ kind: "version", idx, label: "Choose the version", tiles, expanded: _stripMore.has(`${idx}:version`) })}
  </div>`;
}

function replaceCard(idx, next) {
  const hadFocus = resultsEl.contains(document.activeElement);
  const active = document.activeElement?.closest?.("[data-strip-kind]");
  const strip = active ? { kind: active.dataset.stripKind, id: active.dataset.stripPick } : null;
  // Focus on another row's Confirm button (moved there after a confirm) stays on that button through the re-render.
  const keptConfirm = document.activeElement?.matches?.("[data-confirm-best]") && Number(document.activeElement.dataset.idx) !== idx
    ? Number(document.activeElement.dataset.idx) : null;
  const cards = _lastResult.cards.map((card, i) => (i === idx ? next : card));
  _lastResult = { ..._lastResult, cards };
  refreshStatus();
  _variantChoice.delete(idx);
  _variantSuggest.delete(idx);
  _variantPicked.delete(idx);
  seedVariant(next, idx);
  renderResults();
  if (hadFocus && !resultsEl.contains(document.activeElement)) {
    const kept = keptConfirm === null ? null : resultsEl.querySelector(`.choose-row[data-idx="${keptConfirm}"] [data-confirm-best]`);
    if (kept) kept.focus(); else focusOpener(idx, null, strip);
  }
  updateStats(cards);
  pushOverlay();
}

// picked is the catalog row the user chose from candidates or search; null when the set menu was used.
async function pickSet(idx, id, picked = null) {
  const scan = _lastResult;
  const card = scan?.cards?.[idx];
  if (!card) return;
  const token = ++_pickSeq;
  _pickToken.set(idx, token);
  // A new scan replaced the results, or the user picked again, while this price was loading.
  const stale = () => _lastResult?.scanId !== scan.scanId || _pickToken.get(idx) !== token;
  const unpriced = { market_price: null, price_variant: null, price_grid: null, priceError: null };
  if (!id) {
    replaceCard(idx, { ...card, ...unpriced, identity: { name: card.identity?.name }, setConfirmed: false, bestGuess: undefined });
    return;
  }
  const label = picked?.name || card.identity?.name || "this card";
  if (picked) {
    // The other sets on offer no longer apply, and the old card's price must not stay on screen.
    replaceCard(idx, { ...card, ...unpriced, identity: picked, setChoices: [], setConfirmed: false, bestGuess: undefined, pricing: true });
    showMessage(`Getting price for ${label}…`);
  } else {
    replaceCard(idx, { ...card, bestGuess: undefined, pricing: true, priceError: null });
  }
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ action: "priceCard", id });
  } catch (err) {
    resp = { error: explainScanError(err?.message || err) };
  }
  if (stale()) return;
  const current = _lastResult.cards[idx];
  if (!resp || resp.error) {
    const error = resp?.error || "Couldn't get a price. Try again.";
    replaceCard(idx, { ...current, ...unpriced, pricing: false, priceError: error });
    if (picked) showMessage(error, true);
    return;
  }
  replaceCard(idx, {
    ...current,
    identity: resp.identity,
    market_price: resp.market_price,
    price_variant: resp.price_variant,
    price_grid: resp.price_grid,
    setConfirmed: true,
    userConfirmed: true,
    // A card the scanner gave up on is still a card the user named.
    ...(picked ? { abstain: false, confidence: 1 } : {}),
    pricing: false,
    priceError: null,
  });
  if (picked) showMessage(_advanceNote.delete(idx) ? confirmedNote(resp.identity?.name || label) : `Price updated for ${resp.identity?.name || label}.`);
}

// A printing settled by the printed number prices at once; one the picture suggests only preselects the menu.
function seedVariant(card, idx) {
  const settled = detectedVariant(card);
  if (settled) { _variantChoice.set(idx, settled); return; }
  const suggested = suggestedVariant(card);
  if (suggested) _variantSuggest.set(idx, suggested);
}

function renderVariantRow(card, idx) {
  const grid = card.price_grid;
  const chosen = _variantChoice.get(idx) || "";
  const suggested = chosen ? "" : _variantSuggest.get(idx) || "";
  const chips = finishChips(grid, { chosen, suggested, conditions: enabledConditions() });
  if (!chips.length) return "";
  const picked = chosen || suggested;
  const seen = picked && (picked === suggestedVariant(card));
  const stampNote = {
    prerelease: "Prerelease stamp found",
    staff: "Staff stamp found",
    league: "League stamp found",
    setstamp: "Set stamp found",
  }[card.variant?.stamp];
  const note = seen
    ? (stampNote || editionNote(card) || (card.firstEdition ? "1st Edition stamp found" : card.shadow ? "Drop shadow seen" : "Variant seen on the card"))
    : (editionNote(card) || printingNote(grid));
  const confirmMark = suggested ? `<button type="button" class="guess-mark" data-variant-confirm data-idx="${idx}" title="Suggested from the picture, which glare can fool. Press to confirm this printing." aria-label="Suggested printing ${escHtml(formatPrinting(suggested))}. Press to confirm it.">?</button>` : "";
  return `<div class="variant-select-row strip-row">
    <span class="lbl">Variant</span>
    ${renderChipGroup({ idx, label: "Choose the finish", chips, note: note || "", confirmMark })}
  </div>`;
}

function renderGradedGrid(card, grid) {
  if (!grid || !grid.graded) return "";
  const enabled = new Set(enabledGraders());
  const graders = Object.keys(grid.graded).filter((g) => enabled.size === 0 ? false : enabled.has(g));
  if (graders.length === 0) return "";
  const cells = [];
  for (const g of graders) {
    for (const [grade, price] of Object.entries(grid.graded[g])) {
      if (price == null || !Number.isFinite(Number(price))) continue;
      cells.push(`<div class="graded-cell"><span class="g-lbl">${escHtml(g)} ${escHtml(grade)}</span> <span class="g-val">$${Number(price).toFixed(2)}</span></div>`);
    }
  }
  if (cells.length === 0) return "";
  return `<div class="graded-grid">${cells.join("")}</div>`;
}

/* ─── Overlay push ─── */

function pushOverlay() {
  if (!_lastResult) return;
  const cards = _lastResult.cards.map((c, idx) => ({
    box: c.box,
    docBox: c.docBox,
    identity: c.identity,
    confidence: c.confidence,
    abstain: c.abstain,
    ...(c.inGallery ? { inGallery: true } : {}),
    display: {
      ...computeDisplayForOverlay(c, idx),
      state: overlayStateOf(c),
      ...(readFromSmallCrop(c) ? { small: true } : {}),
      ...(isStale(c) ? { stale: true } : {}),
      ...(c.valueCheck && chooseState(c) === "choose" ? { valueCheck: true } : {}),
    },
  }));
  chrome.runtime.sendMessage({
    action: "overlayWithGrid",
    cards,
    ...(_lastResult.fullSize ? { fullSize: { url: _lastResult.fullSize.url } } : {}),
    srcWidth: _lastResult.srcWidth,
    srcHeight: _lastResult.srcHeight,
  }).catch(() => {});
}

function computeDisplayForOverlay(card, idx) {
  // A card to choose shows neither a name nor a price on the page.
  if (card.abstain || chooseState(card) === "choose" || chooseState(card) === "skipped") return null;
  const id = card.identity || {};
  if (!isSetConfirmed(card)) {
    const range = setRangeNote(card.setRange, enabledConditions());
    return { name: id.name || null, price: null, printingNote: range ? `set not sure · ${range}` : "set not sure — pick it in the popup", footer: null };
  }
  const printing = chosenPrinting(card, idx);
  const quote = quotedPrice(card, printing, enabledConditions());
  return {
    name: id.name || null,
    set:  id.set  || null,
    setCode: id.setCode || null,
    number: id.number || null,
    printing: quote?.printing ? formatPrinting(quote.printing) : null,
    condition: quote?.condition || null,
    price: quote ? quote.price : null,
    spreadRatio: card.price_grid?.spreadRatio || 1,
    printingNote: quote ? null : chosenPrintingHasNoPrice(card, printing, enabledConditions()) ? "No price for this printing" : printingNote(card.price_grid),
    footer: sourceFooter(card.price_grid),
  };
}

/* ─── Init ─── */

(async () => {
  await loadFilters();
  try { await checkReady(); }
  catch (err) {
    setupOverlay.style.display = "flex";
    setupStatus.textContent = explainScanError(err.message);
  }
})();
