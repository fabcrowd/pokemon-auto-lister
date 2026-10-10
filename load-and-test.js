/**
 * Connects to the live Chrome on port 9222, enables Developer mode,
 * loads the unpacked extension, then opens popup.html as a tab and checks camera.
 */
import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "dist/extension");

(async () => {
  console.log("Connecting to Chrome on port 9222...");
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const ctx = contexts[0];

  // ── Step 1: Navigate to chrome://extensions ──────────────────────────────
  console.log("\n── Opening chrome://extensions ──");
  const extPage = await ctx.newPage();
  await extPage.goto("chrome://extensions/");
  await new Promise(r => setTimeout(r, 1500));

  // ── Step 2: Enable Developer mode ────────────────────────────────────────
  console.log("Enabling Developer mode...");
  const devModeResult = await extPage.evaluate(() => {
    const manager = document.querySelector("extensions-manager");
    if (!manager?.shadowRoot) return "no manager shadow root";
    const toolbar = manager.shadowRoot.querySelector("extensions-toolbar");
    if (!toolbar?.shadowRoot) return "no toolbar shadow root";
    const toggle = toolbar.shadowRoot.querySelector("#devMode cr-toggle, #devMode, [id='devMode']");
    if (!toggle) return "no devMode toggle found";
    const wasChecked = toggle.checked || toggle.getAttribute("checked") !== null;
    if (!wasChecked) {
      toggle.click();
      return "clicked devMode toggle";
    }
    return "devMode was already on";
  });
  console.log("Dev mode result:", devModeResult);
  await new Promise(r => setTimeout(r, 1500));

  // Take screenshot to see current state
  await extPage.screenshot({ path: "after-devmode.png" });
  console.log("Screenshot: after-devmode.png");

  // ── Step 3: Click "Load unpacked" and handle file chooser ────────────────
  console.log("\nClicking Load unpacked for:", EXT_PATH);

  try {
    const [fileChooser] = await Promise.all([
      extPage.waitForEvent("filechooser", { timeout: 5000 }),
      extPage.evaluate(() => {
        const manager = document.querySelector("extensions-manager");
        const toolbar = manager?.shadowRoot?.querySelector("extensions-toolbar");
        // Try different selectors for the Load Unpacked button
        const btn =
          toolbar?.shadowRoot?.querySelector("#loadUnpacked") ||
          toolbar?.shadowRoot?.querySelector("cr-button[id='loadUnpacked']") ||
          toolbar?.shadowRoot?.querySelector("cr-button");
        if (btn) { btn.click(); return "clicked"; }
        return "button not found";
      }),
    ]);

    await fileChooser.setFiles(EXT_PATH);
    console.log("Extension path submitted to file chooser");
  } catch (err) {
    console.log("File chooser approach failed:", err.message);
    console.log("Developer mode may be blocked by policy.");
    console.log("\nTrying direct navigate to extension URL instead...");
  }

  await new Promise(r => setTimeout(r, 3000));
  await extPage.screenshot({ path: "after-load.png" });
  console.log("Screenshot: after-load.png");

  // ── Step 4: Find the extension service worker ─────────────────────────────
  const workers = ctx.serviceWorkers();
  console.log("\nService workers after load attempt:", workers.length);
  workers.forEach(w => console.log(" -", w.url()));

  if (!workers.length) {
    // Try reading extension info from the extensions page
    const extInfo = await extPage.evaluate(() => {
      const manager = document.querySelector("extensions-manager");
      const shadow = manager?.shadowRoot;
      if (!shadow) return [];
      return Array.from(shadow.querySelectorAll("extensions-item")).map(item => ({
        name: item.shadowRoot?.querySelector("#name")?.textContent?.trim(),
        id: item.getAttribute("id"),
        enabled: item.hasAttribute("enabled"),
        hasError: !!item.shadowRoot?.querySelector(".errors-button"),
      }));
    });
    console.log("\nExtensions visible on page:", JSON.stringify(extInfo, null, 2));
    console.log("\nExtension is NOT loaded — cannot test camera without it.");
    await browser.close();
    return;
  }

  const extId = workers[0].url().split("/")[2];
  console.log("\nExtension ID:", extId);

  // ── Step 5: Read background.js to verify our fix ──────────────────────────
  const bgPage = await ctx.newPage();
  await bgPage.goto(`chrome-extension://${extId}/background.js`);
  const bgText = await bgPage.locator("pre, body").first().innerText().catch(() => "");
  console.log("\n── background.js (first 400 chars) ──");
  console.log(bgText.slice(0, 400));
  await bgPage.close();

  // ── Step 6: Open popup.html as a tab and check camera ────────────────────
  console.log("\n── Opening popup.html as tab ──");
  const tabPage = await ctx.newPage();
  tabPage.on("console", m => console.log(`[TAB] ${m.text()}`));
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
    return { readyState: v.readyState, videoWidth: v.videoWidth, srcObject: !!v.srcObject };
  });

  console.log("\n── Camera status ────────────────────────────────────────");
  console.log("cam-status      :", camStatus);
  console.log("permission state:", permState);
  console.log("video           :", JSON.stringify(videoState));

  await tabPage.screenshot({ path: "live-camera-test.png" });
  console.log("Screenshot      : live-camera-test.png");

  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
})();
