// End-to-end smoke test for dist/extension-wasm.

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = resolve(__dirname, "dist/extension-wasm");
const PROFILE   = resolve(__dirname, ".tmp/ship-profile");

mkdirSync(PROFILE, { recursive: true });

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

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
  // Hook any SW already registered on launch
  for (const sw of context.serviceWorkers()) hookSw(sw);

  await new Promise((r) => setTimeout(r, 3000));

  // Last-attempt lookup — persistent profile might lazy-start SW on first use
  if (!context.serviceWorkers().length) {
    const probe = await context.newPage();
    await probe.goto("chrome://extensions/");
    await new Promise((r) => setTimeout(r, 2000));
    for (const sw of context.serviceWorkers()) hookSw(sw);
    await probe.close();
  }

  const workers = context.serviceWorkers();
  if (!workers.length) {
    log("FAIL: no service worker");
    await context.close();
    process.exit(1);
  }
  const extId = workers[0].url().split("/")[2];
  log("extId:", extId);

  const page = await context.newPage();
  page.on("console", (m) => log("[POPUP]", m.type(), m.text()));
  page.on("pageerror", (e) => log("[POPUP ERROR]", e.message));
  await page.goto(`chrome-extension://${extId}/popup.html`);

  await page.waitForFunction(
    () => document.getElementById("mtext")?.textContent !== "checking…",
    { timeout: 15000 },
  ).catch(() => {});

  const pill0 = await page.locator("#mtext").innerText().catch(() => "n/a");
  const overlay0 = await page.evaluate(
    () => document.getElementById("setup-overlay")?.style.display,
  );
  log("pill:", pill0, "/ overlay:", overlay0);

  if (overlay0 === "flex") {
    log("models not cached — clicking download");
    await page.locator("#btn-setup").click();
    const ok = await page.waitForFunction(
      () => document.getElementById("mtext")?.textContent === "AI ready",
      { timeout: DOWNLOAD_TIMEOUT_MS },
    ).then(() => true).catch(() => false);
    if (!ok) {
      const status = await page.locator("#setup-status").innerText().catch(() => "");
      log("FAIL: download did not complete. status:", status);
      await page.screenshot({ path: "ship-fail-download.png" });
      await context.close();
      process.exit(1);
    }
    log("models downloaded + loaded OK");
  }

  await new Promise((r) => setTimeout(r, 3000));

  const videoState = await page.evaluate(() => {
    const v = document.getElementById("video");
    return v ? {
      readyState: v.readyState,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      paused: v.paused,
      srcObject: !!v.srcObject,
    } : null;
  });
  log("video:", JSON.stringify(videoState));

  // Hook into the extension's detect message so we see error details
  await page.evaluate(() => {
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async function (msg) {
      const result = await origSend(msg);
      if (msg?.action === "detect") {
        // eslint-disable-next-line no-console
        console.log("[detect-result]", JSON.stringify({
          hasError: !!result?.error,
          error: result?.error,
          cardCount: result?.cards?.length,
          srcWidth: result?.srcWidth,
          srcHeight: result?.srcHeight,
        }));
      }
      return result;
    };
  });

  log("clicking SCAN");
  await page.locator("#btn-scan").click();

  // Wait 20 seconds — first scan can take a while while ORT warms up
  await new Promise((r) => setTimeout(r, 20000));

  const ms       = await page.locator("#s-ms").innerText();
  const detected = await page.locator("#s-detected").innerText();
  const total    = await page.locator("#s-value").innerText();
  log("after 20s — ms:", ms, "detected:", detected, "value:", total);

  await page.screenshot({ path: "ship-after-scan.png" });

  await page.locator("#btn-scan").click();
  await new Promise((r) => setTimeout(r, 1000));

  await context.close();
  log("done");
})();
