/* global document, window, chrome -- referenced only inside page.evaluate callbacks, which run in the browser */
/**
 * L3 real-world run: scan public marketplace pages with the dev extension build, twice per page
 * (forceScreenshotPath off, then on), and record what the extension did.
 *
 *   node scripts/realworld-run.mjs pages.json            pages.json = [{ id, site, case, url }]
 *   node scripts/realworld-run.mjs --local               harness check on the local default photo
 *   node scripts/realworld-run.mjs --discover <url> <linkRegex>   list matching links of a page
 *
 * Env: EXT_DIR (default extension-wasm), OUT_DIR (default data/realworld/<date>), PROFILE (default
 * .tmp/realworld-profile, a copy of data/extension-live-profile), SCAN_ONLY=id1,id2, DELAY_MIN/DELAY_MAX (s).
 * Never touches data/sealed-test. Stops a site on the first challenge page; no bypass attempts.
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearStaleServiceWorker } from './lib/profile-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extPath = path.resolve(root, 'dist', process.env.EXT_DIR || 'extension-wasm');
const outDir = path.resolve(process.env.OUT_DIR || path.join(root, 'data', 'realworld', '2026-10-16'));
const profile = path.resolve(process.env.PROFILE || path.join(root, '.tmp', 'realworld-profile'));
const delayMin = Number(process.env.DELAY_MIN || 5);
const delayMax = Number(process.env.DELAY_MAX || 10);
const only = process.env.SCAN_ONLY ? process.env.SCAN_ONLY.split(',') : null;

const args = process.argv.slice(2);
const discoverMode = args[0] === '--discover';
const localMode = args[0] === '--local';
const pagesFile = !discoverMode && !localMode ? path.resolve(args[0] || '') : null;

const BLOCK_PATTERNS = [
  /captcha/i, /verify (that )?you are (a )?human/i, /are you a robot/i, /access denied/i,
  /pardon our interruption/i, /just a moment/i, /checking your browser/i, /unusual traffic/i,
  /robot check/i, /security check/i, /request blocked/i, /Press & Hold/i,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const politeDelay = () => sleep((delayMin + Math.random() * (delayMax - delayMin)) * 1000);
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(profile), { recursive: true });
if (!fs.existsSync(profile)) throw new Error(`profile ${profile} missing: copy data/extension-live-profile there first`);

let server = null;
let localUrl = null;
if (localMode) {
  const photo = fs.readFileSync(path.join(root, 'data', 'detect-marketplace', 'goodwill', '279630564', '00.jpg'));
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/card.jpg')) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': photo.length });
      res.end(photo);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>lot</title><body style="margin:0;background:#111">
      <img alt="pokemon card lot" src="/card.jpg" style="width:100vw;height:100vh;object-fit:contain"></body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  localUrl = `http://127.0.0.1:${server.address().port}/lot`;
}

clearStaleServiceWorker(root, profile);
for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.rmSync(path.join(profile, lock), { force: true });

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1100, height: 1200 },
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--no-sandbox'],
});
const isExtensionWorker = (w) => w.url().startsWith('chrome-extension://');
const worker = context.serviceWorkers().find(isExtensionWorker)
  || await context.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout: 20_000 });
const extensionId = new URL(worker.url()).hostname;

const swLogs = [];
const noteWorker = (w) => w.on('console', (msg) => swLogs.push(`${msg.type()} ${msg.text()}`));
context.serviceWorkers().forEach(noteWorker);
context.on('serviceworker', noteWorker);

const listing = context.pages()[0] || await context.newPage();
let pageErrors = [];
listing.on('pageerror', (err) => pageErrors.push(`pageerror ${err.message}`.slice(0, 300)));
listing.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(`console ${msg.text()}`.slice(0, 300)); });

// First popup tab: finish model setup if needed, as live-scan does.
async function readyPopup(popup) {
  await popup.waitForFunction(() => {
    const overlay = document.getElementById('setup-overlay');
    return !document.getElementById('btn-scan')?.disabled || (overlay && overlay.style.display === 'flex');
  });
  if (await popup.locator('#setup-overlay').isVisible() && await popup.locator('#btn-setup').isVisible()) {
    console.log('downloading models...');
    await popup.locator('#btn-setup').click();
    await popup.waitForFunction(() => {
      const setup = document.getElementById('setup-status')?.textContent || '';
      return !document.getElementById('btn-scan')?.disabled || setup.includes('download stopped');
    }, null, { timeout: 8 * 60_000 });
  }
  for (const id of ['#btn-wiz-skip', '#btn-wiz-access-skip']) {
    if (await popup.locator(id).isVisible()) await popup.locator(id).click();
  }
}

async function discover(url, regex) {
  await listing.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(Number(process.env.WAIT || 4000));
  await listing.evaluate(() => window.scrollBy(0, 1500));
  await sleep(1500);
  const re = new RegExp(regex);
  const links = await listing.evaluate(() => [...document.querySelectorAll('a[href]')]
    .map((a) => ({ href: a.href, text: ((a.closest('li, article, [class*=item], [class*=card]') || a).innerText || a.getAttribute('aria-label') || a.title || '').trim().replace(/\s+/g, ' ').slice(0, 140) })));
  const seen = new Set();
  for (const link of links) {
    if (!re.test(link.href) || seen.has(link.href.split('?')[0])) continue;
    seen.add(link.href.split('?')[0]);
    console.log(`${link.href}\t${link.text}`);
  }
  console.log('title:', await listing.title());
  if (process.env.DUMP) console.log((await listing.evaluate(() => document.body.innerText)).slice(0, 800));
}

async function blockedReason() {
  const title = await listing.title().catch(() => '');
  const text = await listing.evaluate(() => (document.body?.innerText || '').slice(0, 3000)).catch(() => '');
  const hit = BLOCK_PATTERNS.find((re) => re.test(title) || (text.length < 1500 && re.test(text)));
  return hit ? `${hit} in title/body: ${title.slice(0, 80)}` : null;
}

async function main() {
  if (discoverMode) {
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/popup.html`);
    await readyPopup(setup);
    await setup.close();
    await discover(args[1], args[2] || '.');
    return;
  }

  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/popup.html`);
  await readyPopup(setup);
  await setup.close();
  await listing.bringToFront();

  const scannerPromise = context.waitForEvent('page', { predicate: (p) => p.url().includes('/popup.html'), timeout: 15_000 });
  await worker.evaluate(async () => {
    await chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 500, height: 720, focused: false });
  });
  const scanner = await scannerPromise;
  const popupErrors = [];
  scanner.on('pageerror', (err) => popupErrors.push(`pageerror ${err.message}`.slice(0, 300)));
  scanner.on('console', (msg) => { if (msg.type() === 'error') popupErrors.push(`console ${msg.text()}`.slice(0, 300)); });
  await readyPopup(scanner);
  if (!(await scanner.locator('#btn-scan').isEnabled())) {
    throw new Error('scan stayed disabled: ' + await scanner.locator('#setup-status').textContent());
  }
  await scanner.locator('#era-select').selectOption('');

  const pages = localMode
    ? [{ id: 'local-default', site: 'local', case: 'local lot photo', url: localUrl }]
    : JSON.parse(fs.readFileSync(pagesFile, 'utf8'));
  const resultsPath = path.join(outDir, localMode ? 'results-local.json' : 'results.json');
  const results = fs.existsSync(resultsPath) && !localMode ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : [];
  const blockedSites = new Set(results.filter((r) => r.blocked).map((r) => r.site));
  const save = () => fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

  for (const page of pages) {
    if (only && !only.includes(page.id)) continue;
    if (results.some((r) => r.id === page.id && r.mode === 'off') && !localMode && !only) continue;
    if (blockedSites.has(page.site)) {
      results.push({ ...page, mode: 'both', skipped: 'site blocked earlier' });
      save();
      continue;
    }
    for (const forceScreenshot of [false, true]) {
      const mode = forceScreenshot ? 'on' : 'off';
      const rec = { ...page, mode, forceScreenshotPath: forceScreenshot };
      if (!localMode) await politeDelay();
      pageErrors = [];
      popupErrors.length = 0;
      const loadStarted = Date.now();
      try {
        await listing.goto(page.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await listing.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
        await sleep(localMode ? 500 : 4000);
        // Marketplace photos lazy-load; a short scroll round trip mimics a person looking at the listing.
        if (!localMode) { await listing.evaluate(() => window.scrollTo(0, 0)); await sleep(800); }
      } catch (err) {
        rec.error = `navigation failed: ${err.message}`.slice(0, 300);
        results.push(rec); save();
        continue;
      }
      rec.pageLoadMs = Date.now() - loadStarted;
      rec.finalUrl = listing.url();
      rec.pageTitle = await listing.title().catch(() => '');
      rec.h1 = await listing.evaluate(() => document.querySelector('h1')?.innerText?.trim().slice(0, 200) || '').catch(() => '');
      const blocked = await blockedReason();
      if (blocked) {
        rec.blocked = blocked;
        results.push(rec); save();
        blockedSites.add(page.site);
        console.log(`BLOCKED ${page.site}: ${blocked}`);
        break;
      }

      await worker.evaluate((force) => chrome.storage.local.set({ forceScreenshotPath: force }), forceScreenshot);
      await listing.bringToFront();
      const logStart = swLogs.length;
      const started = Date.now();
      await scanner.locator('#btn-scan').click();
      let timedOut = false;
      try {
        await scanner.waitForFunction(() => {
          const msg = document.getElementById('msg-bar')?.textContent || '';
          const label = document.getElementById('btn-label')?.textContent || '';
          const cards = document.querySelectorAll('.card-row').length;
          return label === 'SCAN PAGE' && (msg.length > 0 || cards > 0) && !msg.startsWith('Capturing');
        }, null, { timeout: 4 * 60_000 });
      } catch { timedOut = true; }
      rec.elapsedMs = Date.now() - started;
      if (timedOut) rec.error = 'scan did not finish within 4 minutes';
      // Prices arrive after the cards; give them a bounded window to fill in.
      await scanner.waitForFunction(() => !document.body.innerText.includes('Getting price'), null, { timeout: 25_000 }).catch(() => {});
      rec.pricesWaitedMs = Date.now() - started - rec.elapsedMs;
      await sleep(500);

      const ui = await scanner.evaluate(() => {
        const text = (el) => (el?.textContent || '').trim();
        const rows = [...document.querySelectorAll('.card-row')].map((row) => ({
          name: text(row.querySelector('.card-name')),
          sub: text(row.querySelector('.card-sub')),
          stripe: row.querySelector('.conf-stripe')?.className.replace('conf-stripe', '').trim() || '',
          picker: /Which card is this/i.test(row.querySelector('.picker-title')?.textContent || ''),
          candidates: [...row.querySelectorAll('.pick-card .pick-name')].map((v) => text(v)),
          setNotSure: /Set not sure/i.test(text(row.querySelector('.card-sub'))),
          setRange: text(row.querySelector('.set-range')),
          repeatNote: Boolean(row.querySelector('.repeat-note')),
          prices: [...row.querySelectorAll('.card-price, .g-val')].map((v) => text(v)).filter((v) => v.startsWith('$')),
          priceNote: [...row.querySelectorAll('.spread-warn, .no-price')].map((v) => text(v)).join(' | '),
        }));
        const mem = performance.memory ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576) } : null;
        return {
          message: text(document.getElementById('msg-bar')),
          detectedStat: String(rows.length),
          totalStat: text(document.getElementById('s-value')),
          totalDetail: document.getElementById('s-value')?.title || '',
          rows,
          popupMemory: mem,
          scanDisabled: document.getElementById('btn-scan').disabled,
        };
      });
      const swMemory = await worker.evaluate(() => performance.memory
        ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576) }
        : null).catch(() => null);

      const scanLogs = swLogs.slice(logStart);
      const photoLines = scanLogs.filter((l) => /\[BG\]\s+photo /.test(l));
      rec.logs = scanLogs.filter((l) => l.includes('[BG]')).slice(0, 400);
      rec.swErrors = scanLogs.filter((l) => /^(error|warning) /.test(l)).slice(0, 15);
      rec.pageErrors = pageErrors.slice(0, 10);
      rec.pageErrorCount = pageErrors.length;
      rec.popupErrors = popupErrors.slice(0, 10);
      rec.swMemory = swMemory;
      rec.popupMemory = ui.popupMemory;
      rec.scanMessage = ui.message;
      rec.scanOk = !timedOut && !/^(could not|error|no scannable|that tab|card pictures)/i.test(ui.message) && !/error|failed|could not/i.test(ui.message);
      rec.domCardShaped = Number(scanLogs.join('\n').match(/DOM finder returned (\d+)/)?.[1] ?? NaN);
      rec.photoCandidates = Number(scanLogs.join('\n').match(/(\d+) photo candidates/)?.[1] ?? 0);
      rec.photosScanned = photoLines.length;
      rec.pathSource = photoLines.filter((l) => l.includes('(source image)')).length;
      rec.pathScreenshot = photoLines.filter((l) => l.includes('(viewport crop)')).length;
      rec.pathUsed = rec.pathSource && rec.pathScreenshot ? 'mixed' : rec.pathSource ? 'source' : rec.pathScreenshot ? 'screenshot' : 'none';
      rec.cards = ui.rows;
      rec.detected = ui.rows.length;
      const known = (r) => r.name && !/^(Unknown card|Card back)$/i.test(r.name);
      rec.unsure = ui.rows.filter((r) => r.picker).length;
      rec.identified = ui.rows.filter((r) => known(r) && !r.picker && r.stripe !== 'abstain').length;
      rec.priced = ui.rows.filter((r) => r.prices.some((p) => p.startsWith('$'))).length;
      rec.useful = ui.rows.filter((r) => known(r) && (r.prices.some((p) => p.startsWith('$')) || r.setRange)).length;
      rec.cardNames = ui.rows.map((r) => r.name);
      rec.totalStat = ui.totalStat;
      rec.totalDetail = ui.totalDetail;
      rec.scanMsStat = null;
      const title = norm(rec.h1 || rec.pageTitle);
      rec.titleContainsName = rec.detected === 1 && known(ui.rows[0]) ? title.includes(norm(ui.rows[0].name)) : null;

      const base = `${slug(page.id)}-${mode}`;
      rec.screenshots = { page: path.relative(root, path.join(outDir, `${base}-page.png`)), popup: path.relative(root, path.join(outDir, `${base}-popup.png`)) };
      await listing.screenshot({ path: path.join(outDir, `${base}-page.png`) }).catch((e) => { rec.screenshots.page = `failed: ${e.message}`; });
      await scanner.screenshot({ path: path.join(outDir, `${base}-popup.png`), fullPage: true }).catch((e) => { rec.screenshots.popup = `failed: ${e.message}`; });
      results.push(rec);
      save();
      console.log(`${page.id} [${mode}] ok=${rec.scanOk} ${rec.elapsedMs}ms path=${rec.pathUsed} detected=${rec.detected} id=${rec.identified} unsure=${rec.unsure} priced=${rec.priced} msg=${JSON.stringify(rec.scanMessage).slice(0, 100)}`);
      await scanner.locator('#btn-clear').click().catch(() => {});
    }
  }
  save();
}

try {
  await main();
} finally {
  await context.close().catch(() => {});
  server?.close();
}
