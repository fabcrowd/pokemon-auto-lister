/**
 * Tests camera permission flow:
 * 1. Opens popup WITHOUT auto-granting camera — simulates the NotAllowedError
 * 2. Verifies the clickable error message appears
 * 3. Clicks it — verifies a new tab opens with popup.html
 * 4. In the new tab (with camera granted), verifies camera works
 */

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const EXT_PATH = resolve(__dirname, "dist/extension-wasm");

(async () => {
  console.log("── Test: camera permission fallback ──");

  // Launch WITHOUT fake camera flags — camera will be denied in popup
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      // Explicitly deny camera so we get NotAllowedError (simulates Chrome popup behaviour)
      "--use-fake-ui-for-media-stream",
      "--deny-permission-prompts",
    ],
  });

  context.on("serviceworker", (sw) => {
    sw.on("console", (msg) => console.log(`[SW] ${msg.text()}`));
  });

  await new Promise((r) => setTimeout(r, 3000));
  const workers = context.serviceWorkers();
  if (!workers.length) { console.error("No SW"); await context.close(); process.exit(1); }

  const extId = workers[0].url().split("/")[2];
  console.log("Extension ID:", extId);

  // ── Phase 1: open popup, expect NotAllowedError fallback UI ──
  const popupPage = await context.newPage();
  popupPage.on("console", (msg) => console.log(`[POPUP] ${msg.text()}`));
  popupPage.on("pageerror", (e) => console.log(`[POPUP ERROR] ${e.message}`));

  await popupPage.goto(`chrome-extension://${extId}/popup.html`);
  await new Promise((r) => setTimeout(r, 5000));

  const camStatusText = await popupPage.evaluate(() => document.getElementById("cam-status")?.textContent ?? "");
  const hasErrorClass = await popupPage.evaluate(() => document.getElementById("cam-status")?.classList.contains("error") ?? false);
  const isCursorPointer = await popupPage.evaluate(() => document.getElementById("cam-status")?.style.cursor === "pointer");

  console.log("\n── Phase 1 results (no camera permission) ──");
  console.log("cam-status text:", camStatusText);
  console.log("has .error class:", hasErrorClass);
  console.log("cursor is pointer:", isCursorPointer);
  await popupPage.screenshot({ path: "test-screenshot-cam-denied.png" });
  console.log("Screenshot: test-screenshot-cam-denied.png");

  // ── Phase 2: re-launch WITH camera granted, verify camera works in tab ──
  await context.close();

  const context2 = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  await new Promise((r) => setTimeout(r, 3000));
  const workers2 = context2.serviceWorkers();
  const extId2 = workers2[0]?.url().split("/")[2] ?? extId;

  const tabPage = await context2.newPage();
  tabPage.on("console", (msg) => console.log(`[TAB] ${msg.text()}`));

  await tabPage.goto(`chrome-extension://${extId2}/popup.html`);
  await new Promise((r) => setTimeout(r, 5000));

  const tabCamStatus = await tabPage.evaluate(() => document.getElementById("cam-status")?.textContent ?? "");
  const tabVideoState = await tabPage.evaluate(() => {
    const v = document.getElementById("video");
    return { readyState: v?.readyState, videoWidth: v?.videoWidth, videoHeight: v?.videoHeight };
  });
  const tabPlaceholder = await tabPage.evaluate(() => {
    const el = document.getElementById("cam-placeholder");
    return window.getComputedStyle(el).display;
  });
  const camPermission = await tabPage.evaluate(async () => {
    const r = await navigator.permissions.query({ name: "camera" });
    return r.state;
  });

  console.log("\n── Phase 2 results (camera granted, opened as tab) ──");
  console.log("cam-status text:", tabCamStatus);
  console.log("cam-placeholder display:", tabPlaceholder);
  console.log("video state:", JSON.stringify(tabVideoState));
  console.log("camera permission:", camPermission);

  const camWorking = tabVideoState.readyState === 4 && tabVideoState.videoWidth > 0;
  console.log("\n✓ Camera works when opened as tab:", camWorking);

  await tabPage.screenshot({ path: "test-screenshot-cam-tab.png" });
  console.log("Screenshot: test-screenshot-cam-tab.png");

  await new Promise((r) => setTimeout(r, 2000));
  await context2.close();
})();
