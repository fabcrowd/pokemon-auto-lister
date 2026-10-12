import { explainScanError, isSetConfirmed, lotTotal, modelFileLabel, printingNote, quotedPrice, sourceFooter, sourceName } from "./lib/card-display.js";
import { ERAS, eraById } from "./lib/era.js";

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

/* ─── Model status pill ─── */

function setModelStatus(state, label) {
  modelPill.className = "model-pill " + state;
  mdot.className      = "mdot " + state;
  mtext.textContent   = label;
}

function showMessage(text, isError = false) {
  msgBar.textContent = text;
  msgBar.classList.toggle("error", isError);
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

// Onboarding state: { step: 1 | 2 | 'done' }
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
  wizStep2.classList.toggle("active", n === 2);
  setupOverlay.style.display = "flex";
}
function hideWizard() { setupOverlay.style.display = "none"; }

/**
 * Decide what to show on popup load:
 *   - models not ready → wizard step 1 (download)
 *   - models ready + onboarding not done + no PPT key → wizard step 2 (optional upsell)
 *   - otherwise → hidden
 */
async function maybeStartWizard(modelsReady) {
  const onboarding = await getOnboarding();
  const { pptApiKey } = await new Promise((r) =>
    chrome.storage.sync.get("pptApiKey", (res) => r(res || {})),
  );
  if (!modelsReady) {
    showWizStep(1);
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
    // Move the wizard forward: show the PPT upsell step (unless already keyed/skipped)
    await setOnboarding({ step: 2 });
    await maybeStartWizard(true);
  } else {
    console.error("model download failed", resp?.error || "unknown error");
    setupStatus.textContent = "The download stopped. Check your connection and try again.";
    btnSetup.disabled = false;
  }
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

  _lastResult = { scanId: ++_scanSeq, cards: data.cards || [], srcWidth: data.srcWidth, srcHeight: data.srcHeight };
  _variantChoice = new Map();
  updateStats(_lastResult.cards, Math.round(performance.now() - t0));
  renderResults();
  refreshSourceIndicators(_lastResult.cards);
  finishScan();

  const cards = _lastResult.cards;
  if (cards.length === 0) {
    showMessage("No Pokémon cards detected on this page.");
  } else {
    const identified = cards.filter((c) => !c.abstain).length;
    const unconfirmed = lotTotal(cards, (card) => _variantChoice.get(cards.indexOf(card)) || null).unconfirmed;
    const needSet = cards.filter((c) => !isSetConfirmed(c)).length;
    const needPrinting = unconfirmed - needSet;
    const found = `Found ${cards.length} card${cards.length === 1 ? "" : "s"} (${identified} identified).`;
    const asks = [
      needSet ? `a set on ${needSet}` : "",
      needPrinting ? `a printing on ${needPrinting}` : "",
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

function confTier(confidence) {
  if (confidence >= 0.80) return "high";
  if (confidence >= 0.50) return "medium";
  return "low";
}

function updateStats(cards, ms) {
  const lot = lotTotal(cards, (card) => _variantChoice.get(cards.indexOf(card)) || null);
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

  resultsEl.innerHTML = cards.map((card, idx) => renderCardRow(card, idx)).join("");

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

  const setRow     = renderSetRow(card, idx);
  const variantRow = setKnown ? renderVariantRow(card, idx) : "";
  const condRow    = setKnown ? renderConditionGrid(card, printing) : "";
  const gradedRow  = setKnown ? renderGradedGrid(card, grid) : "";
  const srcClass   = source === "backend" ? "backend" : (source === "ppt" ? "ppt" : "pokemontcg");

  return `<div class="card-row">
    <div class="card-head">
      <div class="conf-stripe ${tier}"></div>
      <div class="card-meta">
        <div class="card-name">${escHtml(name)}</div>
        <div class="card-sub">${subHtml}</div>
      </div>
      ${grid ? `<div class="src-badge ${srcClass}" title="pricing source">${escHtml(sourceName({ source }) || source)}</div>` : ""}
    </div>
    ${setRow}
    ${variantRow}
    ${condRow}
    ${gradedRow}
  </div>`;
}

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
  const cards = _lastResult.cards.map((card, i) => (i === idx ? next : card));
  _lastResult = { ..._lastResult, cards };
  _variantChoice.delete(idx);
  renderResults();
  updateStats(cards, Number(sMs.textContent) || 0);
  pushOverlay();
}

async function pickSet(idx, id) {
  const scan = _lastResult;
  const card = scan?.cards?.[idx];
  if (!card) return;
  const unpriced = { market_price: null, price_variant: null, price_grid: null, priceError: null };
  if (!id) {
    replaceCard(idx, { ...card, ...unpriced, identity: { name: card.identity?.name }, setConfirmed: false });
    return;
  }
  replaceCard(idx, { ...card, pricing: true, priceError: null });
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ action: "priceCard", id });
  } catch (err) {
    resp = { error: explainScanError(err?.message || err) };
  }
  // A new scan replaced the results while this price was loading.
  if (_lastResult?.scanId !== scan.scanId) return;
  const current = _lastResult.cards[idx];
  if (!resp || resp.error) {
    replaceCard(idx, { ...current, ...unpriced, pricing: false, priceError: resp?.error || "Couldn't get a price. Try again." });
    return;
  }
  replaceCard(idx, {
    ...current,
    identity: resp.identity,
    market_price: resp.market_price,
    price_variant: resp.price_variant,
    price_grid: resp.price_grid,
    setConfirmed: true,
    pricing: false,
    priceError: null,
  });
}

function renderVariantRow(card, idx) {
  const grid = card.price_grid;
  const printings = Object.keys(grid?.variants || {});
  if (printings.length <= 1) return "";
  const picked = _variantChoice.get(idx) || "";
  const blank = `<option value="" ${picked ? "" : "selected"}>Choose printing</option>`;
  const options = printings.map((p) => `<option value="${escHtml(p)}" ${p === picked ? "selected" : ""}>${escHtml(formatPrinting(p))}</option>`).join("");
  const note = printingNote(grid);
  return `<div class="variant-select-row">
    <span class="lbl">Printing</span>
    <select data-idx="${idx}" aria-label="Printing">${blank}${options}</select>
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

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
