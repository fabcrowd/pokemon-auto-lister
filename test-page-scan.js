// Verifies the final shipping flow:
// 1. Load extension in Chromium
// 2. Open a local HTML page with 6 real Pokémon card images
// 3. Trigger the extension's "scanPage" action
// 4. Wait for overlay (__card-scanner-overlay__) to render boxes/price badges
// 5. Screenshot the page as proof

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { createServer } from "http";
import { readFileSync, statSync } from "fs";
import { extname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = resolve(__dirname, "dist/extension-wasm");
const PROFILE   = resolve(__dirname, ".tmp/ship-profile");
const PAGE_DIR  = resolve(__dirname, ".tmp/testpage");
const PORT      = 7788;

mkdirSync(PROFILE, { recursive: true });

const log = (...a) => console.log("[test]", ...a);

// Static file server for the test page (file:// has quirks with extensions).
function startServer() {
  const server = createServer((req, res) => {
    try {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      const full = join(PAGE_DIR, p);
      if (!full.startsWith(PAGE_DIR)) { res.writeHead(403).end(); return; }
      const body = readFileSync(full);
      const ext = extname(full).toLowerCase();
      const types = {
        ".html": "text/html", ".webp": "image/webp",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".css": "text/css", ".js": "application/javascript",
      };
      res.writeHead(200, { "content-type": types[ext] || "application/octet-stream", "content-length": body.length });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((r) => server.listen(PORT, "127.0.0.1", () => r(server)));
}

(async () => {
  log("ext:", EXT_PATH);
  log("page dir:", PAGE_DIR);

  const server = await startServer();
  log(`http://127.0.0.1:${PORT}/ serving ${PAGE_DIR}`);

  // Taller viewport so all 6 cards sit above the fold.
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1400, height: 1200 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--window-size=1400,1280",
    ],
  });

  const hookSw = (sw) => {
    log("SW:", sw.url());
    sw.on("console", (m) => log("[SW]", m.type(), m.text()));
    sw.on("pageerror", (e) => log("[SW ERROR]", e.message));
  };
  context.on("serviceworker", hookSw);
  for (const sw of context.serviceWorkers()) hookSw(sw);

  // Open the card page FIRST so it's the active content tab when we trigger the action.
  const page = await context.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (!t.startsWith("WebSocket is already in CLOSING")) log("[PAGE]", m.type(), t);
  });
  page.on("pageerror", (e) => log("[PAGE ERROR]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);

  // Close the default blank tab (if any) so our card page is the sole normal tab.
  for (const p of context.pages()) {
    if (p !== page && p.url() === "about:blank") await p.close().catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 2500));
  if (!context.serviceWorkers().length) {
    const probe = await context.newPage();
    await probe.goto("chrome://extensions/");
    await new Promise((r) => setTimeout(r, 1500));
    for (const sw of context.serviceWorkers()) hookSw(sw);
    await probe.close();
  }

  const workers = context.serviceWorkers();
  if (!workers.length) { log("FAIL: no SW"); await context.close(); server.close(); process.exit(1); }
  const sw = workers[0];
  const extId = sw.url().split("/")[2];
  log("extId:", extId);

  // Wake the SW via an extension page — SW evaluate fails if the worker is idle.
  // Opening popup.html forces onMessage listeners to attach fresh.
  const popupProbe = await context.newPage();
  popupProbe.on("console", (m) => log("[POPUP-PROBE]", m.type(), m.text()));
  popupProbe.on("pageerror", (e) => log("[POPUP-PROBE ERROR]", e.message));
  await popupProbe.goto(`chrome-extension://${extId}/popup.html`);
  await popupProbe.waitForFunction(
    () => document.getElementById("mtext")?.textContent !== "checking…",
    { timeout: 15000 },
  ).catch(() => {});
  const pill = await popupProbe.locator("#mtext").innerText().catch(() => "n/a");
  log("popup pill:", pill);

  // Ensure models are loaded (first run downloads them ~140 MB; cached after).
  log("checking model status via popup page…");
  const ready = await popupProbe.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ action: "checkReady" });
    return !!r?.ready;
  });
  log("models ready:", ready);

  if (!ready) {
    log("clicking Download models in popup (one-time ~140 MB)…");
    await popupProbe.locator("#btn-setup").click();
    const ok = await popupProbe.waitForFunction(
      () => document.getElementById("mtext")?.textContent === "AI ready",
      { timeout: 15 * 60 * 1000 },
    ).then(() => true).catch(() => false);
    if (!ok) {
      log("FAIL: download did not complete");
      await popupProbe.screenshot({ path: "ship-page-fail-download.png" });
      await context.close(); server.close(); process.exit(1);
    }
    log("models downloaded; popup now AI ready");
  }
  // After model download the 2-step wizard advances to the optional PPT upsell.
  // Dismiss it so the test can click SCAN PAGE unobstructed.
  await popupProbe.waitForFunction(
    () => document.getElementById("wiz-step-2")?.classList.contains("active"),
    { timeout: 5000 },
  ).catch(() => {});
  const upsellActive = await popupProbe.evaluate(
    () => document.getElementById("wiz-step-2")?.classList.contains("active"),
  );
  if (upsellActive) {
    log("wizard step 2 shown — clicking 'I'll do this later' to continue");
    await popupProbe.locator("#btn-wiz-skip").click();
    await popupProbe.waitForFunction(
      () => document.getElementById("setup-overlay")?.style.display === "none",
      { timeout: 3000 },
    ).catch(() => {});
  }

  // Bring the card page to the foreground, set it as targetTabId, then run scanPage.
  const tabInfo = await popupProbe.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:7788/*" });
    const t = tabs[0];
    if (!t) return { error: "no card tab" };
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    // Mirror action.onClicked side-effects: set target, inject content.js.
    await chrome.storage.session.set({ targetTabId: t.id });
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
    } catch (e) { /* already injected */ }
    return { tabId: t.id, windowId: t.windowId };
  });
  log("target tab:", JSON.stringify(tabInfo));

  // Click the real "SCAN PAGE" button in the popup — mirrors the actual user flow.
  log("clicking SCAN PAGE in popup…");
  await popupProbe.locator("#btn-scan").click();
  // Capture scan result when the popup shows a final message
  await popupProbe.waitForFunction(
    () => {
      const msg = document.getElementById("msg-bar")?.textContent || "";
      return msg.includes("Found") || msg.includes("No Pokémon");
    },
    { timeout: 60000 },
  ).catch(() => {});
  // Pull the stats + results list from the popup DOM for the log output
  const scanRes = await popupProbe.evaluate(() => {
    const stats = {
      detected: document.getElementById("s-detected")?.textContent,
      value:    document.getElementById("s-value")?.textContent,
      ms:       document.getElementById("s-ms")?.textContent,
    };
    const rows = Array.from(document.querySelectorAll(".card-row")).map((r) => ({
      name:  r.querySelector(".card-name")?.textContent,
      sub:   r.querySelector(".card-sub")?.textContent,
      price: r.querySelector(".price-main")?.textContent,
    }));
    return { stats, rows, msg: document.getElementById("msg-bar")?.textContent };
  });
  log("popup msg:", scanRes?.msg);
  log("stats:", JSON.stringify(scanRes?.stats));
  for (const r of scanRes?.rows || []) {
    log("  row:", JSON.stringify(r));
  }

  // Wait for the content script to render the overlay
  await page.waitForFunction(
    () => document.getElementById("__card-scanner-overlay__") != null,
    { timeout: 10000 },
  ).catch(() => log("overlay canvas never appeared"));

  await new Promise((r) => setTimeout(r, 1500));

  const overlayInfo = await page.evaluate(() => {
    const c = document.getElementById("__card-scanner-overlay__");
    if (!c) return { exists: false };
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonTransparent = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonTransparent++;
    // Find overlay bounding box of drawn pixels
    let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const a = data[(y * c.width + x) * 4 + 3];
        if (a > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      exists: true,
      width: c.width,
      height: c.height,
      nonTransparentPixels: nonTransparent,
      pctCovered: ((nonTransparent / (c.width * c.height)) * 100).toFixed(3),
      bbox: { minX, minY, maxX, maxY },
      z: window.getComputedStyle(c).zIndex,
      position: window.getComputedStyle(c).position,
    };
  });
  log("overlay canvas:", JSON.stringify(overlayInfo));

  // Full-page screenshot — captures beyond the viewport
  await page.screenshot({ path: "ship-page-scan.png", fullPage: true });
  log("screenshot saved: ship-page-scan.png (fullPage)");

  // Viewport-only screenshot of just the page tab — proves the overlay sits on the page.
  await page.screenshot({ path: "ship-page-viewport.png", fullPage: false });
  log("screenshot saved: ship-page-viewport.png (viewport)");

  // Also save just the canvas as its own image for close inspection
  const canvasPng = await page.evaluate(() => {
    const c = document.getElementById("__card-scanner-overlay__");
    return c ? c.toDataURL("image/png") : null;
  });
  if (canvasPng) {
    const data = Buffer.from(canvasPng.split(",")[1], "base64");
    const { writeFileSync } = await import("fs");
    writeFileSync("ship-overlay-canvas.png", data);
    log("overlay canvas dump: ship-overlay-canvas.png (" + data.length + " bytes)");
  }

  // Also screenshot the popup window if one exists (for completeness)
  const popup = context.pages().find((p) => p.url().startsWith(`chrome-extension://${extId}/popup.html`));
  if (popup) {
    await popup.screenshot({ path: "ship-popup.png" });
    log("popup screenshot saved: ship-popup.png");
  }

  await new Promise((r) => setTimeout(r, 2000));
  await context.close();
  server.close();
  log("done");
})();
