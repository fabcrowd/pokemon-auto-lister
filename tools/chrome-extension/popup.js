// LOCAL:  "http://127.0.0.1:7331"
// CLOUD:  replace with your deployed URL, e.g. "https://pokemon-scanner.up.railway.app"
const SERVER            = "http://127.0.0.1:7331";
const SCAN_INTERVAL_MS  = 500;
const HEALTH_INTERVAL_MS = 10_000;

const video       = document.getElementById("video");
const overlay     = document.getElementById("overlay");
const ctx         = overlay.getContext("2d");

// Reused across scan() calls to avoid per-tick allocation
const capCanvas = document.createElement("canvas");
capCanvas.width  = 640;
capCanvas.height = 480;
const capCtx = capCanvas.getContext("2d");
const placeholder = document.getElementById("cam-placeholder");
const camStatus   = document.getElementById("cam-status");
const btnScan     = document.getElementById("btn-scan");
const btnLabel    = document.getElementById("btn-label");
const serverPill  = document.getElementById("server-pill");
const sdot        = document.getElementById("sdot");
const stext       = document.getElementById("stext");
const sDetected   = document.getElementById("s-detected");
const sValue      = document.getElementById("s-value");
const sMs         = document.getElementById("s-ms");
const resultsEl   = document.getElementById("results");
const emptyHint   = document.getElementById("empty-hint");

let scanTimer = null;
let stream    = null;
let isBusy    = false;

/* ─── Camera ─────────────────────────────────────────────────────────── */

async function startCamera() {
  camStatus.textContent = "Starting camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "environment" },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise((res) => { video.onloadedmetadata = res; });
    await video.play();
    placeholder.style.display = "none";
  } catch (err) {
    camStatus.textContent = "Camera error: " + err.message;
  }
}

/* ─── Server health ───────────────────────────────────────────────────── */

async function checkHealth() {
  try {
    const res = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(3000) });
    setServerStatus(res.ok ? "ok" : "err", res.ok ? "server ok" : "server error");
  } catch {
    setServerStatus("err", "offline");
  }
}

function setServerStatus(state, label) {
  serverPill.className = "server-pill " + state;
  sdot.className       = "sdot " + state;
  stext.textContent    = label;
}

/* ─── Scan toggle ─────────────────────────────────────────────────────── */

btnScan.addEventListener("click", () => {
  if (scanTimer) {
    stopScanning();
  } else {
    startScanning();
  }
});

function startScanning() {
  document.body.classList.add("scanning");
  btnScan.classList.add("scanning");
  btnLabel.textContent = "STOP";
  scan();
  scanTimer = setInterval(scan, SCAN_INTERVAL_MS);
}

function stopScanning() {
  clearInterval(scanTimer);
  scanTimer = null;
  isBusy    = false;
  document.body.classList.remove("scanning");
  btnScan.classList.remove("scanning");
  btnLabel.textContent = "SCAN";
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  chrome.runtime.sendMessage({ action: 'relayClear' }).catch(() => {});
}

/* ─── Frame capture & detect ─────────────────────────────────────────── */

async function scan() {
  if (isBusy || video.readyState < 2) return;
  isBusy = true;

  capCtx.drawImage(video, 0, 0, 640, 480);
  const b64 = capCanvas.toDataURL("image/jpeg", 0.85).split(",")[1];

  const t0 = performance.now();
  let data;
  try {
    const res = await fetch(`${SERVER}/detect`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ image_b64: b64 }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) { isBusy = false; return; }
    data = await res.json();
  } catch {
    isBusy = false;
    return;
  }

  const ms    = Math.round(performance.now() - t0);
  const cards = data.cards || [];

  renderOverlay(cards);
  updateStats(cards, ms);
  updateResults(cards);
  isBusy = false;
}

/* ─── Canvas overlay ─────────────────────────────────────────────────── */

const CONF_COLORS = {
  high:    "#10b981",
  medium:  "#f59e0b",
  low:     "#4b5563",
  abstain: "#4b5563",
};

function confTier(confidence) {
  if (confidence >= 0.80) return "high";
  if (confidence >= 0.50) return "medium";
  return "low";
}

function renderOverlay(cards) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  chrome.runtime.sendMessage({
    action: 'relayOverlay', cards,
    srcWidth: overlay.width, srcHeight: overlay.height,
  }).catch(() => {});
  for (const card of cards) {
    if (!card.box || card.box.length < 4) continue;
    const [x1, y1, x2, y2] = card.box;
    const tier  = card.abstain ? "abstain" : confTier(card.confidence);
    const color = CONF_COLORS[tier];
    ctx.save();
    drawCornerBox(x1, y1, x2, y2, color, card.abstain);
    if (card.identity && !card.abstain) {
      drawBadge(x1, y1, card, color);
    }
    ctx.restore();
  }
}

function drawCornerBox(x1, y1, x2, y2, color, dashed) {
  const w   = x2 - x1;
  const h   = y2 - y1;
  const arm = Math.min(w, h) * 0.18;

  ctx.strokeStyle = color;
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur  = dashed ? 0 : 6;
  if (dashed) ctx.setLineDash([5, 4]);

  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x1,y1,1,1],[x2,y1,-1,1],[x2,y2,-1,-1],[x1,y2,1,-1]]) {
    ctx.moveTo(cx + dx * arm, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * arm);
  }
  ctx.stroke();
  // ctx state cleaned up by ctx.restore() in renderOverlay
}

function drawBadge(x1, y1, card, accentColor) {
  const id    = card.identity || {};
  const name  = (id.name || "Unknown").slice(0, 24);
  const price = card.market_price != null
    ? "$" + card.market_price.toFixed(2)
    : null;

  const PAD    = 6;
  const ACCENT = 3;
  const HEIGHT = price ? 38 : 22;

  // Size badge to content so it never clips or wastes space
  ctx.font = "bold 11px -apple-system,BlinkMacSystemFont,sans-serif";
  let contentW = ctx.measureText(name).width;
  if (price) {
    ctx.font = "bold 13px -apple-system,BlinkMacSystemFont,sans-serif";
    contentW = Math.max(contentW, ctx.measureText(price).width);
  }
  const WIDTH = Math.ceil(contentW) + ACCENT + PAD * 2 + 4;

  // Clamp to viewport — keep badge fully on-screen left and right
  const bx = Math.max(0, Math.min(x1, overlay.width - WIDTH));
  const by = Math.max(0, y1 - HEIGHT - 4);

  ctx.fillStyle = "rgba(8,9,13,0.88)";
  ctx.beginPath();
  ctx.roundRect(bx, by, WIDTH, HEIGHT, 4);
  ctx.fill();

  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.roundRect(bx, by, ACCENT, HEIGHT, [4, 0, 0, 4]);
  ctx.fill();

  ctx.font      = "bold 11px -apple-system,BlinkMacSystemFont,sans-serif";
  ctx.fillStyle = "#c5cadc";
  ctx.fillText(name, bx + ACCENT + PAD, by + 14);

  if (price) {
    ctx.font      = "bold 13px -apple-system,BlinkMacSystemFont,sans-serif";
    ctx.fillStyle = "#10b981";
    ctx.fillText(price, bx + ACCENT + PAD, by + 30);
  }
}

/* ─── Stats ───────────────────────────────────────────────────────────── */

function updateStats(cards, ms) {
  const totalValue = cards.reduce((sum, c) => sum + (c.market_price || 0), 0);
  sDetected.textContent = cards.length > 0 ? String(cards.length) : "—";
  sValue.textContent    = totalValue > 0 ? "$" + totalValue.toFixed(2) : "—";
  sMs.textContent       = String(ms);
}

/* ─── Results panel ───────────────────────────────────────────────────── */

function updateResults(cards) {
  if (cards.length === 0) {
    resultsEl.innerHTML = "";
    resultsEl.appendChild(emptyHint);
    return;
  }

  emptyHint.remove();

  const scrollTop = resultsEl.scrollTop;
  resultsEl.innerHTML = cards.map((card) => {
    const id   = card.identity || {};
    const name = id.name    || "Unknown card";
    const code = id.setCode || "";
    const set  = id.set     || "";
    const num  = id.number  || "";
    const tier = card.abstain ? "abstain" : confTier(card.confidence);

    const setHtml = code
      ? `<span class="set-chip">${escHtml(code)}</span>`
      : "";
    const sub = [set, num ? `#${num}` : ""].filter(Boolean).join(" · ");

    const priceHtml = card.market_price != null
      ? `<div class="price-main">$${card.market_price.toFixed(2)}</div>
         <div class="price-type">${escHtml(card.price_variant || "market")}</div>`
      : `<div class="no-price">—</div>`;

    return `<div class="card-row">
      <div class="conf-stripe ${tier}"></div>
      <div class="card-meta">
        <div class="card-name">${escHtml(name)}</div>
        <div class="card-sub">${setHtml}${escHtml(sub)}</div>
      </div>
      <div class="card-price">${priceHtml}</div>
    </div>`;
  }).join("");
  resultsEl.scrollTop = scrollTop;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ─── Init ────────────────────────────────────────────────────────────── */

(async () => {
  await startCamera();
  await checkHealth();
  setInterval(checkHealth, HEALTH_INTERVAL_MS);
})();
