/**
 * Verifies the tab-open fix: clicking the extension action should open popup.html
 * as a full tab, and getUserMedia should resolve (not hang) there.
 */
import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const EXT_PATH = resolve(__dirname, "dist/extension");

(async () => {
  console.log("Loading extension:", EXT_PATH);

  // No fake-camera flags — we want to see the real permission flow
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
    ],
  });

  // Collect all new pages that open
  const newPages = [];
  context.on("page", (p) => newPages.push(p));

  context.on("serviceworker", (sw) => {
    console.log("SW:", sw.url());
    sw.on("console", (m) => console.log(`[SW] ${m.text()}`));
  });

  await new Promise(r => setTimeout(r, 3000));

  const workers = context.serviceWorkers();
  console.log("Service workers:", workers.length);
  if (!workers.length) {
    console.error("No SW — extension didn't load");
    await context.screenshot({ path: "diag-tab-no-sw.png" });
    await context.close(); process.exit(1);
  }

  const extId = workers[0].url().split("/")[2];
  console.log("Extension ID:", extId);

  // Check background.js actually has the onClicked handler by inspecting SW source
  const swPage = workers[0];
  const bgSource = await context.newPage();
  await bgSource.goto(`chrome-extension://${extId}/background.js`);
  const bgText = await bgSource.locator("pre, body").first().innerText().catch(() => "");
  console.log("\n── background.js content ──");
  console.log(bgText.slice(0, 400));
  await bgSource.close();

  // Simulate clicking extension icon by navigating directly to popup.html as a tab
  console.log("\n── Opening popup.html as tab ──");
  const tabPage = await context.newPage();
  const logs = [];
  tabPage.on("console", (m) => {
    logs.push(`[${m.type()}] ${m.text()}`);
    console.log(`[TAB] ${m.text()}`);
  });
  tabPage.on("pageerror", (e) => console.log(`[TAB ERROR] ${e.message}`));

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
    return { readyState: v.readyState, videoWidth: v.videoWidth, srcObject: !!v.srcObject };
  });

  console.log("\n── Results ──────────────────────────────────────────");
  console.log("cam-status      :", camStatus);
  console.log("permission state:", permState);
  console.log("video state     :", JSON.stringify(videoState));

  await tabPage.screenshot({ path: "diag-tab-result.png" });
  console.log("Screenshot      : diag-tab-result.png");

  await new Promise(r => setTimeout(r, 2000));
  await context.close();
})();
