/**
 * Connects to the user's live Chrome via CDP and inspects the extension.
 */
import { chromium } from "playwright";

(async () => {
  console.log("Connecting to Chrome on port 9222...");
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  console.log("Browser contexts:", contexts.length);

  // List all open pages
  const pages = [];
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      pages.push(p);
      console.log(" page:", p.url());
    }
  }

  // Find the extensions management page or any chrome-extension page
  const extPages = pages.filter(p => p.url().startsWith("chrome-extension://"));
  console.log("\nExtension pages open:", extPages.length);
  extPages.forEach(p => console.log(" -", p.url()));

  // Navigate to chrome://extensions/ to check extension status
  const mainCtx = contexts[0];
  const extMgmtPage = await mainCtx.newPage();
  await extMgmtPage.goto("chrome://extensions/");
  await new Promise(r => setTimeout(r, 2000));
  await extMgmtPage.screenshot({ path: "live-extensions-page.png", fullPage: true });
  console.log("\nScreenshot of chrome://extensions/: live-extensions-page.png");

  // Find the Pokemon extension
  const extInfo = await extMgmtPage.evaluate(() => {
    // chrome://extensions uses a custom element with shadow DOM
    const manager = document.querySelector("extensions-manager");
    if (!manager) return { error: "no extensions-manager element" };
    const shadow = manager.shadowRoot;
    if (!shadow) return { error: "no shadow root" };
    const items = shadow.querySelectorAll("extensions-item");
    return Array.from(items).map(item => {
      const sr = item.shadowRoot;
      return {
        name: sr?.querySelector("#name")?.textContent?.trim(),
        enabled: item.getAttribute("enabled"),
        hasError: !!sr?.querySelector(".errors-button"),
      };
    });
  });
  console.log("\nInstalled extensions:", JSON.stringify(extInfo, null, 2));

  // Try to find service workers for the extension
  const serviceWorkers = [];
  for (const ctx of contexts) {
    for (const sw of ctx.serviceWorkers()) {
      serviceWorkers.push(sw.url());
    }
  }
  console.log("\nService workers:", serviceWorkers.length ? serviceWorkers : "none");

  // If extension is installed, open popup.html as a tab and check camera
  const pokemonSW = serviceWorkers.find(u => u.includes("popup") || u.includes("background"));
  const extIdMatch = serviceWorkers[0]?.match(/chrome-extension:\/\/([^/]+)/);
  if (extIdMatch) {
    const extId = extIdMatch[1];
    console.log("\nExtension ID:", extId);

    // Read background.js to confirm our fix is in place
    const bgPage = await mainCtx.newPage();
    await bgPage.goto(`chrome-extension://${extId}/background.js`);
    const bgText = await bgPage.locator("body").innerText().catch(() => "");
    console.log("\n── background.js (first 300 chars) ──");
    console.log(bgText.slice(0, 300));
    await bgPage.close();

    // Open popup.html as a tab
    console.log("\nOpening popup.html as tab...");
    const tabPage = await mainCtx.newPage();
    const logs = [];
    tabPage.on("console", m => {
      logs.push(`[${m.type()}] ${m.text()}`);
      console.log("[TAB]", m.text());
    });
    tabPage.on("pageerror", e => console.log("[TAB ERROR]", e.message));

    await tabPage.goto(`chrome-extension://${extId}/popup.html`);
    await new Promise(r => setTimeout(r, 6000));

    const camStatus = await tabPage.evaluate(() =>
      document.getElementById("cam-status")?.textContent ?? "not found"
    );
    const permState = await tabPage.evaluate(async () => {
      try { const r = await navigator.permissions.query({ name: "camera" }); return r.state; }
      catch (e) { return "error: " + e.message; }
    });
    const videoState = await tabPage.evaluate(() => {
      const v = document.getElementById("video");
      if (!v) return null;
      return { readyState: v.readyState, videoWidth: v.videoWidth, srcObject: !!v.srcObject };
    });

    console.log("\n── Camera status in tab ──────────────────────────────");
    console.log("cam-status      :", camStatus);
    console.log("permission state:", permState);
    console.log("video           :", JSON.stringify(videoState));

    await tabPage.screenshot({ path: "live-popup-tab.png" });
    console.log("Screenshot      : live-popup-tab.png");
  } else {
    console.log("\nCould not find extension service worker. Is the extension loaded?");
  }

  await browser.close();
})();
