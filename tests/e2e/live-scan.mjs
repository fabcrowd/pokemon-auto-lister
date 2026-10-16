/**
 * One-shot consumer scan: download models if needed, then scan a real lot photo.
 * Not part of the default Playwright run. Profile is reused so the download happens once.
 *
 *   node tests/e2e/live-scan.mjs [photo.jpg]
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearStaleServiceWorker } from '../../scripts/lib/profile-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extPath = path.join(root, 'dist', 'extension-wasm');
const photoPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'data', 'detect-marketplace', 'goodwill', '279630564', '00.jpg');
const profile = path.join(root, 'data', 'extension-live-profile');
// SCAN_ERA=ex-dp picks that era in the popup before scanning (ids in lib/era.js).
const scanEra = process.env.SCAN_ERA || '';
const reportName = process.argv[2]
  ? `extension-live-scan-${path.basename(path.dirname(photoPath))}-${path.parse(photoPath).name}${scanEra ? `-${scanEra}` : ''}.json`
  : 'extension-live-scan.json';
const reportPath = path.join(root, 'data', reportName);

// LOCAL_OCR=1 puts the unreleased number-reader models (RapidOCR in the Python venv)
// into the extension's model cache, as if downloaded from release v2.2.
const localOcr = process.env.LOCAL_OCR === '1';
const ocrModels = {
  'ocr_det.onnx': 'ch_PP-OCRv4_det_infer.onnx',
  'ocr_rec.onnx': 'ch_PP-OCRv4_rec_infer.onnx',
};
const ocrDir = path.join(root, 'tools', 'vellum-ai', '.venv312', 'Lib', 'site-packages', 'rapidocr_onnxruntime', 'models');

const photo = fs.readFileSync(photoPath);
const server = http.createServer((req, res) => {
  const ocrName = req.url.match(/^\/models\/(ocr_(?:det|rec)\.onnx)$/)?.[1];
  if (localOcr && ocrName) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' });
    fs.createReadStream(path.join(ocrDir, ocrModels[ocrName])).pipe(res);
    return;
  }
  if (req.url.startsWith('/card.jpg')) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': photo.length });
    res.end(photo);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>lot</title>
    <body style="margin:0;background:#111">
      <img alt="pokemon card lot" src="/card.jpg" style="width:100vw;height:100vh;object-fit:contain">
    </body>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const logs = [];

clearStaleServiceWorker(root, profile);

const launch = () => chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 900, height: 1200 },
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    '--no-sandbox',
  ],
});
const isExtensionWorker = (w) => w.url().startsWith('chrome-extension://');
const extensionWorker = async (ctx) => ctx.serviceWorkers().find(isExtensionWorker)
  || ctx.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout: 20_000 });

// Seeded in a browser of its own: the extension loads the reader only at startup.
if (localOcr) {
  const seeding = await launch();
  try {
    const added = await (await extensionWorker(seeding)).evaluate(async ({ port, names }) => {
      const cache = await caches.open('cardscanner-models-v2.1');
      let count = 0;
      for (const name of names) {
        const url = `https://github.com/fabcrowd/pokemon-auto-lister/releases/download/v2.2/${name}`;
        if (await cache.match(url)) continue;
        const response = await fetch(`http://127.0.0.1:${port}/models/${name}`);
        await cache.put(url, new Response(await response.arrayBuffer()));
        count++;
      }
      return count;
    }, { port, names: Object.keys(ocrModels) });
    console.log('number reader files added to cache:', added);
  } finally {
    await seeding.close();
  }
}

const context = await launch();

function note(worker) {
  worker.on('console', (msg) => {
    const line = `[sw] ${msg.type()} ${msg.text()}`;
    logs.push(line);
    console.log(line);
  });
}
context.serviceWorkers().forEach(note);
context.on('serviceworker', note);

try {

const worker = await extensionWorker(context);
const extensionId = new URL(worker.url()).hostname;

const listing = await context.newPage();
await listing.goto(`http://127.0.0.1:${port}/lot`);
await listing.waitForFunction(() => {
  const img = document.querySelector('img');
  return img && img.complete && img.naturalWidth > 0;
});
const layout = await listing.evaluate(() => {
  const img = document.querySelector('img');
  const r = img.getBoundingClientRect();
  return { natural: [img.naturalWidth, img.naturalHeight], box: [Math.round(r.width), Math.round(r.height)] };
});
console.log('photo layout', JSON.stringify(layout));
await listing.screenshot({ path: path.join(root, 'data', reportName.replace('-scan', '-listing').replace('.json', '.png')) });

const popup = await context.newPage();
const errors = [];
popup.on('pageerror', (err) => errors.push(err.message));
popup.on('console', (msg) => {
  if (msg.type() === 'error') logs.push(`[popup] ${msg.text()}`);
});
await popup.goto(`chrome-extension://${extensionId}/popup.html`);
await popup.waitForFunction(() => {
  const text = document.getElementById('mtext')?.textContent || '';
  return text && !text.includes('checking');
});

const overlay = popup.locator('#setup-overlay');
if (await overlay.isVisible() && await popup.locator('#btn-setup').isVisible()) {
  console.log('downloading models…');
  await popup.locator('#btn-setup').click();
  await popup.waitForFunction(() => {
    const status = document.getElementById('mtext')?.textContent || '';
    const setup = document.getElementById('setup-status')?.textContent || '';
    return status.includes('AI ready') || setup.includes('download stopped');
  }, null, { timeout: 8 * 60_000 });
}

if (await popup.locator('#btn-wiz-skip').isVisible()) {
  await popup.locator('#btn-wiz-skip').click();
}

const scanEnabled = await popup.locator('#btn-scan').isEnabled();
console.log('scan enabled', scanEnabled, 'status', await popup.locator('#mtext').textContent(), 'setup', await popup.locator('#setup-status').textContent());
await popup.close();
await listing.bringToFront();

const scannerPromise = context.waitForEvent('page', {
  predicate: (page) => page.url().includes('/popup.html'),
  timeout: 15_000,
});
await worker.evaluate(async () => {
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 500,
    height: 720,
    focused: false,
  });
});
const scanner = await scannerPromise;
await scanner.waitForFunction(() => {
  const text = document.getElementById('mtext')?.textContent || '';
  return text && !text.includes('checking');
});
if (await scanner.locator('#btn-wiz-skip').isVisible()) {
  await scanner.locator('#btn-wiz-skip').click();
}

if (!(await scanner.locator('#btn-scan').isEnabled())) {
  const blocked = await scanner.locator('#setup-status').textContent();
  console.log('scan stayed disabled', blocked);
  fs.writeFileSync(reportPath, JSON.stringify({ blocked, logs: logs.slice(-40) }, null, 2));
  throw new Error('scan stayed disabled: ' + blocked);
}
await scanner.locator('#era-select').selectOption(scanEra);
const scanStarted = Date.now();
await scanner.locator('#btn-scan').click();
await scanner.waitForFunction(() => {
  const msg = document.getElementById('msg-bar')?.textContent || '';
  const label = document.getElementById('btn-label')?.textContent || '';
  return label === 'SCAN PAGE' && msg.length > 0 && !msg.startsWith('Capturing');
}, null, { timeout: 4 * 60_000 });

const outcome = await scanner.evaluate(() => ({
  message: document.getElementById('msg-bar')?.textContent || '',
  detected: document.getElementById('s-detected')?.textContent || '',
  total: document.getElementById('s-value')?.textContent || '',
  ms: document.getElementById('s-ms')?.textContent || '',
  results: document.getElementById('results')?.innerText?.slice(0, 6000) || '',
  scanDisabled: document.getElementById('btn-scan').disabled,
}));
const elapsedMs = Date.now() - scanStarted;

// Pick the second set on the first "set not sure" card and wait for its price.
let setPick = null;
const setSelect = scanner.locator('.set-select-row select').first();
if (await setSelect.count()) {
  const option = await setSelect.locator('option').nth(2).getAttribute('value');
  const row = setSelect.locator('xpath=ancestor::div[contains(@class,"card-row")]');
  const before = { total: await scanner.locator('#s-value').textContent(), row: await row.innerText() };
  await setSelect.selectOption(option);
  await scanner.waitForFunction(() => !document.querySelector('.set-select-row select[disabled]'), null, { timeout: 60_000 });
  setPick = {
    option,
    before,
    after: {
      total: await scanner.locator('#s-value').textContent(),
      row: await scanner.locator('.card-row', { has: scanner.locator(`option[value="${option}"]:checked`) }).innerText(),
    },
  };
  console.log('set pick', JSON.stringify(setPick, null, 2));
}

const report = {
  elapsedMs,
  scanEnabled,
  layout,
  errors,
  outcome,
  setPick,
  logs: logs.slice(-80),
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ elapsedMs, scanEnabled, outcome }, null, 2));
} finally {
  await context.close().catch(() => {});
  server.close();
}
