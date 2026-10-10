/**
 * Playwright smoke test — captures SW console errors and popup state.
 * Usage: node test-extension.js
 */

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const EXT_PATH = resolve(__dirname, "dist/extension-wasm");

(async () => {
  console.log("Launching Chromium with extension:", EXT_PATH);

  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",   // auto-grant camera without a prompt
      "--use-fake-device-for-media-stream", // use a fake camera so we get real frames
    ],
  });

  // Listen for SW console messages
  context.on("serviceworker", (sw) => {
    console.log("SW registered:", sw.url());
    sw.on("console", (msg) => {
      console.log(`[SW ${msg.type()}]`, msg.text());
    });
    sw.on("pageerror", (err) => console.log("[SW PAGEERROR]", err.message));
  });

  // Wait for SW to register
  await new Promise((r) => setTimeout(r, 4000));

  const workers = context.serviceWorkers();
  console.log("Service workers found:", workers.length);
  workers.forEach((w) => console.log(" -", w.url()));

  if (workers.length === 0) {
    console.error("No service worker registered — extension may have failed to load");
    const extPage = await context.newPage();
    await extPage.goto("chrome://extensions/");
    await new Promise((r) => setTimeout(r, 2000));
    await extPage.screenshot({ path: "test-screenshot-ext-page.png" });
    console.log("Screenshot: test-screenshot-ext-page.png");
    await context.close();
    process.exit(1);
  }

  const sw = workers[0];
  const extId = sw.url().split("/")[2];
  console.log("Extension ID:", extId);

  // Open popup
  const popupUrl = `chrome-extension://${extId}/popup.html`;
  const page = await context.newPage();

  page.on("console", (msg) => {
    console.log(`[POPUP ${msg.type().toUpperCase()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.log("[POPUP PAGEERROR]", err.message));

  await page.goto(popupUrl);
  console.log("Popup opened");

  // Wait up to 15s for pill to change from "checking…"
  await page.waitForFunction(
    () => document.getElementById("mtext")?.textContent !== "checking…",
    { timeout: 15000 }
  ).catch(() => {});

  const pillText = await page.locator("#mtext").innerText().catch(() => "n/a");
  console.log("Pill text:", pillText);

  const overlayDisplay = await page.evaluate(
    () => document.getElementById("setup-overlay")?.style.display ?? "not found"
  );
  console.log("Setup overlay display:", overlayDisplay);

  // ── Download models if needed ──────────────────────────────────────────────
  if (overlayDisplay === "flex") {
    console.log("Clicking Download models button…");
    await page.locator("#btn-setup").click();

    const progressStarted = await page.waitForFunction(
      () => (document.getElementById("setup-status")?.textContent ?? "").startsWith("Downloading"),
      { timeout: 10000 }
    ).then(() => true).catch(() => false);

    const setupStatusText = await page.evaluate(() => document.getElementById("setup-status")?.textContent ?? "");
    const barCount = await page.evaluate(() => document.getElementById("setup-bars")?.children.length ?? 0);
    console.log("Download started:", progressStarted);
    console.log("Setup status:", setupStatusText);
    console.log("Progress bars visible:", barCount);
    await page.screenshot({ path: "test-screenshot-download.png" });
    console.log("Screenshot: test-screenshot-download.png");

    console.log("Waiting for download to complete (up to 5 min)…");
    const downloadDone = await page.waitForFunction(
      () => document.getElementById("mtext")?.textContent === "AI ready",
      { timeout: 300000 }
    ).then(() => true).catch(() => false);

    const finalPill = await page.locator("#mtext").innerText().catch(() => "n/a");
    const finalOverlay = await page.evaluate(() => document.getElementById("setup-overlay")?.style.display ?? "");
    const finalStatus = await page.evaluate(() => document.getElementById("setup-status")?.textContent ?? "");
    console.log("Download succeeded:", downloadDone);
    console.log("Final pill:", finalPill);
    console.log("Final overlay display:", finalOverlay);
    console.log("Final status text:", finalStatus);
    await page.screenshot({ path: "test-screenshot-after-download.png" });
    console.log("Screenshot: test-screenshot-after-download.png");
  }

  // ── Camera checks ──────────────────────────────────────────────────────────
  console.log("\n── Camera checks ──");

  // Wait up to 5s for camera to start (getUserMedia is async)
  await new Promise((r) => setTimeout(r, 5000));

  const camStatus = await page.evaluate(() => document.getElementById("cam-status")?.textContent ?? "n/a");
  const placeholderVisible = await page.evaluate(() => {
    const el = document.getElementById("cam-placeholder");
    if (!el) return "not found";
    const style = window.getComputedStyle(el);
    return style.display !== "none" ? "visible" : "hidden";
  });
  const videoState = await page.evaluate(() => {
    const v = document.getElementById("video");
    if (!v) return "not found";
    return {
      readyState: v.readyState,        // 4 = HAVE_ENOUGH_DATA (stream flowing)
      paused: v.paused,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      srcObject: v.srcObject ? "set" : "null",
    };
  });
  const camPermission = await page.evaluate(async () => {
    try {
      const result = await navigator.permissions.query({ name: "camera" });
      return result.state; // "granted" | "denied" | "prompt"
    } catch (e) {
      return "query-error: " + e.message;
    }
  });

  console.log("cam-status text:", camStatus);
  console.log("cam-placeholder:", placeholderVisible);
  console.log("video element state:", JSON.stringify(videoState));
  console.log("camera permission query:", camPermission);

  await page.screenshot({ path: "test-screenshot-camera.png" });
  console.log("Screenshot: test-screenshot-camera.png");

  await new Promise((r) => setTimeout(r, 2000));
  await context.close();
})();
