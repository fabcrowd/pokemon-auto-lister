// Drives the extension against real live sites that reliably contain Pokémon card
// images. Produces per-site screenshots + a summary of detections / identifications
// / overlay coverage. Not a strict pass/fail — real pages change constantly.
//
// Add or remove entries from SITES as needed.

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = resolve(__dirname, "dist/extension-wasm");
const PROFILE   = resolve(__dirname, ".tmp/ship-profile");

mkdirSync(PROFILE, { recursive: true });

const SITES = [
  {
    slug: "bulbapedia-base-set",
    url:  "https://bulbapedia.bulbagarden.net/wiki/Base_Set_(TCG)",
    waitForSelector: "img",
    scrollDown: 400,  // reveal the set listing images
    label: "Bulbapedia — Base Set",
  },
  {
    slug: "pokellector-base-set",
    url:  "https://www.pokellector.com/Base-Set-Expansion/",
    waitForSelector: "img",
    scrollDown: 300,
    label: "Pokellector — Base Set",
  },
  {
    slug: "tcgplayer-charizard-search",
    url:  "https://www.tcgplayer.com/search/pokemon/product?q=charizard+base+set&view=grid",
    waitForSelector: "img",
    scrollDown: 500,
    label: "TCGPlayer — Charizard search",
  },
];

const log = (...a) => console.log("[real]", ...a);

async function ensureReadyAndSkipWizard(popupPage) {
  // Wait for the AI model status to settle
  await popupPage.waitForFunction(
    () => document.getElementById("mtext")?.textContent !== "checking…",
    { timeout: 30_000 },
  ).catch(() => {});
  const pill = await popupPage.locator("#mtext").innerText();
  log("popup pill:", pill);

  // If wizard still showing (new install path), download then skip the PPT step
  const needsSetup = await popupPage.evaluate(
    () => document.getElementById("wiz-step-1")?.classList.contains("active"),
  );
  if (needsSetup) {
    log("downloading models…");
    await popupPage.locator("#btn-setup").click();
    const ok = await popupPage.waitForFunction(
      () => document.getElementById("mtext")?.textContent === "AI ready",
      { timeout: 15 * 60 * 1000 },
    ).then(() => true).catch(() => false);
    if (!ok) throw new Error("model download timed out");
    log("models ready");
  }
  const inUpsell = await popupPage.evaluate(
    () => document.getElementById("wiz-step-2")?.classList.contains("active"),
  );
  if (inUpsell) {
    await popupPage.locator("#btn-wiz-skip").click();
    await popupPage.waitForFunction(
      () => document.getElementById("setup-overlay")?.style.display === "none",
      { timeout: 3000 },
    ).catch(() => {});
    log("skipped PPT upsell");
  }
}

async function scanSite(context, extId, popupPage, site) {
  log(`→ ${site.label}  (${site.url})`);
  const page = await context.newPage();
  page.on("pageerror", () => {}); // ignore site JS errors
  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector(site.waitForSelector, { timeout: 20_000 }).catch(() => {});
    if (site.scrollDown) {
      await page.evaluate((n) => window.scrollTo(0, n), site.scrollDown);
      await page.waitForTimeout(1200); // let lazy-load fire
    }
  } catch (err) {
    log(`  load failed: ${err.message}`);
    await page.close().catch(() => {});
    return { ...site, loadError: err.message };
  }

  // Make this tab the extension target. The popup's SW uses lastFocusedWindow for
  // its own target resolution — bring the content tab to the front first.
  await page.bringToFront();
  await popupPage.bringToFront();

  // Fire the scan from the popup, same code path a user takes
  await popupPage.locator("#btn-scan").click();

  // Scan completes when the message bar reports found-or-nothing
  await popupPage.waitForFunction(
    () => {
      const m = document.getElementById("msg-bar")?.textContent || "";
      return m.includes("Found") || m.includes("No Pokémon") || /error/i.test(m);
    },
    { timeout: 90_000 },
  ).catch(() => {});

  const stats = await popupPage.evaluate(() => ({
    msg:      document.getElementById("msg-bar")?.textContent,
    detected: document.getElementById("s-detected")?.textContent,
    value:    document.getElementById("s-value")?.textContent,
    ms:       document.getElementById("s-ms")?.textContent,
  }));
  log(`  stats: ${JSON.stringify(stats)}`);

  // Wait for the overlay to render on the content tab
  await page.bringToFront();
  await page.waitForFunction(
    () => document.getElementById("__card-scanner-overlay__") != null,
    { timeout: 10_000 },
  ).catch(() => {});
  await page.waitForTimeout(1500);

  const overlay = await page.evaluate(() => {
    const c = document.getElementById("__card-scanner-overlay__");
    if (!c) return { exists: false };
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nz = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nz++;
    return { exists: true, width: c.width, height: c.height, pctCovered: ((nz / (c.width * c.height)) * 100).toFixed(2) };
  });
  log(`  overlay: ${JSON.stringify(overlay)}`);

  const pagePath    = resolve(__dirname, `real-${site.slug}-page.png`);
  const overlayPath = resolve(__dirname, `real-${site.slug}-overlay.png`);
  await page.screenshot({ path: pagePath, fullPage: false });
  const canvasPng = await page.evaluate(() => {
    const c = document.getElementById("__card-scanner-overlay__");
    return c ? c.toDataURL("image/png") : null;
  });
  if (canvasPng) writeFileSync(overlayPath, Buffer.from(canvasPng.split(",")[1], "base64"));

  await page.close().catch(() => {});
  return { ...site, stats, overlay };
}

(async () => {
  log("ext:", EXT_PATH);
  log("profile:", PROFILE);

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1400, height: 1000 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--window-size=1400,1080",
    ],
  });

  // Pre-start the SW
  await new Promise((r) => setTimeout(r, 2500));
  if (!context.serviceWorkers().length) {
    const probe = await context.newPage();
    await probe.goto("chrome://extensions/");
    await new Promise((r) => setTimeout(r, 1500));
    await probe.close();
  }
  const sw = context.serviceWorkers()[0];
  if (!sw) { log("FAIL: no SW"); await context.close(); process.exit(1); }
  sw.on("console", (m) => console.log("[sw]", m.type(), m.text()));
  const extId = sw.url().split("/")[2];
  log("extId:", extId);

  const popupPage = await context.newPage();
  popupPage.on("pageerror", (e) => console.log("[popup pageerror]", e.message));
  await popupPage.goto(`chrome-extension://${extId}/popup.html`);

  await ensureReadyAndSkipWizard(popupPage);

  const results = [];
  for (const site of SITES) {
    try {
      const r = await scanSite(context, extId, popupPage, site);
      results.push(r);
    } catch (err) {
      log(`  FATAL: ${err.message}`);
      results.push({ ...site, fatal: err.message });
    }
    // Clear overlay between runs so the previous site's state doesn't bleed
    await popupPage.locator("#btn-clear").click().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }

  log("");
  log("═════════════ summary ═════════════");
  for (const r of results) {
    const d = r.stats?.detected ?? "—";
    const v = r.stats?.value    ?? "—";
    const cov = r.overlay?.pctCovered ?? "0";
    const err = r.loadError || r.fatal || "";
    log(`  ${r.label.padEnd(38)}  detected=${d}  total=${v}  overlay=${cov}%  ${err}`);
  }
  writeFileSync(
    resolve(__dirname, "real-sites-summary.json"),
    JSON.stringify(results, null, 2),
  );
  log("summary saved: real-sites-summary.json");

  await context.close();
})();
