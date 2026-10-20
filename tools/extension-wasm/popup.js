import { truncationNote } from "./lib/page-scan.js";
import { confTier, detectedVariant, editionNote, explainScanError, isSetConfirmed, lotValue, modelFileLabel, printingNote, quotedPrice, needsPrinting, fromSeveralPhotos, photoLabel, scanStatus, setRangeSpan, setRangeNote, sourceFooter, splitByRecognition, swapVersion, versionLabel, confirmGuess } from "./lib/card-display.js";
import { ERAS, eraById } from "./lib/era.js";
import { cropThumb, escHtml, guessOf, isUnsure, matchesLabel, renderPickList, renderUnrecognisedGroup, setMenuCorrection, unrecognisedLabel } from "./lib/card-picker.js";
import { DEFAULT_FILTERS, mergeFilters } from "./lib/price-prefs.js";
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

const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];

let isScanning = false;
let _lastResult = null;
let _scanSeq = 0;
let _filters   = mergeFilters(DEFAULT_FILTERS);
let _variantChoice = new Map(); // card index -> printing chosen this scan
let _picker = new Map();        // card index -> { via, query, results } while its search box is open
let _showUnrecognised = false;  // the "not recognised" group is open
let _searchTimer = null;
let _pickSeq = 0;
const _pickToken = new Map();   // card index -> its latest pick; a slower earlier price is dropped

function showMessage(text, isError = false) {
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
    // Move the wizard forward: site access, then the PPT upsell (each skipped when already settled)
    await setOnboarding({ step: "access" });
    await maybeStartWizard(true);
  } else {
    console.error("model download failed", resp?.error || "unknown error");
    setupStatus.textContent = "The download stopped. Check your connection and try again.";
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
  _picker = new Map();
  _showUnrecognised = false;
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

  const cards = (data.cards || []).map((card) => ({ ...card, guess: guessOf(card) }));
  _lastResult = { scanId: ++_scanSeq, bgScanId: data.scanId, cards, srcWidth: data.srcWidth, srcHeight: data.srcHeight };
  _variantChoice = new Map();
  _picker = new Map();
  _showUnrecognised = false;
  _lastResult.cards.forEach(seedVariant);
  // Offered only to someone who opted in, on a photo picked for checking; it never blocks anything.
  examStrip.hidden = data.shareExam !== true;
  updateStats(_lastResult.cards);
  renderResults();
  finishScan();
  maybeOfferSiteAccess(data).catch(() => { accessNotice.hidden = true; });

  if (cards.length === 0) {
    showMessage("No Pokémon cards detected on this page.");
  } else {
    const stillLoading = data.pending > 0
      ? ` ${data.pending} picture${data.pending === 1 ? " is" : "s are"} still loading.`
      : "";
    showMessage(`${scanStatus(cards)}${truncationNote(data.truncated)}.${stillLoading}`);
  }

  // Push the overlay snapshot with current filter state baked in
  pushOverlay();
}

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
  const lot = lotValue(cards, (card) => _variantChoice.get(cards.indexOf(card)) || null, enabledConditions());
  sValue.textContent = lot.value ?? "—";
  setStatDetail(lot.detail);
}

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
  resultsEl.innerHTML   = "";
  resultsEl.appendChild(emptyHint);
}

function renderResults() {
  const cards = _lastResult?.cards || [];
  if (cards.length === 0) { resetResults(); return; }
  emptyHint.remove();

  const { shown, hidden } = splitByRecognition(cards);
  resultsEl.innerHTML = shown.map((idx) => renderCardRow(cards[idx], idx)).join("")
    + renderUnrecognisedGroup(hidden.map((idx) => renderUnrecognisedRow(cards[idx], idx)).join(""), hidden.length, _showUnrecognised);

  document.querySelectorAll(".set-select-row select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      saveSetCorrection(idx, e.target.value, "set-menu");
      pickSet(idx, e.target.value);
    });
  });

  document.querySelectorAll(".version-select-row select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const card = _lastResult?.cards?.[idx];
      if (card && e.target.value) replaceCard(idx, swapVersion(card, e.target.value));
    });
  });

  // Wire variant selectors
  document.querySelectorAll(".variant-select-row:not(.version-select-row) select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const value = e.target.value;
      if (value) _variantChoice.set(idx, value);
      else _variantChoice.delete(idx);
      renderResults();
      pushOverlay();
      updateStats(cards);
    });
  });
}

function renderCardRow(card, idx) {
  const id   = card.identity || {};
  const name = id.name    || (card.cardBack ? "Card back" : "Unknown card");
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

  const askRow     = renderAskRow(card, idx);
  // The candidates already include the set choices; a second menu would ask the same question twice.
  const setRow     = card.candidates?.length ? "" : renderSetRow(card, idx);
  const versionRow = renderVersionRow(card, idx);
  const variantRow = setKnown ? renderVariantRow(card, idx) : "";
  const gradedRow  = setKnown ? renderGradedGrid(card, grid) : "";
  const loneEdition = setKnown && Object.keys(grid?.variants || {}).length <= 1 ? editionNote(card) : null;
  const repeatMark = card.repeatedName
    ? ` <span class="repeat-mark" role="img" title="${REPEAT_NOTE}" aria-label="${REPEAT_NOTE}">⚠</span>`
    : "";

  // An asked card shows its picture in the question instead.
  const thumb = id.name || askRow ? null : cropThumb(card);
  return `<div class="card-row${askRow ? " asking" : ""}" data-idx="${idx}">
    <div class="card-head">
      <div class="conf-stripe ${tier}"></div>
      ${thumb ? `<img class="unrec-thumb" src="${escHtml(thumb)}" alt="" width="34" height="48">` : ""}
      <div class="card-meta">
        <div class="card-name"${loneEdition ? ` title="${escHtml(loneEdition)}"` : ""}>${escHtml(name)}${loneEdition ? ` <span class="sr-only">${escHtml(loneEdition)}</span>` : ""}${guessMark(card, idx)}${repeatMark}</div>
        <div class="card-sub">${subHtml}${photoHtml}</div>
      </div>
      ${renderPrice(card, idx)}
      <button type="button" class="link-btn" data-open-search data-via="wrong-card" data-idx="${idx}" aria-label="Wrong card? Search for the right one for ${escHtml(name)}">Wrong card?</button>
    </div>
    ${askRow}
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
    const title = [quote.condition, quote.printing ? formatPrinting(quote.printing) : null, sourceFooter(card.price_grid), ...others]
      .filter(Boolean).join(" · ");
    return cell("$" + Number(quote.price).toFixed(2), title);
  }
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

function renderAskRow(card, idx) {
  const state = _picker.get(idx);
  const ask = isUnsure(card) && !card.pricing
    ? `<div class="picker" role="group" aria-labelledby="picker-title-${idx}">
        <div class="picker-title" id="picker-title-${idx}">Which card is this?</div>
        ${(card.identity?.name && !card.lowCertainty) || !card.candidates?.length ? "" : `<div class="picker-sub">${card.lowCertainty ? "Best guess first, then the closest matches" : "Closest matches"}</div>`}
        <div class="pick-row">${renderScannedCard(card, idx)}${renderPickList(card.candidates, idx, card.lowCertainty ? card.identity?.id : null)}</div>
        ${state ? "" : `<button type="button" class="link-btn" data-open-search data-via="search" data-idx="${idx}">Not listed? Search</button>`}
      </div>`
    : "";
  return ask + renderSearchPanel(idx);
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

// Re-rendering drops the focused element, so keyboard users land back on a button in the same card.
function focusOpener(idx, via = "wrong-card") {
  const row = resultsEl.querySelector(`.card-row[data-idx="${idx}"]`);
  (row?.querySelector(`[data-open-search][data-via="${via}"]`) ?? row?.querySelector("[data-open-search]"))?.focus();
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

function pickCard(idx, id, via, row) {
  const scan = _lastResult;
  if (!scan?.cards?.[idx]) return;
  _picker.delete(idx);
  chrome.runtime.sendMessage({
    action: "saveCorrection", scanId: scan.bgScanId, index: idx, guess: scan.cards[idx].guess, pickedId: id, via,
  }).then((resp) => {
    if (resp?.error) showMessage(resp.error, true);
  }).catch((err) => showMessage(explainScanError(err?.message || err), true));
  return pickSet(idx, id, row ?? { id });
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
  const idx = Number(button.dataset.idx);
  if ("guessConfirm" in button.dataset) {
    const card = _lastResult?.cards?.[idx];
    if (!card?.bestGuess) return;
    saveSetCorrection(idx, card.identity?.id, "guess-confirmed");
    replaceCard(idx, confirmGuess(card));
  } else if (button.dataset.pick) {
    const fromSearch = Boolean(button.closest(".picker-results"));
    const shown = fromSearch ? _picker.get(idx)?.results : _lastResult?.cards?.[idx]?.candidates;
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
  const why = escHtml(card.bestGuess.reason || "Best guess");
  return ` <button type="button" class="guess-mark" data-guess-confirm data-idx="${idx}" title="${why}" aria-label="Best guess: ${why}. Press to confirm this set.">?</button>`;
}

// A set the user picked, or a guess they accepted, is an answer worth keeping like any other pick.
function saveSetCorrection(idx, id, via) {
  const message = setMenuCorrection(_lastResult, idx, id, via);
  if (!message) return;
  chrome.runtime.sendMessage(message).then((resp) => {
    if (resp?.error) showMessage(resp.error, true);
  }).catch((err) => showMessage(explainScanError(err?.message || err), true));
}

function renderSetRow(card, idx) {
  const choices = card.setChoices || [];
  if (choices.length <= 1) return "";
  const picked = card.setConfirmed || card.bestGuess ? card.identity?.id : "";
  const blank = `<option value="" ${picked ? "" : "selected"}>Choose set</option>`;
  const options = choices.map((c) => {
    const label = `${c.set || c.setCode || "Unknown set"}${c.number ? " #" + c.number : ""}`;
    return `<option value="${escHtml(c.id)}" ${c.id === picked ? "selected" : ""}>${escHtml(label)}</option>`;
  }).join("");
  return `<div class="variant-select-row set-select-row">
    <span class="lbl${needsPrinting(card) ? " pick-printing" : ""}">${needsPrinting(card) ? "Pick printing" : "Set?"}</span>
    <select data-idx="${idx}" aria-label="Set" ${card.pricing ? "disabled" : ""}>${blank}${options}</select>
  </div>`;
}

// The matcher's best card is shown with its own price; a look-alike version (Pikachu ex beside Pikachu V) is one tap away.
function renderVersionRow(card, idx) {
  const versions = card.versionChoices || [];
  if (!versions.length) return "";
  const options = versions.map((v) => `<option value="${escHtml(v.id)}">${escHtml(versionLabel(v, enabledConditions()))}</option>`).join("");
  return `<div class="variant-select-row version-select-row">
    <span class="lbl">Other version?</span>
    <select data-idx="${idx}" aria-label="Other version"><option value="" selected>Keep ${escHtml(card.identity?.name || "this card")}</option>${options}</select>
  </div>`;
}

function replaceCard(idx, next) {
  const hadFocus = resultsEl.contains(document.activeElement);
  const cards = _lastResult.cards.map((card, i) => (i === idx ? next : card));
  _lastResult = { ..._lastResult, cards };
  _variantChoice.delete(idx);
  seedVariant(next, idx);
  renderResults();
  if (hadFocus && !resultsEl.contains(document.activeElement)) focusOpener(idx);
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
    // A card the scanner gave up on is still a card the user named.
    ...(picked ? { abstain: false, confidence: 1 } : {}),
    pricing: false,
    priceError: null,
  });
  if (picked) showMessage(`Price updated for ${resp.identity?.name || label}.`);
}

function seedVariant(card, idx) {
  const seen = detectedVariant(card);
  if (seen) _variantChoice.set(idx, seen);
}

function renderVariantRow(card, idx) {
  const grid = card.price_grid;
  const printings = Object.keys(grid?.variants || {});
  if (printings.length <= 1) return "";
  const picked = _variantChoice.get(idx) || "";
  const blank = `<option value="" ${picked ? "" : "selected"}>Choose variant</option>`;
  const options = printings.map((p) => `<option value="${escHtml(p)}" ${p === picked ? "selected" : ""}>${escHtml(formatPrinting(p))}</option>`).join("");
  const seen = picked && picked === detectedVariant(card);
  const stampNote = {
    prerelease: "Prerelease stamp found",
    staff: "Staff stamp found",
    league: "League stamp found",
    setstamp: "Set stamp found",
  }[card.variant?.stamp];
  const note = seen
    ? (stampNote || editionNote(card) || (card.firstEdition ? "1st Edition stamp found" : card.shadow ? "Drop shadow seen" : "Variant seen on the card"))
    : (editionNote(card) || printingNote(grid));
  return `<div class="variant-select-row">
    <span class="lbl">Variant</span>
    <select data-idx="${idx}" aria-label="Variant${note ? `. ${escHtml(note)}` : ""}"${note ? ` title="${escHtml(note)}"` : ""}>${blank}${options}</select>
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

function formatPrinting(p) {
  // Prettify camelCase/compact names: "1stEditionHolofoil" → "1st Ed Holofoil"
  const s = String(p);
  if (/^1stEdition/i.test(s)) return "1st Ed " + s.slice(10);
  if (s === "holofoil") return "Holofoil";
  if (s === "normal") return "Normal";
  if (s === "reverseHolofoil") return "Reverse Holo";
  if (s === "unlimitedHolofoil") return "Unlimited Holo";
  return s.replace(/([A-Z])/g, " $1").trim().replace(/^./, (c) => c.toUpperCase());
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
    display: computeDisplayForOverlay(c, idx),
  }));
  chrome.runtime.sendMessage({
    action: "overlayWithGrid",
    cards,
    srcWidth: _lastResult.srcWidth,
    srcHeight: _lastResult.srcHeight,
  }).catch(() => {});
}

function computeDisplayForOverlay(card, idx) {
  if (card.abstain) return null;
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
    printingNote: quote ? null : printingNote(card.price_grid),
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
