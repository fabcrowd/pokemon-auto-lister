import { chromium } from '@playwright/test';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '../../tools/extension-wasm');
const PORT = 8767;

function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = 30; raw[i + 1] = 80; raw[i + 2] = 160;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const html = `<!doctype html><meta charset="utf-8"><title>labels</title>
<style>
  body { margin: 0; background: #12141c; color: #ddd; font: 14px system-ui; }
  .row { display: flex; gap: 40px; padding: 48px; }
  img { display: block; border: 2px solid #ff2bd6; box-sizing: border-box; background: #234; }
  #wide { width: 200px; height: 280px; }
  #narrow { width: 110px; height: 154px; }
</style>
<body>
<p>Wide is 200px (over 140). Narrow is 110px.</p>
<div class="row">
  <img id="wide" alt="wide" src="/card.png">
  <img id="narrow" alt="narrow" src="/card.png">
</div>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/card.png')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png(63, 88));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const context = await chromium.launchPersistentContext(path.join(__dirname, `label-profile-${Date.now()}`), {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--enable-unsafe-extension-debugging',
  ],
});
try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const tabId = await worker.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.includes(`127.0.0.1:${port}`));
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return tab.id;
  }, PORT);
  const send = (msg) => worker.evaluate(async ({ tabId: id, msg: message }) => chrome.tabs.sendMessage(id, message).catch((e) => String(e)), { tabId, msg });
  await send({ action: 'findCards' });
  const rects = await page.evaluate(() => ['wide', 'narrow'].map((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { id, box: [r.left, r.top, r.right, r.bottom], w: r.width };
  }));
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const card = (box) => ({
    box,
    identity: { name: 'Charizard VMAX Rainbow Rare' },
    confidence: 0.93,
    abstain: false,
    market_price: 420.5,
    display: { price: 420.5, name: 'Charizard VMAX Rainbow Rare' },
  });
  await send({ action: 'showOverlay', cards: rects.map((r) => card(r.box)), srcWidth: view.w, srcHeight: view.h });
  await page.waitForTimeout(200);
  const wide = rects[0].box;
  await page.mouse.move((wide[0] + wide[2]) / 2, (wide[1] + wide[3]) / 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'overlay-wide-hover.png') });
  await send({ action: 'highlightCard', index: 0, scroll: false });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(__dirname, 'overlay-wide-highlight.png') });
  await page.mouse.move(8, 8);
  await page.waitForTimeout(200);
  await send({ action: 'highlightCard', index: 1, scroll: false });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(__dirname, 'overlay-narrow-highlight.png') });
  console.log(JSON.stringify(rects));
} finally {
  server.close();
  await context.close();
}
