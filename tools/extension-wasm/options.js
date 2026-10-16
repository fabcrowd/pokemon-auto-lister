const pptCard   = document.getElementById("ppt-card");
const pptStatus = document.getElementById("ppt-status");
const pptBodyNotConnected = document.getElementById("ppt-body-not-connected");
const pptBodyConnected    = document.getElementById("ppt-body-connected");
const pptKeyEl  = document.getElementById("ppt-key");
const pptTest   = document.getElementById("ppt-test");
const btnSave   = document.getElementById("save-ppt");
const btnChange = document.getElementById("change-ppt");
const btnClear  = document.getElementById("clear-ppt");

const backendDetails = document.getElementById("advanced-backend");
const backendStatus  = document.getElementById("backend-status");
const backendDetail  = document.getElementById("backend-detail");

/* ─── PPT key UI ─── */

function setPptConnected() {
  pptCard.classList.add("connected");
  pptStatus.textContent = "Connected";
  pptStatus.className = "source-status connected";
  pptBodyNotConnected.style.display = "none";
  pptBodyConnected.style.display    = "block";
}

function setPptDisconnected() {
  pptCard.classList.remove("connected");
  pptStatus.textContent = "Not connected";
  pptStatus.className = "source-status off";
  pptBodyNotConnected.style.display = "block";
  pptBodyConnected.style.display    = "none";
}

async function loadKey() {
  const { pptApiKey } = await new Promise((r) => chrome.storage.sync.get("pptApiKey", (res) => r(res || {})));
  if (pptApiKey) {
    setPptConnected();
    pptKeyEl.value = pptApiKey;
  } else {
    setPptDisconnected();
    pptKeyEl.value = "";
  }
}

function showTest(text, kind = "info") {
  pptTest.textContent = text;
  pptTest.className = "test-result " + kind;
}

async function probePpt(apiKey) {
  // Known-good card lookup: Base Set Charizard tcgPlayerId=1319. Smallest-possible probe.
  const url = "https://www.pokemonpricetracker.com/api/v2/cards?tcgPlayerIds=1319";
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "Invalid API key (" + r.status + ")" };
    if (r.status === 429) return { ok: false, reason: "Rate limited (429) — try again shortly" };
    if (!r.ok) return { ok: false, reason: `Request failed (${r.status})` };
    const j = await r.json().catch(() => null);
    const card = Array.isArray(j?.data) ? j.data[0] : j?.data;
    if (!card) return { ok: false, reason: "Response had no card data (unexpected API shape)" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.name === "TimeoutError" ? "Request timed out" : (err?.message || "Network error") };
  }
}

btnSave.addEventListener("click", async () => {
  const key = pptKeyEl.value.trim();
  if (!key) { showTest("Paste a key first.", "err"); return; }
  btnSave.disabled = true;
  showTest("Testing key against PokemonPriceTracker…", "info");
  const result = await probePpt(key);
  btnSave.disabled = false;
  if (!result.ok) { showTest("Test failed: " + result.reason, "err"); return; }
  await new Promise((r) => chrome.storage.sync.set({ pptApiKey: key }, r));
  showTest("Key verified and saved.", "ok");
  setPptConnected();
});

btnChange.addEventListener("click", () => {
  setPptDisconnected();
  pptKeyEl.value = "";
  pptKeyEl.focus();
});

btnClear.addEventListener("click", async () => {
  await new Promise((r) => chrome.storage.sync.remove("pptApiKey", r));
  setPptDisconnected();
  pptKeyEl.value = "";
  showTest("", "info");
});

/* ─── Backend probe ─── */

async function probeBackend() {
  try {
    const r = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { reachable: false };
    const j = await r.json().catch(() => ({}));
    return { reachable: true, hasPriceGrid: !!j?.priceGrid, service: j?.service };
  } catch {
    return { reachable: false };
  }
}

(async () => {
  const b = await probeBackend();
  if (b.reachable && b.hasPriceGrid) {
    backendStatus.textContent = "Connected";
    backendStatus.className = "source-status connected";
    backendDetail.innerHTML = `Dashboard detected at <code>http://127.0.0.1:3000</code> with JustTCG priceGrid enabled. Prices use this source first.`;
    backendDetails.open = true;
  } else if (b.reachable) {
    backendStatus.textContent = "Reachable, no price grid";
    backendStatus.className = "source-status off";
    backendDetail.innerHTML = `Dashboard is running but <code>JUSTTCG_API_KEY</code> is not set in the server's <code>.env</code>. Add the key and restart <code>npm start</code>.`;
    backendDetails.open = true;
  } else {
    backendStatus.textContent = "Not detected";
    backendStatus.className = "source-status off";
    // leave collapsed by default
  }
})();

/* ─── Corrections ─── */

const correctionsCount  = document.getElementById("corrections-count");
const correctionsStatus = document.getElementById("corrections-status");
const btnExportCorrections = document.getElementById("export-corrections");
const btnClearCorrections  = document.getElementById("clear-corrections");

// Disabling the button that was just pressed would drop focus to the page, so the result takes it.
function showCorrectionsStatus(text, kind = "info") {
  correctionsStatus.textContent = text;
  correctionsStatus.className = "test-result " + kind;
  correctionsStatus.focus();
}

async function refreshCorrectionCount() {
  const resp = await chrome.runtime.sendMessage({ action: "countCorrections" }).catch(() => null);
  const known = typeof resp?.count === "number";
  correctionsCount.textContent = known ? `Corrections: ${resp.count} saved` : "Corrections: unavailable";
  btnExportCorrections.disabled = !known || resp.count === 0;
  btnClearCorrections.disabled = !known || resp.count === 0;
  if (!known) showCorrectionsStatus("Couldn't read the saved corrections. Reload this page to try again.", "err");
}

btnExportCorrections.addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ action: "exportCorrections" }).catch(() => null);
  if (!resp?.corrections) { showCorrectionsStatus("Export failed. Try again.", "err"); return; }
  const file = {
    exportedAt: new Date().toISOString(),
    extVersion: chrome.runtime.getManifest().version,
    corrections: resp.corrections,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `card-scanner-corrections-${file.exportedAt.slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showCorrectionsStatus(`Exported ${resp.corrections.length} corrections.`, "ok");
});

btnClearCorrections.addEventListener("click", async () => {
  if (!window.confirm("Delete every saved correction? Export first if you want to keep them.")) return;
  const resp = await chrome.runtime.sendMessage({ action: "clearCorrections" }).catch(() => null);
  if (!resp?.ok) { showCorrectionsStatus("Couldn't clear the corrections. Try again.", "err"); return; }
  await refreshCorrectionCount();
  showCorrectionsStatus("Cleared. 0 corrections saved.", "ok");
});

refreshCorrectionCount();
loadKey();
