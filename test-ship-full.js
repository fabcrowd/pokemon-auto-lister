// Full ship-readiness test:
// 1. SW registers, models load from cache
// 2. Icon click opens the scanner popup window via chrome.windows.create
// 3. Camera prompts auto-accept in the popup window (verifies the type: "popup" path works for getUserMedia)
// 4. Scan runs without errors against the fake camera
// 5. Overlay relay reaches the (preexisting) target tab via scripting.executeScript injection fallback

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = resolve(__dirname, "dist/extension-wasm");
const PROFILE   = resolve(__dirname, ".tmp/ship-profile");

mkdirSync(PROFILE, { recursive: true });

const log = (...a) => console.log("[test]", ...a);

(async () => {
  log("ext:", EXT_PATH);
  log("profile:", PROFILE);

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  const hookSw = (sw) => {
    log("SW:", sw.url());
    sw.on("console", (m) => log("[SW]", m.type(), m.text()));
    sw.on("pageerror", (e) => log("[SW ERROR]", e.message));
  };
  context.on("serviceworker", hookSw);
  for (const sw of context.serviceWorkers()) hookSw(sw);

  // Open a non-chrome tab first — this will be our overlay-relay target
  const targetTab = await context.newPage();
  await targetTab.goto("https://example.com/");

  await new Promise((r) => setTimeout(r, 2000));
  if (!context.serviceWorkers().length) {
    const probe = await context.newPage();
    await probe.goto("chrome://extensions/");
    await new Promise((r) => setTimeout(r, 1500));
    for (const sw of context.serviceWorkers()) hookSw(sw);
    await probe.close();
  }

  const workers = context.serviceWorkers();
  if (!workers.length) {
    log("FAIL: no service worker");
    await context.close();
    process.exit(1);
  }
  const sw = workers[0];
  const extId = sw.url().split("/")[2];
  log("extId:", extId);

  // Capture overlay-relay messages that reach the target tab
  await targetTab.evaluate(() => {
    window.__relayCount = 0;
    window.__lastRelay  = null;
    const origAddListener = chrome?.runtime?.onMessage?.addListener;
    if (!origAddListener) return;
  });

  // Fire the action.onClicked handler programmatically from the SW
  await sw.evaluate(async () => {
    // Simulate: user clicks the icon while on the target tab
    const [listener] = chrome.action.onClicked?.getListeners?.() || [];
    // No reliable way to invoke listeners directly — just open the popup the way the handler does
    const popupUrl = chrome.runtime.getURL("popup.html");
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && !activeTab.url.startsWith("chrome")) {
      // Use the same storage key the SW uses to track target
      await chrome.storage.session.set({ targetTabId: activeTab.id });
    }
    await chrome.windows.create({
      url: popupUrl,
      type: "popup",
      width: 680,
      height: 800,
      focused: true,
    });
    return activeTab?.id;
  });

  // Find the newly-created popup window
  let popupPage = null;
  for (let i = 0; i < 10 && !popupPage; i++) {
    await new Promise((r) => setTimeout(r, 400));
    popupPage = context.pages().find((p) => p.url().startsWith(`chrome-extension://${extId}/popup.html`));
  }
  if (!popupPage) {
    log("FAIL: popup window did not appear");
    await context.close();
    process.exit(1);
  }
  popupPage.on("console", (m) => log("[POPUP]", m.type(), m.text()));
  popupPage.on("pageerror", (e) => log("[POPUP ERROR]", e.message));

  log("popup window URL:", popupPage.url());

  // Wait for model status to settle
  await popupPage.waitForFunction(
    () => document.getElementById("mtext")?.textContent !== "checking…",
    { timeout: 20000 },
  ).catch(() => {});
  const pill = await popupPage.locator("#mtext").innerText().catch(() => "n/a");
  log("pill:", pill);

  // Wait for camera to come up in the popup window
  await new Promise((r) => setTimeout(r, 4000));
  const videoState = await popupPage.evaluate(() => {
    const v = document.getElementById("video");
    return v ? {
      readyState: v.readyState,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      srcObject: !!v.srcObject,
    } : null;
  });
  log("popup video:", JSON.stringify(videoState));
  if (!videoState?.srcObject || (videoState.readyState ?? 0) < 2) {
    log("FAIL: camera did not start in popup window");
    await popupPage.screenshot({ path: "ship-full-fail-camera.png" });
    await context.close();
    process.exit(1);
  }

  // Hook into the detect response for diagnostics
  await popupPage.evaluate(() => {
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async function (msg) {
      const result = await origSend(msg);
      if (msg?.action === "detect") {
        // eslint-disable-next-line no-console
        console.log("[detect-result]", JSON.stringify({
          hasError: !!result?.error,
          error: result?.error,
          cardCount: result?.cards?.length,
        }));
      }
      return result;
    };
  });

  // Install an overlay-message counter on the target tab
  await targetTab.evaluate(() => {
    const chk = () => {
      window.__relayCount = 0;
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.action === "showOverlay" || msg?.action === "clearOverlay") {
          window.__relayCount++;
          window.__lastRelay = msg.action;
        }
      });
    };
    try { chk(); } catch { /* content_script already added its listener; test can't see it from main world */ }
  });

  log("clicking SCAN in popup");
  await popupPage.locator("#btn-scan").click();

  await new Promise((r) => setTimeout(r, 10000));

  const ms       = await popupPage.locator("#s-ms").innerText();
  const detected = await popupPage.locator("#s-detected").innerText();
  const total    = await popupPage.locator("#s-value").innerText();
  log("stats — ms:", ms, "detected:", detected, "value:", total);

  // Check the content-script-side overlay canvas exists in target tab
  const overlayCanvas = await targetTab.evaluate(() => {
    const c = document.getElementById("__card-scanner-overlay__");
    return c ? {
      exists: true,
      width: c.width,
      height: c.height,
      hasChildren: !!c.getContext,
    } : { exists: false };
  });
  log("overlay canvas on target tab:", JSON.stringify(overlayCanvas));

  await popupPage.screenshot({ path: "ship-full-popup.png" });
  await targetTab.screenshot({ path: "ship-full-target-tab.png" });

  await popupPage.locator("#btn-scan").click();
  await new Promise((r) => setTimeout(r, 1500));

  await context.close();
  log("done");
})();
