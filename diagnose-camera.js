/**
 * Diagnostic: check camera permission state and errors in dist/extension popup.
 * Usage: node diagnose-camera.js
 */

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const EXT_PATH = resolve(__dirname, "dist/extension");

(async () => {
  console.log("Loading extension from:", EXT_PATH);

  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
    ],
  });

  const errors = [];
  const logs   = [];

  context.on("serviceworker", (sw) => {
    console.log("SW registered:", sw.url());
    sw.on("console", (msg) => console.log(`[SW] ${msg.text()}`));
    sw.on("pageerror", (err) => console.log(`[SW ERROR] ${err.message}`));
  });

  // ── 1. Screenshot extensions dashboard ────────────────────────────────────
  const extPage = await context.newPage();
  await extPage.goto("chrome://extensions/");
  await extPage.waitForTimeout(2000);
  await extPage.screenshot({ path: "diag-screenshot-extensions.png", fullPage: true });
  console.log("Extensions page screenshot: diag-screenshot-extensions.png");

  // ── 2. Wait for SW, get extension ID ──────────────────────────────────────
  await extPage.waitForTimeout(2000);
  const workers = context.serviceWorkers();
  console.log("Service workers:", workers.length);
  if (!workers.length) {
    console.error("No service worker — extension failed to load. Check diag-screenshot-extensions.png");
    await context.close();
    process.exit(1);
  }

  const extId = workers[0].url().split("/")[2];
  console.log("Extension ID:", extId);

  // ── 3. Open popup, collect console output ─────────────────────────────────
  const popupPage = await context.newPage();
  popupPage.on("console", (msg) => {
    const line = `[${msg.type().toUpperCase()}] ${msg.text()}`;
    logs.push(line);
    console.log("[POPUP]", line);
  });
  popupPage.on("pageerror", (err) => {
    errors.push(err.message);
    console.log("[POPUP ERROR]", err.message);
  });

  await popupPage.goto(`chrome-extension://${extId}/popup.html`);
  await popupPage.waitForTimeout(5000);  // wait for getUserMedia to resolve/reject

  // ── 4. Read DOM state ─────────────────────────────────────────────────────
  const camStatusText = await popupPage.evaluate(
    () => document.getElementById("cam-status")?.textContent ?? "element not found"
  );
  const videoState = await popupPage.evaluate(() => {
    const v = document.getElementById("video");
    if (!v) return { error: "video element not found" };
    return {
      readyState:  v.readyState,
      paused:      v.paused,
      videoWidth:  v.videoWidth,
      videoHeight: v.videoHeight,
      srcObject:   v.srcObject ? "set" : "null",
    };
  });
  const permState = await popupPage.evaluate(async () => {
    try {
      const r = await navigator.permissions.query({ name: "camera" });
      return r.state;
    } catch (e) {
      return "query-error: " + e.message;
    }
  });

  const mediaDevicesAvailable = await popupPage.evaluate(() => {
    return {
      exists: !!navigator.mediaDevices,
      getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    };
  });

  console.log("\n── DOM state ──────────────────────────────────────────────────");
  console.log("cam-status text  :", camStatusText);
  console.log("video element    :", JSON.stringify(videoState));
  console.log("camera permission:", permState);
  console.log("mediaDevices API :", JSON.stringify(mediaDevicesAvailable));
  console.log("page errors      :", errors.length ? errors : "none");

  await popupPage.screenshot({ path: "diag-screenshot-popup.png" });
  console.log("\nPopup screenshot: diag-screenshot-popup.png");

  // ── 5. Screenshot chrome://extensions/ with error details visible ─────────
  await extPage.bringToFront();
  await extPage.screenshot({ path: "diag-screenshot-extensions-2.png", fullPage: true });
  console.log("Extensions page (post-load) screenshot: diag-screenshot-extensions-2.png");

  await context.close();
})();
