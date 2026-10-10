/**
 * Verifies the complete camera fix:
 * - Opens popup.html as a tab (our onClicked fix)
 * - Auto-grants camera permission (--use-fake-ui-for-media-stream)
 * - Provides a fake camera device (--use-fake-device-for-media-stream)
 * - Confirms video starts playing
 */
import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "dist/extension");

(async () => {
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--use-fake-ui-for-media-stream",      // auto-grant camera permission dialog
      "--use-fake-device-for-media-stream",  // provide a synthetic camera stream
      "--no-sandbox",
    ],
  });

  await new Promise(r => setTimeout(r, 2000));

  const workers = context.serviceWorkers();
  if (!workers.length) {
    console.error("Extension failed to load — no service workers");
    await context.close(); process.exit(1);
  }

  const extId = workers[0].url().split("/")[2];
  console.log("Extension ID:", extId);

  // Open popup.html as a tab (mimics what onClicked does)
  const tabPage = await context.newPage();
  const logs = [];
  tabPage.on("console", m => {
    logs.push(m.text());
    console.log(`[TAB] ${m.text()}`);
  });
  tabPage.on("pageerror", e => console.log(`[TAB ERROR] ${e.message}`));

  await tabPage.goto(`chrome-extension://${extId}/popup.html`);
  await new Promise(r => setTimeout(r, 6000));

  const camStatus = await tabPage.evaluate(() =>
    document.getElementById("cam-status")?.textContent ?? "not found"
  );
  const permState = await tabPage.evaluate(async () => {
    try {
      const r = await navigator.permissions.query({ name: "camera" });
      return r.state;
    } catch (e) { return "error: " + e.message; }
  });
  const videoState = await tabPage.evaluate(() => {
    const v = document.getElementById("video");
    if (!v) return null;
    return {
      readyState: v.readyState,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      srcObject: !!v.srcObject,
      paused: v.paused,
    };
  });

  console.log("\n── Camera verification results ──────────────────────────");
  console.log("cam-status      :", camStatus);
  console.log("permission state:", permState);
  console.log("video state     :", JSON.stringify(videoState, null, 2));

  const cameraWorking = videoState?.srcObject && (videoState?.readyState ?? 0) >= 2;
  console.log("\n" + (cameraWorking ? "✓ Camera stream started successfully" : "✗ Camera did not start"));

  await tabPage.screenshot({ path: "verify-camera-fix.png" });
  console.log("Screenshot      : verify-camera-fix.png");

  await new Promise(r => setTimeout(r, 2000));
  await context.close();
})();
