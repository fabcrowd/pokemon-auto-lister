import { clearPptKey, getPptKey, savePptKey } from "./lib/ppt-key.js";
import { hasAllSites, releaseAllSites, requestAllSites, watchAllSites } from "./lib/site-access.js";
// dev-only:start
import { LIMITS, describeSize } from "./lib/test-photos.js";
// dev-only:end

const pptCard   = document.getElementById("ppt-card");
const pptStatus = document.getElementById("ppt-status");
const pptBodyNotConnected = document.getElementById("ppt-body-not-connected");
const pptBodyConnected    = document.getElementById("ppt-body-connected");
const pptKeyEl  = document.getElementById("ppt-key");
const pptTest   = document.getElementById("ppt-test");
const btnSave   = document.getElementById("save-ppt");
const btnChange = document.getElementById("change-ppt");
const btnClear  = document.getElementById("clear-ppt");

// dev-only:start
const backendDetails = document.getElementById("advanced-backend");
const backendStatus  = document.getElementById("backend-status");
const backendDetail  = document.getElementById("backend-detail");
// dev-only:end

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
  const pptApiKey = await getPptKey();
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
  await savePptKey(key);
  showTest("Key verified and saved.", "ok");
  setPptConnected();
});

btnChange.addEventListener("click", () => {
  setPptDisconnected();
  pptKeyEl.value = "";
  pptKeyEl.focus();
});

btnClear.addEventListener("click", async () => {
  await clearPptKey();
  setPptDisconnected();
  pptKeyEl.value = "";
  showTest("", "info");
});

/* ─── Site access ─── */

const siteToggle = document.getElementById("site-access");
const siteStatus = document.getElementById("site-access-status");
const siteNote   = document.getElementById("site-access-note");

function showSiteAccess(on) {
  siteToggle.checked = on;
  siteStatus.textContent = on ? "On" : "Off";
  siteStatus.className = "source-status " + (on ? "connected" : "off");
}

siteToggle.addEventListener("change", async () => {
  // The browser accepts the permission prompt only when it is asked for straight from the click.
  if (siteToggle.checked) {
    const granted = await requestAllSites(chrome.permissions);
    siteNote.textContent = granted ? "Scans will read full-size photos." : "Access was not given. Scans use a screenshot of the page.";
  } else {
    const removed = await releaseAllSites(chrome.permissions);
    siteNote.textContent = removed
      ? "Scans use a screenshot of the page."
      : "Chrome would not remove it here. You can remove it in chrome://extensions under Details, Site access.";
  }
  showSiteAccess(await hasAllSites(chrome.permissions));
});

hasAllSites(chrome.permissions).then(showSiteAccess);
watchAllSites(chrome.permissions, showSiteAccess);

// dev-only:start
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
// dev-only:end

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

// The first export of corrections that have no fingerprint yet loads the models and embeds them, which takes a while.
function onExportProgress(msg) {
  if (msg.action !== "exportProgress") return;
  showCorrectionsStatus(
    msg.phase === "models" ? "Loading the card models…" : `Preparing the export: ${msg.done} of ${msg.total}…`,
    "info",
  );
}

btnExportCorrections.addEventListener("click", async () => {
  btnExportCorrections.disabled = true;
  chrome.runtime.onMessage.addListener(onExportProgress);
  const resp = await chrome.runtime.sendMessage({ action: "exportCorrections" }).catch(() => null);
  chrome.runtime.onMessage.removeListener(onExportProgress);
  btnExportCorrections.disabled = false;
  if (!resp?.corrections) { showCorrectionsStatus(resp?.error || "Export failed. Try again.", "err"); return; }
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
  showCorrectionsStatus(
    `Exported ${resp.corrections.length} corrections.` + (resp.failed ? ` ${resp.failed} had no usable picture and were exported without a fingerprint.` : ""),
    resp.failed ? "err" : "ok",
  );
});

btnClearCorrections.addEventListener("click", async () => {
  if (!window.confirm("Delete every saved correction? Export first if you want to keep them.")) return;
  const resp = await chrome.runtime.sendMessage({ action: "clearCorrections" }).catch(() => null);
  if (!resp?.ok) { showCorrectionsStatus("Couldn't clear the corrections. Try again.", "err"); return; }
  await refreshCorrectionCount();
  await refreshReferenceCount();
  showCorrectionsStatus("Cleared. 0 corrections saved.", "ok");
});

const referencesToggle = document.getElementById("use-references");
const referencesCount  = document.getElementById("references-count");

async function refreshReferenceCount() {
  const resp = await chrome.runtime.sendMessage({ action: "countReferences" }).catch(() => null);
  referencesCount.textContent = typeof resp?.count === "number" ? `${resp.count} references` : "References: unavailable";
}

async function loadReferencesToggle() {
  const { useReferences } = await chrome.storage.local.get("useReferences").catch(() => ({}));
  referencesToggle.checked = useReferences === true;
}

referencesToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ useReferences: referencesToggle.checked }).catch(() => {});
  if (referencesToggle.checked) {
    await chrome.runtime.sendMessage({ action: "startReferences" }).catch(() => null);
    setTimeout(refreshReferenceCount, 3000);
  }
  showCorrectionsStatus(referencesToggle.checked ? "Scans will now look for cards you corrected before." : "Scans use the catalog only.", "ok");
});

/* ─── Shared learning (opt-in) ─── */

const shareToggle = document.getElementById("share-optin");
const shareStatus = document.getElementById("share-status");

const shareIdRow = document.getElementById("share-id-row");
const shareIdCopy = document.getElementById("share-id-copy");

function showShareId(installId) {
  shareIdRow.hidden = !installId;
  document.getElementById("share-id").textContent = installId || "";
}

shareIdCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("share-id").textContent);
    shareIdCopy.textContent = "Copied";
  } catch {
    shareIdCopy.textContent = "Copy failed";
  }
  setTimeout(() => { shareIdCopy.textContent = "Copy"; }, 2000);
});

function showShareStatus(text, kind = "info") {
  shareStatus.textContent = text;
  shareStatus.className = `test-result ${kind}`;
}

async function loadShareToggle() {
  const status = await chrome.runtime.sendMessage({ action: "shareStatus" }).catch(() => null);
  if (!status || status.error) {
    shareToggle.disabled = true;
    showShareStatus("Couldn't read this setting. Reload the page.", "err");
    return;
  }
  shareToggle.checked = status.enabled === true;
  showShareId(status.installId);
  if (!status.available) {
    shareToggle.disabled = true;
    showShareStatus("Not available in this build");
  }
}

shareToggle.addEventListener("change", async () => {
  const wanted = shareToggle.checked;
  const status = await chrome.runtime.sendMessage({ action: "setSharing", enabled: wanted }).catch(() => null);
  if (!status || status.error) {
    shareToggle.checked = !wanted;
    showShareStatus("Couldn't change this setting. Try again.", "err");
    return;
  }
  shareToggle.checked = status.enabled === true;
  showShareId(status.installId);
  showShareStatus(status.enabled ? "On. Thank you." : "Off. Your install id and anything waiting to be sent were deleted.", "ok");
});

/* ─── Look-alike matches ─── */

const lookalikeToggle = document.getElementById("reduce-lookalikes");
const lookalikeNote   = document.getElementById("lookalike-note");

async function loadLookalikeToggle() {
  const { reduceLookalikes } = await chrome.storage.local.get("reduceLookalikes").catch(() => ({}));
  lookalikeToggle.checked = reduceLookalikes === true;
  // The list of look-alikes is built for one catalog and ships with the extension; a build without it has nothing to apply.
  const present = await fetch(chrome.runtime.getURL("data/hub-penalty.bin")).then((res) => res.ok).catch(() => false);
  if (!present) {
    lookalikeToggle.disabled = true;
    lookalikeNote.textContent = "This build does not include the look-alike list, so the setting has no effect.";
    lookalikeNote.className = "test-result info";
  }
}

lookalikeToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ reduceLookalikes: lookalikeToggle.checked }).catch(() => {});
  lookalikeNote.textContent = lookalikeToggle.checked ? "Scans will steer away from look-alike cards." : "Scans match on picture similarity alone.";
  lookalikeNote.className = "test-result ok";
});

// dev-only:start
/* ─── Test photos ─── */

const testToggle = document.getElementById("test-collection");
const testCount  = document.getElementById("test-photos-count");
const testStatus = document.getElementById("test-photos-status");
const testLimit  = document.getElementById("test-photos-limit");
const btnExportPhotos = document.getElementById("export-test-photos");
const btnClearPhotos  = document.getElementById("clear-test-photos");
const EXPORT_CHUNK = 10;

function showTestStatus(text, kind = "info") {
  testStatus.textContent = text;
  testStatus.className = "test-result " + kind;
  testStatus.focus();
}

async function refreshPhotoCount() {
  const resp = await chrome.runtime.sendMessage({ action: "countTestPhotos" }).catch(() => null);
  const known = typeof resp?.count === "number";
  testCount.textContent = known ? `Test photos: ${resp.count} saved (about ${describeSize(resp.bytes || 0)})` : "Test photos: unavailable";
  testLimit.hidden = !(known && resp.limitReached);
  testLimit.textContent = `Collection has stopped: it keeps at most ${LIMITS.photos} photos or ${describeSize(LIMITS.bytes)}. Export them, then clear, to collect more.`;
  btnExportPhotos.disabled = !known || resp.count === 0;
  btnClearPhotos.disabled = !known || resp.count === 0;
  if (!known) showTestStatus("Couldn't read the saved test photos. Reload this page to try again.", "err");
}

async function loadCollectionToggle() {
  const { testSetCollection } = await chrome.storage.local.get("testSetCollection").catch(() => ({}));
  testToggle.checked = testSetCollection === true;
}

testToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ testSetCollection: testToggle.checked }).catch(() => {});
  showTestStatus(testToggle.checked ? "Collecting. Each page scan now keeps its photos." : "Collection is off.", "ok");
});

btnExportPhotos.addEventListener("click", async () => {
  const listed = await chrome.runtime.sendMessage({ action: "testPhotoIds" }).catch(() => null);
  if (!Array.isArray(listed?.ids)) { showTestStatus("Export failed. Try again.", "err"); return; }
  // One message per chunk keeps each under the extension message size limit.
  const parts = [`{"exportedAt":${JSON.stringify(new Date().toISOString())},"extVersion":${JSON.stringify(chrome.runtime.getManifest().version)},"photos":[`];
  let exported = 0;
  for (let at = 0; at < listed.ids.length; at += EXPORT_CHUNK) {
    const chunk = await chrome.runtime.sendMessage({ action: "getTestPhotos", ids: listed.ids.slice(at, at + EXPORT_CHUNK) }).catch(() => null);
    if (!Array.isArray(chunk?.photos)) { showTestStatus("Export failed part way. Try again.", "err"); return; }
    for (const photo of chunk.photos) {
      parts.push((exported ? "," : "") + JSON.stringify(photo));
      exported += 1;
    }
  }
  parts.push("]}");
  const url = URL.createObjectURL(new Blob(parts, { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `card-scanner-test-photos-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showTestStatus(`Exported ${exported} test photos.`, "ok");
});

btnClearPhotos.addEventListener("click", async () => {
  if (!window.confirm("Delete every saved test photo? Export first if you want to keep them.")) return;
  const resp = await chrome.runtime.sendMessage({ action: "clearTestPhotos" }).catch(() => null);
  if (!resp?.ok) { showTestStatus("Couldn't clear the test photos. Try again.", "err"); return; }
  await refreshPhotoCount();
  showTestStatus("Cleared. 0 test photos saved.", "ok");
});

// dev-only:end

refreshCorrectionCount();
refreshReferenceCount();
loadReferencesToggle();
loadLookalikeToggle();
loadShareToggle();
// dev-only:start
refreshPhotoCount();
loadCollectionToggle();
// dev-only:end
loadKey();
