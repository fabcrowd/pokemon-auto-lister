import { confTier, detectedVariant, editionNote, explainScanError, isSetConfirmed, lotTotal, modelFileLabel, printingNote, quotedPrice, scanStatus, sourceFooter, sourceName, splitByRecognition } from "./lib/card-display.js";
import { ERAS, eraById } from "./lib/era.js";
import { cropThumb, escHtml, guessOf, isUnsure, matchesLabel, renderPickList, renderUnrecognisedGroup, unrecognisedLabel } from "./lib/card-picker.js";
import { getPptKey } from "./lib/ppt-key.js";
import { hasAllSites, requestAllSites } from "./lib/site-access.js";

const btnScan      = document.getElementById("btn-scan");
const btnClear     = document.getElementById("btn-clear");
const btnLabel     = document.getElementById("btn-label");
const btnOptions   = document.getElementById("open-options");
const modelPill    = document.getElementById("model-pill");
const mdot         = document.getElementById("mdot");
const mtext        = document.getElementById("mtext");
const sourcePill   = document.getElementById("source-pill");
const sourceText   = document.getElementById("source-text");
const hintStrip    = document.getElementById("hint-strip");
const hintLink     = document.getElementById("hint-link");
const hintDismiss  = document.getElementById("hint-dismiss");
const wizStep1     = document.getElementById("wiz-step-1");
const wizStep2     = document.getElementById("wiz-step-2");
const wizStepAccess = document.getElementById("wiz-step-access");
const btnWizAccess  = document.getElementById("btn-wiz-access");
const btnWizAccessSkip = document.getElementById("btn-wiz-access-skip");
const btnWizUpgrade = document.getElementById("btn-wiz-upgrade");
const btnWizSkip    = document.getElementById("btn-wiz-skip");
const sDetected    = document.getElementById("s-detected");
const sValue       = document.getElementById("s-value");
const sMs          = document.getElementById("s-ms");
const resultsEl    = document.getElementById("results");
const emptyHint    = document.getElementById("empty-hint");
const msgBar       = document.getElementById("msg-bar");
const setupOverlay = document.getElementById("setup-overlay");
const btnSetup     = document.getElementById("btn-setup");
const setupStatus  = document.getElementById("setup-status");
const setupBars    = document.getElementById("setup-bars");
const eraSelect    = document.getElementById("era-select");

const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];
const DEFAULT_FILTERS = {
  raw:    { NM: true, LP: false, MP: false, HP: false, DMG: false },
  graded: { PSA: false, BGS: false, CGC: false, SGC: false },
};

let isScanning = false;
let _lastResult = null;
let _scanSeq = 0;
let _filters   = JSON.parse(JSON.stringify(DEFAULT_FILTERS));
let _variantChoice = new Map(); // card index -> printing chosen this scan
let _picker = new Map();        // card index -> { via, query, results } while its search box is open
let _showUnrecognised = false;  // the "not recognised" group is open
let _searchTimer = null;
let _pickSeq = 0;
const _pickToken = new Map();   // card index -> its latest pick; a slower earlier price is dropped

/* ─── Model status pill ─── */

function setModelStatus(state, label) {
  modelPill.className = "model-pill " + state;
  mdot.className      = "mdot " + state;
  mtext.textContent   = label;
}

function showMessage(text, isError = false) {
  msgBar.textContent = text;
  msgBar.classList.toggle("error", isError);
  msgBar.setAttribute("role", isError ? "alert" : "status");
  msgBar.classList.toggle("hidden", !text);
}

async function checkReady() {
  const resp = await chrome.runtime.sendMessage({ action: "checkReady" });
  const ready = Boolean(resp?.ready);
  setModelStatus(ready ? "ok" : "err", ready ? "AI ready" : "setup needed");
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
    setModelStatus("ok", "AI ready");
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
sourcePill.addEventListener("click", () => chrome.runtime.openOptionsPage());
hintLink.addEventListener("click", () => chrome.runtime.openOptionsPage());
hintDismiss.addEventListener("click", () => {
  chrome.storage.sync.set({ hintDismissed: true });
  hintStrip.classList.remove("visible");
});

/* ─── Pricing source pill + hint strip ─── */

function dominantSource(cards) {
  const counts = {};
  for (const c of cards || []) {
    const s = c?.price_grid?.source || (c?.market_price != null ? "pokemontcg" : null);
    if (!s) continue;
    counts[s] = (counts[s] || 0) + 1;
  }
  let best = null, bestN = 0;
  for (const [s, n] of Object.entries(counts)) if (n > bestN) { best = s; bestN = n; }
  return best;
}

async function refreshSourceIndicators(cards) {
  const src = dominantSource(cards);
  if (!src) {
    sourcePill.classList.remove("visible");
    hintStrip.classList.remove("visible");
    return;
  }
  const marketOnly = src === "pokemontcg" || src === "tcgdex";
  sourcePill.className = `source-pill visible ${marketOnly ? "pokemontcg" : src}`;
  sourceText.textContent = sourceName({ source: src }) || src;

  // Hint strip: show only when on pokemontcg fallback AND not previously dismissed
  const { hintDismissed } = await new Promise((r) =>
    chrome.storage.sync.get("hintDismissed", (res) => r(res || {})),
  );
  if (marketOnly && !hintDismissed) hintStrip.classList.add("visible");
  else hintStrip.classList.remove("visible");
}

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
  showMessage("Capturing page and running detection…");

  const t0 = performance.now();
  let data;
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
  updateStats(_lastResult.cards, Math.round(performance.now() - t0));
  renderResults();
  refreshSourceIndicators(_lastResult.cards);
  finishScan();

  if (cards.length === 0) {
    showMessage("No Pokémon cards detected on this page.");
  } else {
    const unconfirmed = lotTotal(cards, (card) => _variantChoice.get(cards.indexOf(card)) || null, enabledConditions()).unconfirmed;
    const needSet = cards.filter((c) => !isSetConfirmed(c)).length;
    const needPrinting = unconfirmed - needSet;
    const found = `${scanStatus(cards)}.`;
    const asks = [
      needSet ? `a set on ${needSet}` : "",
      needPrinting ? `a variant on ${needPrinting}` : "",
    ].filter(Boolean).join(" and ");
    const stillLoading = data.pending > 0
      ? ` ${data.pending} picture${data.pending === 1 ? " is" : "s are"} still loading.`
      : "";
    const eraTip = needSet >= 2 && !eraSelect.value ? " Choosing the era below narrows the sets." : "";
    showMessage((asks
      ? `${found} Choose ${asks} before the total includes them.${eraTip}`
      : found) + stillLoading);
  }

  // Push the overlay snapshot with current filter state baked in
  pushOverlay();
}

function finishScan() {
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
      if (res?.filters) _filters = mergeFilters(DEFAULT_FILTERS, res.filters);
      resolve();
    });
  });
}

function saveFilters() {
  chrome.storage.sync.set({ filters: _filters });
}

function mergeFilters(base, saved) {
  const out = JSON.parse(JSON.stringify(base));
  for (const group of Object.keys(base)) {
    if (!saved[group]) continue;
    for (const key of Object.keys(base[group])) {
      if (typeof saved[group][key] === "boolean") out[group][key] = saved[group][key];
    }
  }
  return out;
}

function wireFilterChips() {
  document.querySelectorAll(".chip[data-filter]").forEach((el) => {
    const [group, key] = el.dataset.filter.split(".");
    const on = Boolean(_filters[group]?.[key]);
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", String(on));
    el.addEventListener("click", () => {
      _filters[group][key] = !_filters[group][key];
      el.classList.toggle("on", _filters[group][key]);
      el.setAttribute("aria-pressed", String(_filters[group][key]));
      saveFilters();
      renderResults();
      pushOverlay();
    });
  });
}

function enabledConditions() { return CONDITIONS.filter((c) => _filters.raw[c]); }
function enabledGraders()    { return Object.keys(_filters.graded).filter((g) => _filters.graded[g]); }

/* ─── Stats + results ─── */

function updateStats(cards, ms) {
  const lot = lotTotal(cards, (card) => _variantChoice.get(cards.indexOf(card)) || null, enabledConditions());
  sDetected.textContent = cards.length > 0 ? String(cards.length) : "—";
  sValue.textContent    = lot.total > 0 ? "$" + lot.total.toFixed(2) : "—";
  sMs.textContent       = String(ms);
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
  sDetected.textContent = "—";
  sValue.textContent    = "—";
  sMs.textContent       = "—";
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
    sel.addEventListener("change", (e) => pickSet(Number(e.target.dataset.idx), e.target.value));
  });

  // Wire variant selectors
  document.querySelectorAll(".variant-select-row select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const value = e.target.value;
      if (value) _variantChoice.set(idx, value);
      else _variantChoice.delete(idx);
      renderResults();
      pushOverlay();
      updateStats(cards, Number(sMs.textContent) || 0);
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
  const printing = chosenPrinting(card, idx);
  const source   = grid?.source || "pokemontcg";
  const setKnown = isSetConfirmed(card);

  const setHtml = code ? `<span class="set-chip">${escHtml(code)}</span>` : "";
  const subHtml = setKnown
    ? `${setHtml}${escHtml(set)}${num ? ` <span class="card-number">#${escHtml(num)}</span>` : ""}`
    : "Set not sure";

  const askRow     = renderAskRow(card, idx);
  const lone       = (card.setChoices?.length || 0) <= 1;
  const pricingRow = lone && card.pricing ? `<div class="no-price">Getting price…</div>`
    : lone && card.priceError ? `<div class="spread-warn">${escHtml(card.priceError)}</div>` : "";
  // The candidates already include the set choices; a second menu would ask the same question twice.
  const setRow     = card.candidates?.length ? "" : renderSetRow(card, idx);
  const variantRow = setKnown ? renderVariantRow(card, idx) : "";
  const condRow    = setKnown ? renderConditionGrid(card, printing) : "";
  const gradedRow  = setKnown ? renderGradedGrid(card, grid) : "";
  const srcClass   = source === "backend" ? "backend" : (source === "ppt" ? "ppt" : "pokemontcg");

  return `<div class="card-row" data-idx="${idx}">
    <div class="card-head">
      <div class="conf-stripe ${tier}"></div>
      <div class="card-meta">
        <div class="card-name">${escHtml(name)}</div>
        <div class="card-sub">${subHtml}</div>
      </div>
      ${grid ? `<div class="src-badge ${srcClass}" title="pricing source">${escHtml(sourceName({ source }) || source)}</div>` : ""}
      <button type="button" class="link-btn" data-open-search data-via="wrong-card" data-idx="${idx}" aria-label="Wrong card? Search for the right one for ${escHtml(name)}">Wrong card?</button>
    </div>
    ${askRow}
    ${pricingRow}
    ${setRow}
    ${variantRow}
    ${condRow}
    ${gradedRow}
  </div>`;
}

// Nothing is known about this card, so no name, price or picker: just a way to look it up.
function renderUnrecognisedRow(card, idx) {
  const thumb = cropThumb(card);
  const label = card.cardBack ? `Card ${idx + 1}: card back, turn it over to identify it` : `Card ${idx + 1}`;
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
        <div class="pick-row">${renderPickList(card.candidates, idx)}</div>
        ${state ? "" : `<button type="button" class="link-btn" data-open-search data-via="search" data-idx="${idx}">Not listed? Search</button>`}
      </div>`
    : "";
  return ask + renderSearchPanel(idx);
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
  else _picker.set(idx, { via, query: "", results: null });
  renderResults();
  resultsEl.querySelector(`.picker-input[data-idx="${idx}"]`)?.focus();
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
  if (button.dataset.pick) {
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
  }
});

resultsEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.classList.contains("picker-input")) {
    e.preventDefault();
    closeSearch(Number(e.target.dataset.idx));
  }
});

resultsEl.addEventListener("input", (e) => {
  if (e.target.classList.contains("picker-input")) onSearchInput(Number(e.target.dataset.idx), e.target.value);
});

function renderSetRow(card, idx) {
  const choices = card.setChoices || [];
  if (choices.length <= 1) return "";
  const picked = card.setConfirmed ? card.identity?.id : "";
  const blank = `<option value="" ${picked ? "" : "selected"}>Choose set</option>`;
  const options = choices.map((c) => {
    const label = `${c.set || c.setCode || "Unknown set"}${c.number ? " #" + c.number : ""}`;
    return `<option value="${escHtml(c.id)}" ${c.id === picked ? "selected" : ""}>${escHtml(label)}</option>`;
  }).join("");
  const status = card.pricing ? `<span class="spread-warn">Getting price…</span>`
    : card.priceError ? `<span class="spread-warn">${escHtml(card.priceError)}</span>` : "";
  return `<div class="variant-select-row set-select-row">
    <span class="lbl">Set</span>
    <select data-idx="${idx}" aria-label="Set" ${card.pricing ? "disabled" : ""}>${blank}${options}</select>
    ${status}
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
  updateStats(cards, Number(sMs.textContent) || 0);
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
    replaceCard(idx, { ...card, ...unpriced, identity: { name: card.identity?.name }, setConfirmed: false });
    return;
  }
  const label = picked?.name || card.identity?.name || "this card";
  if (picked) {
    // The other sets on offer no longer apply, and the old card's price must not stay on screen.
    replaceCard(idx, { ...card, ...unpriced, identity: picked, setChoices: [], setConfirmed: false, pricing: true });
    showMessage(`Getting price for ${label}…`);
  } else {
    replaceCard(idx, { ...card, pricing: true, priceError: null });
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
  const shadowless = editionNote(card);
  if (printings.length <= 1) return shadowless ? `<div class="spread-warn">${escHtml(shadowless)}</div>` : "";
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
    <select data-idx="${idx}" aria-label="Variant">${blank}${options}</select>
    ${note ? `<span class="spread-warn">${escHtml(note)}</span>` : ""}
  </div>`;
}

function renderConditionGrid(card, printing) {
  if (card.cardBack) return `<div class="no-price">turn the card over to identify it</div>`;
  const grid = card.price_grid;
  const printings = Object.keys(grid?.variants || {});
  // The printing row already shows the range. Don't repeat it under the menu.
  if (printings.length > 1 && !printing) return "";
  if (!grid || !printing || !grid.variants[printing]) {
    const legacy = card.market_price;
    if (legacy == null) return `<div class="no-price">no price data</div>`;
    return `<div class="price-grid">
      <div class="price-cell highlight"><div class="lbl">NM</div><div class="val">$${legacy.toFixed(2)}</div></div>
      ${CONDITIONS.slice(1).map((c) => `<div class="price-cell na"><div class="lbl">${c}</div><div class="val">—</div></div>`).join("")}
    </div>`;
  }
  const conds = grid.variants[printing].conditions;
  const enabled = new Set(enabledConditions());
  const anyEnabled = enabled.size > 0;
  return `<div class="price-grid">${CONDITIONS.map((c) => {
    const v = conds[c];
    const na = v == null;
    const hi = anyEnabled && enabled.has(c);
    return `<div class="price-cell ${na ? "na" : ""} ${hi ? "highlight" : ""}">
      <div class="lbl">${c}</div>
      <div class="val">${na ? "—" : "$" + v.toFixed(2)}</div>
    </div>`;
  }).join("")}</div>`;
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
    identity: c.identity,
    confidence: c.confidence,
    abstain: c.abstain,
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
    return { name: id.name || null, price: null, printingNote: "set not sure — pick it in the popup", footer: null };
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
  wireFilterChips();
  try { await checkReady(); }
  catch (err) {
    setModelStatus("err", "not running");
    setupOverlay.style.display = "flex";
    setupStatus.textContent = explainScanError(err.message);
  }
})();
