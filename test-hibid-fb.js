// Drives the extension against HiBid and Facebook Marketplace, which are the
// sites the user said aren't working. Reports:
//   • What the DOM finder saw (with rejection reasons)
//   • What the scan produced
//   • Screenshots per site
//
// Uses copies of the user's existing Chrome profiles (data/*-chrome-profile)
// so Facebook stays logged in. Pass --interactive to pause before scan so you
// can manually navigate to a specific listing.

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, cpSync, existsSync, writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = resolve(__dirname, "dist/extension-wasm");
const SCRATCH   = resolve(__dirname, ".tmp/sites-profile");
const INTERACTIVE = process.argv.includes("--interactive");

// Accept a single URL via `--url=https://...` to test a specific listing.
// Example: node test-hibid-fb.js --url=https://www.facebook.com/marketplace/item/1234567890
const urlArg = process.argv.find((a) => a.startsWith("--url="));
const SITES = urlArg ? [
  { slug: "cli-url", url: urlArg.slice(6), label: "CLI URL: " + urlArg.slice(6).slice(0, 60), scrollDown: 300, waitMs: 4000 },
] : [
  {
    slug: "hibid-lots-pokemon",
    url:  "https://hibid.com/lots/700074/antiques-and-collectibles/collectibles/trading-cards/pokemon-cards",
    label: "HiBid — pokemon lots",
    scrollDown: 500,
    waitMs: 3500,
  },
  {
    slug: "hibid-catalog",
    url:  "https://hibid.com/catalog/684776/10-14-pokemon--trading-cards--and-collectibles-auction",
    label: "HiBid — specific auction catalog",
    scrollDown: 400,
    waitMs: 3500,
  },
  {
    slug: "fb-marketplace-trading-cards",
    url:  "https://www.facebook.com/marketplace/category/trading-cards",
    label: "FB Marketplace — trading cards (requires login)",
    scrollDown: 300,
    waitMs: 5000,
  },
];

const log = (...a) => console.log("[sites]", ...a);

function prepareProfile(src) {
  if (existsSync(SCRATCH)) return;
  mkdirSync(SCRATCH, { recursive: true });
  if (src && existsSync(src)) {
    log("copying profile from", src);
    cpSync(src, SCRATCH, { recursive: true, force: true });
  }
}

async function ensureReady(popupPage) {
  await popupPage.waitForFunction(
    () => document.getElementById("mtext")?.textContent !== "checking…",
    { timeout: 30_000 },
  ).catch(() => {});
  const pill = await popupPage.locator("#mtext").innerText().catch(() => "n/a");
  log("popup pill:", pill);
  if (pill !== "AI ready") {
    log("downloading models (may be first run)…");
    await popupPage.locator("#btn-setup").click().catch(() => {});
    const ok = await popupPage.waitForFunction(
      () => document.getElementById("mtext")?.textContent === "AI ready",
      { timeout: 15 * 60 * 1000 },
    ).then(() => true).catch(() => false);
    if (!ok) throw new Error("model download timed out");
    log("models ready");
  }
  // Clear any wizard step 2 upsell
  const inUpsell = await popupPage.evaluate(
    () => document.getElementById("wiz-step-2")?.classList.contains("active"),
  );
  if (inUpsell) {
    await popupPage.locator("#btn-wiz-skip").click().catch(() => {});
    await popupPage.waitForFunction(
      () => document.getElementById("setup-overlay")?.style.display === "none",
      { timeout: 3000 },
    ).catch(() => {});
  }
}

async function diagnoseSite(context, extId, popupPage, site) {
  log(`→ ${site.label}  (${site.url})`);
  const page = await context.newPage();
  page.on("pageerror", () => {});
  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(site.waitMs || 2500);
    // Scroll in increments to force lazy-loading libraries to fetch images in-view.
    if (site.scrollDown) {
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        await page.evaluate((n) => window.scrollTo(0, n), Math.round(site.scrollDown * (i / steps)));
        await page.waitForTimeout(500);
      }
      // Scroll back to the top so the scan captures the hero image
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1200);
    }
    // Wait for any still-loading images to settle (loop until the count stops shrinking).
    let prevPending = -1;
    for (let i = 0; i < 10; i++) {
      const pending = await page.evaluate(() => {
        let n = 0;
        for (const img of document.querySelectorAll("img")) {
          if (img.getBoundingClientRect().width < 40) continue;
          if (!img.complete || img.naturalWidth === 0) n++;
        }
        return n;
      });
      if (pending === 0 || pending === prevPending) break;
      prevPending = pending;
      await page.waitForTimeout(600);
    }
  } catch (err) {
    log(`  load failed: ${err.message}`);
    await page.close().catch(() => {});
    return { ...site, loadError: err.message };
  }

  if (INTERACTIVE) {
    log("  ────────────────────────────────────────────────────────────");
    log("  INTERACTIVE MODE");
    log("  1. In the Chrome window, log into Facebook if needed");
    log("  2. Click on a listing you want to scan");
    log("  3. Click the main image to open it in the lightbox");
    log("  4. Come back to this terminal and press Enter to run the scan");
    log("  ────────────────────────────────────────────────────────────");
    process.stdin.setRawMode(true);
    await new Promise((r) => process.stdin.once("data", r));
    process.stdin.setRawMode(false);
  }

  await page.bringToFront();

  // Inject content.js then call the diagnostic endpoint
  await context.serviceWorkers()[0].evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }, page.url() ? await getTabId(context, extId, page) : null).catch(() => {});

  const tabId = await getTabId(context, extId, page);
  const diag  = await context.serviceWorkers()[0].evaluate(async (tabId) => {
    try {
      return await chrome.tabs.sendMessage(tabId, { action: "findCardsDiag" });
    } catch (e) {
      return { error: e.message };
    }
  }, tabId);

  log(`  DOM: total <img>=${diag?.totalImgs ?? '?'}, candidates=${diag?.found?.length ?? 0}, bg-only=${diag?.bgCandidates?.length ?? 0}`);
  const rejCounts = {};
  for (const r of diag?.rejected || []) rejCounts[r.reason] = (rejCounts[r.reason] || 0) + 1;
  log(`  rejections: ${JSON.stringify(rejCounts)}`);
  // Sample a few actually-rendered images to see WHY the DOM finder missed them.
  const samples = await page.evaluate(() => {
    const out = [];
    for (const img of document.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) continue;
      out.push({
        src:      (img.currentSrc || img.src || "").slice(0, 120),
        dataSrc:  (img.getAttribute("data-src") || "").slice(0, 120),
        complete: img.complete,
        natW:     img.naturalWidth,
        natH:     img.naturalHeight,
        w: Math.round(r.width), h: Math.round(r.height),
        ratio: Number((r.width / r.height).toFixed(3)),
      });
      if (out.length >= 6) break;
    }
    return out;
  });
  log(`  rendered-img samples:`);
  for (const s of samples) log(`    ${JSON.stringify(s)}`);
  if ((diag?.bgCandidates || []).length) {
    log(`  CSS-bg candidates (first 3): ${JSON.stringify(diag.bgCandidates.slice(0, 3))}`);
  }

  // Always fire scan — SW now runs a YOLO fallback when DOM finds nothing
  let stats = null, overlay = null;
  {
    await popupPage.bringToFront();
    await popupPage.locator("#btn-scan").click();
    await popupPage.waitForFunction(
      () => {
        const m = document.getElementById("msg-bar")?.textContent || "";
        return m.includes("Found") || m.includes("No Pokémon") || /error/i.test(m);
      },
      { timeout: 120_000 },
    ).catch(() => {});
    stats = await popupPage.evaluate(() => ({
      msg:      document.getElementById("msg-bar")?.textContent,
      detected: document.getElementById("s-detected")?.textContent,
      value:    document.getElementById("s-value")?.textContent,
      ms:       document.getElementById("s-ms")?.textContent,
    }));
    await page.bringToFront();
    await page.waitForTimeout(1500);
    overlay = await page.evaluate(() => {
      const c = document.getElementById("__card-scanner-overlay__");
      if (!c) return { exists: false };
      const ctx = c.getContext("2d");
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let nz = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nz++;
      return { exists: true, pctCovered: ((nz / (c.width * c.height)) * 100).toFixed(2) };
    });
    log(`  stats: ${JSON.stringify(stats)}`);
    log(`  overlay: ${JSON.stringify(overlay)}`);
  }

  await page.screenshot({ path: resolve(__dirname, `sites-${site.slug}.png`), fullPage: false }).catch(() => {});
  await page.close().catch(() => {});
  return { ...site, diag: { ...diag, foundLen: diag?.found?.length }, stats, overlay };
}

async function getTabId(context, extId, page) {
  const sw = context.serviceWorkers()[0];
  const url = page.url();
  return sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === u)?.id ?? null;
  }, url);
}

(async () => {
  log("ext:", EXT_PATH);

  // Prefer FB profile if available, else HiBid, else fresh
  const fbProfile = resolve(__dirname, "data/facebook-chrome-profile");
  const hbProfile = resolve(__dirname, "data/hibid-chrome-profile");
  const srcProfile = existsSync(fbProfile) ? fbProfile : (existsSync(hbProfile) ? hbProfile : null);
  if (srcProfile) prepareProfile(srcProfile);
  else mkdirSync(SCRATCH, { recursive: true });

  const context = await chromium.launchPersistentContext(SCRATCH, {
    headless: false,
    viewport: { width: 1400, height: 1000 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--window-size=1400,1080",
    ],
  });

  await new Promise((r) => setTimeout(r, 3000));
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
  popupPage.on("pageerror", (e) => console.log("[popup]", e.message));
  await popupPage.goto(`chrome-extension://${extId}/popup.html`);
  await ensureReady(popupPage);

  const results = [];
  for (const site of SITES) {
    try {
      const r = await diagnoseSite(context, extId, popupPage, site);
      results.push(r);
    } catch (err) {
      log(`  FATAL: ${err.message}`);
      results.push({ ...site, fatal: err.message });
    }
    await popupPage.locator("#btn-clear").click().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }

  log("");
  log("════ summary ════");
  for (const r of results) {
    const err = r.loadError || r.fatal || "";
    const found = r.diag?.foundLen ?? 0;
    const bg    = r.diag?.bgCandidates?.length ?? 0;
    const d = r.stats?.detected ?? "—";
    const v = r.stats?.value    ?? "—";
    log(`  ${r.label.padEnd(42)} <img>=${r.diag?.totalImgs ?? "?"}  dom-found=${found}  bg-cand=${bg}  scanned=${d}  total=${v}  ${err}`);
  }
  writeFileSync(resolve(__dirname, "sites-summary.json"), JSON.stringify(results, null, 2));
  log("summary saved: sites-summary.json");

  // Keep window open briefly for inspection
  await new Promise((r) => setTimeout(r, 2500));
  await context.close();
})();
