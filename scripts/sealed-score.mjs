// Score the sealed-test build of the extension on the sealed test photos. Prints totals only.
//
//   node scripts/sealed-score.mjs [--dir data/sealed-test] [--profile data/sealed-score-profile] [--ext dist/extension-wasm-sealed]
//
// Build the extension first: powershell -File scripts/build-wasm-extension.ps1 -Sealed
// Run it when asked, not in a tuning loop: every run is logged in score-log.jsonl.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isUnsure } from '../tools/extension-wasm/lib/card-picker.js';
import { detectedVariant } from '../tools/extension-wasm/lib/card-display.js';
import { currentLabels, isPhotoDone, truthOf, validPhotoRow } from './lib/sealed-labels.mjs';
import { addTallies, emptyTally, summarize, tallyPhoto } from './lib/sealed-metrics.mjs';
import { isInside, localHostAllowed } from './lib/sealed-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const dir = path.resolve(flag('dir', path.join('data', 'sealed-test')));
const profile = path.resolve(flag('profile', path.join(root, 'data', 'sealed-score-profile')));
const extPath = path.resolve(flag('ext', path.join(root, 'dist', 'extension-wasm-sealed')));
const MAX_VIEWPORT_SIDE = 1400;
const SCAN_TIMEOUT_MS = 4 * 60_000;

// Only messages written here may reach the screen: browser and Playwright errors can quote a photo's page address.
class SetupError extends Error {}

const readJsonl = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []);

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

// The cache cleanup below deletes inside the profile, so it must be a scratch folder of this repo, never a real browser profile.
if (!isInside(path.join(root, 'data'), profile) && !isInside(path.join(root, '.tmp'), profile)) {
  fail('--profile must be a folder inside this repo\'s data/ folder.');
}
if (!isInside(path.join(root, 'dist'), extPath) || !fs.existsSync(path.join(extPath, 'lib', 'net-shipped.js'))) {
  fail('Build the sealed test extension first: powershell -File scripts/build-wasm-extension.ps1 -Sealed');
}

const labels = currentLabels(readJsonl(path.join(dir, 'labels.jsonl')));
const allPhotos = readJsonl(path.join(dir, 'photos.jsonl')).filter(validPhotoRow);
const ready = allPhotos.filter((photo) => isPhotoDone(photo, labels));
if (ready.length === 0) fail('No fully labeled photos yet.');

// Photos are served by position, so no file name or sha reaches a log line or the browser.
const server = http.createServer((req, res) => {
  if (!localHostAllowed(req.headers.host, req.socket.localPort)) {
    res.writeHead(403).end();
    return;
  }
  const hit = req.url.match(/^\/(page|img)\/(\d+)/);
  const photo = hit && ready[Number(hit[2])];
  if (!photo) {
    res.writeHead(404).end();
    return;
  }
  if (hit[1] === 'img') {
    const bytes = fs.readFileSync(path.join(dir, photo.file));
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': bytes.length });
    res.end(bytes);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>photo</title><body style="margin:0;background:#111">
    <img alt="pokemon card photo" src="/img/${hit[2]}.jpg" style="width:100vw;height:100vh;object-fit:contain"></body>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// Chrome keeps running the service worker script it cached on an earlier launch of the same
// profile, so a rebuilt extension would be scored as its old self. Models live in CacheStorage, which stays.
for (const stale of ['ScriptCache', 'Database']) {
  fs.rmSync(path.join(profile, 'Default', 'Service Worker', stale), { recursive: true, force: true });
}

const isExtensionWorker = (w) => w.url().startsWith('chrome-extension://');
// Chrome's sandbox is on: Playwright's own extension tests run without --no-sandbox on Windows.
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 900, height: 1200 },
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

let tally = emptyTally();
let failed = 0;
const input = { sourceImage: 0, viewportCrop: 0 };
let stopped = null;
try {
  const worker = context.serviceWorkers().find(isExtensionWorker)
    || await context.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout: 20_000 });
  // The extension logs which picture the detector ran on; only the two totals are kept.
  const note = (text) => {
    if (text.includes('(source image)')) input.sourceImage += 1;
    else if (text.includes('(viewport crop)')) input.viewportCrop += 1;
  };
  worker.on('console', (msg) => note(msg.text()));

  const listing = await context.newPage();
  const scannerPromise = context.waitForEvent('page', { predicate: (page) => page.url().includes('/popup.html'), timeout: 15_000 });
  scannerPromise.catch(() => {});
  await worker.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 500, height: 720, focused: false }));
  const scanner = await scannerPromise;
  const settled = () => scanner.waitForFunction(() => {
    const text = document.getElementById('mtext')?.textContent || '';
    return text && !text.includes('checking');
  }, null, { timeout: 60_000 });
  await settled();
  if (await scanner.locator('#setup-overlay').isVisible() && await scanner.locator('#btn-setup').isVisible()) {
    console.log('First run in this profile: downloading the models. This can take several minutes.');
    await scanner.locator('#btn-setup').click();
    await scanner.waitForFunction(() => {
      const status = document.getElementById('mtext')?.textContent || '';
      const setup = document.getElementById('setup-status')?.textContent || '';
      return status.includes('AI ready') || setup.includes('download stopped');
    }, null, { timeout: 15 * 60_000 });
  }
  if (await scanner.locator('#btn-wiz-skip').isVisible()) await scanner.locator('#btn-wiz-skip').click();
  if (!(await scanner.locator('#btn-scan').isEnabled())) throw new SetupError('The extension models are not ready in the scoring profile.');

  for (const [index, photo] of ready.entries()) {
    const scale = Math.min(1, MAX_VIEWPORT_SIDE / Math.max(photo.width, photo.height));
    let response = null;
    let viewport = null;
    try {
      await listing.setViewportSize({ width: Math.max(300, Math.round(photo.width * scale)), height: Math.max(300, Math.round(photo.height * scale)) });
      await listing.goto(`http://127.0.0.1:${port}/page/${index}`);
      await listing.waitForFunction(() => {
        const img = document.querySelector('img');
        return img && img.complete && img.naturalWidth > 0;
      });
      await listing.bringToFront();
      viewport = listing.viewportSize();
      response = await Promise.race([
        scanner.evaluate(() => chrome.runtime.sendMessage({ action: 'scanPage', era: '' })),
        new Promise((resolve) => setTimeout(resolve, SCAN_TIMEOUT_MS)),
      ]);
    } catch {
      response = null;
    }
    const { truth, missed } = truthOf(photo, labels);
    // A photo that did not scan scores as if the scanner found nothing, so failures lower recall instead of hiding.
    if (!Array.isArray(response?.cards)) {
      failed += 1;
      tally = addTallies(tally, tallyPhoto({ truth, missed, preds: [] }));
      continue;
    }
    // The page shows the photo contained in the viewport, so viewport pixels map back by one factor and an offset.
    const fit = Math.min(viewport.width / photo.width, viewport.height / photo.height);
    const offsetX = (viewport.width - photo.width * fit) / 2;
    const offsetY = (viewport.height - photo.height * fit) / 2;
    const preds = response.cards.map((card) => ({
      box: [(card.box[0] - offsetX) / fit, (card.box[1] - offsetY) / fit, (card.box[2] - offsetX) / fit, (card.box[3] - offsetY) / fit],
      id: card.identity?.id ?? null,
      unsure: isUnsure(card),
      edition: card.variant?.edition ?? (card.firstEdition === true ? 'first' : null),
      finish: card.variant?.finish ?? null,
      key: detectedVariant(card),
      variantNames: Object.keys(card.price_grid?.variants || {}),
    }));
    tally = addTallies(tally, tallyPhoto({ truth, missed, preds }));
  }
} catch (err) {
  stopped = err instanceof SetupError ? err.message : 'The run stopped early because of a browser or extension problem.';
} finally {
  await context.close().catch(() => {});
  server.close();
}
if (stopped) fail(stopped);

const metrics = summarize(tally);
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const NAMES = {
  detectionRecall: 'Detection recall (of all labeled cards)',
  detectionPrecision: 'Detection precision (boxes that are one whole card)',
  identityOfDetected: 'Identity accuracy (of detected cards)',
  identityEndToEnd: 'End-to-end identity accuracy (of all labeled cards)',
  precisionWhenSure: 'Precision when not unsure (of detected cards)',
  unsureRate: 'Unsure rate (of detected cards)',
  editionAccuracy: 'Edition accuracy (of calls made)',
  editionNoCall: 'Edition no-call rate (of labeled editions)',
  finishAccuracy: 'Finish accuracy (of calls made)',
  finishNoCall: 'Finish no-call rate (of labeled finishes)',
  priceOfIdentified: 'Right price key (of correctly identified cards)',
  priceEndToEnd: 'End-to-end right price key (of all labeled cards with a variant)',
};
const notLabeled = allPhotos.length - ready.length;
console.log(`Scored ${tally.photos} of ${allPhotos.length} sealed photos (${notLabeled} not fully labeled).`);
if (tally.photos < allPhotos.length) console.log('WARNING: unlabeled photos are left out, so these numbers cover only part of the set.');
if (failed) console.log(`Scans that failed or returned nothing, counted as misses: ${failed}.`);
console.log(`Detector input: source image for ${input.sourceImage} photos, screenshot crop for ${input.viewportCrop}.`);
if (input.viewportCrop > 0) console.log('WARNING: some photos ran on a screenshot crop, not the source image, so they are not comparable with collection.');
for (const [key, label] of Object.entries(NAMES)) {
  const m = metrics[key];
  console.log(`${label.padEnd(68)} ${m ? `${percent(m.p).padStart(6)}  95% ${percent(m.lo)} to ${percent(m.hi)}  (${m.k} of ${m.n})` : 'no data'}`);
}

const logFile = path.join(dir, 'score-log.jsonl');
fs.appendFileSync(logFile, JSON.stringify({
  ts: Date.now(), gitCommit: gitCommit(), n: tally.photos, of: allPhotos.length, failed, input, metrics,
}) + '\n');
console.log(`This is run ${readJsonl(logFile).length} on this set.`);
