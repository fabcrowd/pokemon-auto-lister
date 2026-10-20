/**
 * Headed smoke of the working-tree extension. Does not modify product code.
 * Evidence: tasks/qa-smoke/*.png and evidence.json
 */
import { chromium } from '@playwright/test';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const EXT = path.resolve(ROOT, 'tools/extension-wasm');
const OUT = __dirname;
const PORT = 8766;

const evidence = {
  startedAt: new Date().toISOString(),
  extensionPath: EXT,
  headed: true,
  flows: [],
  console: { popup: [], options: [], serviceWorker: [], fixture: [] },
  measurements: {},
  notes: [],
};

function log(msg) {
  console.log(`[qa] ${msg}`);
}

function flow(name, status, screenshot, detail) {
  evidence.flows.push({ name, status, screenshot: screenshot || '', detail: detail || '' });
  log(`${status.toUpperCase()} ${name} ${detail || ''}`);
}

function attachConsole(page, bucket) {
  page.on('pageerror', (err) => {
    bucket.push({
      kind: 'pageerror',
      url: page.url(),
      text: err.message,
      stack: String(err.stack || '').slice(0, 500),
    });
  });
  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    bucket.push({
      kind: type,
      url: page.url(),
      text: msg.text(),
      location: msg.location(),
    });
  });
}

function png(w, h, r, g, b) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      raw[i] = (x + y) % 40 < 4 ? 255 : r;
      raw[i + 1] = g;
      raw[i + 2] = (y % 20 < 2) ? 255 : b;
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CARD_PNG = png(63, 88, 40, 90, 160);

const FIXTURE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>card fixture</title>
<style>
  html, body { margin: 0; background: #12141c; color: #d5d8e6; font-family: system-ui, sans-serif; }
  h1 { margin: 0; padding: 16px 24px 8px; font-size: 16px; }
  p { margin: 0; padding: 0 24px 12px; color: #8b90a8; font-size: 13px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 22vw);
    gap: 24px;
    padding: 12px 32px 48px;
    align-items: start;
  }
  .card img {
    width: 100%;
    aspect-ratio: 63 / 88;
    height: auto;
    display: block;
    background: #222;
    border: 2px solid #ff2bd6;
    box-sizing: border-box;
  }
  .tail { height: 1100px; padding: 24px 32px; }
  .narrow-wrap { padding: 32px; }
  .narrow-wrap img {
    width: 110px;
    height: 154px;
    display: block;
    border: 2px solid #ff2bd6;
    box-sizing: border-box;
    background: #222;
  }
</style>
</head>
<body>
  <h1 id="title">Three card fixture</h1>
  <p>Magenta border is the card edge. Overlay corners should sit on that edge.</p>
  <div class="grid" id="grid">
    <div class="card"><img id="c0" alt="card zero" src="/card.png"></div>
    <div class="card"><img id="c1" alt="card one" src="/card.png"></div>
    <div class="card"><img id="c2" alt="card two" src="/card.png"></div>
  </div>
  <div class="tail" id="tail">Scroll space so the cards can leave the viewport.</div>
  <div class="narrow-wrap">
    <p>Narrow card, fixed 110px wide (under 140).</p>
    <img id="cn" alt="narrow card" src="/card.png">
  </div>
</body>
</html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/card.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(CARD_PNG);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  return name;
}

async function shotFull(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: true });
  return name;
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const clipped = [];
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && el.clientWidth < 2000) {
        clipped.push({
          id: el.id || '',
          tag: el.tagName,
          className: String(el.className).slice(0, 80),
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').slice(0, 80),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    }
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowX: doc.scrollWidth - doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      clipped: clipped.slice(0, 25),
    };
  });
}

function grid(nm) {
  return { source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm, LP: nm * 0.85 } } } };
}

function resultCards() {
  const priced = {
    identity: { id: 'base1-4', name: 'Charizard', set: 'Base', setCode: 'base1', number: '4' },
    confidence: 0.93,
    abstain: false,
    market_price: 420,
    price_grid: grid(420),
    box: [0, 0, 1, 1],
  };
  const noPrice = {
    identity: { id: 'base1-2', name: 'Blastoise', set: 'Base', setCode: 'base1', number: '2' },
    confidence: 0.88,
    abstain: false,
    market_price: null,
    box: [0, 0, 1, 1],
  };
  const unsure = {
    identity: { id: 'base1-15', name: 'Zapdos', set: 'Base', setCode: 'base1', number: '15' },
    confidence: 0.42,
    abstain: false,
    unsure: true,
    lowCertainty: true,
    market_price: null,
    candidates: [
      { id: 'base1-15', name: 'Zapdos', set: 'Base', setCode: 'base1', number: '15' },
      { id: 'base1-16', name: 'Raichu', set: 'Base', setCode: 'base1', number: '16' },
    ],
    box: [0, 0, 1, 1],
  };
  const fillers = Array.from({ length: 8 }, (_, i) => ({
    identity: {
      id: `sv1-${i + 10}`,
      name: `Longname Card ${i + 1} Illustration Rare`,
      set: 'Scarlet & Violet',
      setCode: 'sv1',
      number: String(i + 10),
    },
    confidence: 0.91,
    abstain: false,
    market_price: 3.5 + i,
    price_grid: grid(3.5 + i),
    box: [0, 0, 1, 1],
  }));
  return [priced, noPrice, unsure, ...fillers];
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const profile = path.join(OUT, `chrome-profile-${Date.now()}`);
  let context;
  let leaveOpen = false;
  try {
    log('launching chromium');
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      viewport: { width: 1100, height: 800 },
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        '--enable-unsafe-extension-debugging',
        '--no-sandbox',
      ],
    });
    evidence.chromium = context.browser().version();

    const attachWorker = (worker) => {
      worker.on('console', (msg) => {
        const type = msg.type();
        if (type !== 'error' && type !== 'warning') return;
        evidence.console.serviceWorker.push({
          kind: type,
          url: worker.url(),
          text: msg.text(),
          location: msg.location(),
        });
      });
      worker.on('pageerror', (err) => {
        evidence.console.serviceWorker.push({
          kind: 'pageerror',
          url: worker.url(),
          text: err.message,
        });
      });
    };
    context.on('serviceworker', attachWorker);
    for (const worker of context.serviceWorkers()) attachWorker(worker);

    let worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', {
        predicate: (w) => w.url().startsWith('chrome-extension://'),
        timeout: 20000,
      });
    }
    const extensionId = new URL(worker.url()).hostname;
    evidence.extensionId = extensionId;
    log(`extension ${extensionId} chromium ${evidence.chromium}`);

    const popup = await context.newPage();
    attachConsole(popup, evidence.console.popup);
    await popup.setViewportSize({ width: 420, height: 640 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.waitForFunction(() => {
      const overlay = document.getElementById('setup-overlay');
      const scan = document.getElementById('btn-scan');
      if (!overlay || !scan) return false;
      const shown = getComputedStyle(overlay).display !== 'none';
      return shown || scan.disabled === false;
    }, { timeout: 20000 }).catch(() => {});
    await popup.waitForTimeout(400);

    const initial = await popup.evaluate(() => {
      const overlay = document.getElementById('setup-overlay');
      const step = [...document.querySelectorAll('.wiz-section')].find((el) => el.classList.contains('active'));
      const scan = document.getElementById('btn-scan');
      const hint = document.getElementById('empty-hint');
      return {
        logo: document.querySelector('.logo')?.innerText?.replace(/\s+/g, ' ').trim(),
        scanLabel: document.getElementById('btn-label')?.textContent,
        scanDisabled: scan?.disabled,
        overlayDisplay: getComputedStyle(overlay).display,
        overlayText: overlay?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 400),
        activeStep: step?.id || null,
        hintText: hint?.innerText?.replace(/\s+/g, ' ').trim(),
        hintInDom: Boolean(hint),
        eraOptions: [...document.getElementById('era-select').options].map((o) => ({ value: o.value, label: o.label })),
        eraValue: document.getElementById('era-select').value,
        controls: {
          scan: Boolean(document.getElementById('btn-scan')),
          clear: Boolean(document.getElementById('btn-clear')),
          era: Boolean(document.getElementById('era-select')),
          options: Boolean(document.getElementById('open-options')),
          setup: Boolean(document.getElementById('setup-overlay')),
          step1: Boolean(document.getElementById('wiz-step-1')),
          stepAccess: Boolean(document.getElementById('wiz-step-access')),
          step2: Boolean(document.getElementById('wiz-step-2')),
          access: Boolean(document.getElementById('access-notice')),
          results: Boolean(document.getElementById('results')),
          hint: Boolean(document.getElementById('empty-hint')),
          msg: Boolean(document.getElementById('msg-bar')),
          exam: Boolean(document.getElementById('exam-strip')),
          download: Boolean(document.getElementById('btn-setup')),
          notNow: Boolean(document.getElementById('btn-wiz-access-skip')),
          later: Boolean(document.getElementById('btn-wiz-skip')),
        },
      };
    });
    evidence.measurements.popupInitial = initial;
    evidence.measurements.popupOverflowInitial = await overflow(popup);
    const emptyShot = await shot(popup, 'popup-empty.png');
    const scanMatchesWizard = (initial.overlayDisplay !== 'none') === initial.scanDisabled;
    flow(
      'popup initial paint',
      scanMatchesWizard && initial.scanLabel === 'SCAN PAGE' && initial.logo?.includes('Card Scanner') ? 'pass' : 'fail',
      emptyShot,
      `logo="${initial.logo}" scan="${initial.scanLabel}" disabled=${initial.scanDisabled} wizard=${initial.overlayDisplay} step=${initial.activeStep} match=${scanMatchesWizard}`,
    );

    // Covered controls: try a real click on CLEAR while the wizard is up.
    let clearBlocked = false;
    if (initial.overlayDisplay !== 'none') {
      try {
        await popup.locator('#btn-clear').click({ timeout: 1500 });
      } catch (err) {
        clearBlocked = true;
        evidence.notes.push(`CLEAR click while wizard visible: ${err.message.split('\n')[0]}`);
      }
      await shot(popup, 'popup-clear-while-wizard.png');
      flow(
        'popup CLEAR on empty while wizard covers it',
        'blocked',
        'popup-clear-while-wizard.png',
        clearBlocked
          ? 'Wizard covers CLEAR. Click did not land. Download was not pressed.'
          : 'CLEAR received a click while the wizard was visible.',
      );
    }

    // Reach Skip / Not now without downloading: tell only the popup that models are ready.
    await context.addInitScript(() => {
      if (!location.pathname.endsWith('/popup.html')) return;
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__qaHighlights = [];
      chrome.runtime.sendMessage = async (msg) => {
        if (typeof window.__qaSend === 'function') return window.__qaSend(msg, real);
        if (msg && msg.action === 'checkReady') return { ready: true };
        return real(msg);
      };
    });
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.waitForTimeout(500);
    const afterReadyStub = await popup.evaluate(() => {
      const step = [...document.querySelectorAll('.wiz-section')].find((el) => el.classList.contains('active'));
      const overlay = document.getElementById('setup-overlay');
      return {
        activeStep: step?.id || null,
        overlayDisplay: getComputedStyle(overlay).display,
        text: step?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 300) || '',
        scanDisabled: document.getElementById('btn-scan').disabled,
      };
    });
    evidence.measurements.wizardAfterReadyStub = afterReadyStub;
    await shot(popup, 'popup-wizard-after-ready-stub.png');

    if (afterReadyStub.activeStep === 'wiz-step-access') {
      const beforeErrors = evidence.console.popup.length;
      await popup.locator('#btn-wiz-access-skip').click();
      await popup.waitForTimeout(400);
      const next = await popup.evaluate(() => {
        const step = [...document.querySelectorAll('.wiz-section')].find((el) => el.classList.contains('active'));
        return { activeStep: step?.id || null, overlay: getComputedStyle(document.getElementById('setup-overlay')).display };
      });
      await shot(popup, 'popup-wizard-not-now.png');
      const threw = evidence.console.popup.slice(beforeErrors).some((e) => e.kind === 'pageerror');
      flow('wizard Not now', threw ? 'fail' : 'pass', 'popup-wizard-not-now.png', JSON.stringify(next));
    } else {
      flow(
        'wizard Not now',
        'blocked',
        'popup-wizard-after-ready-stub.png',
        `Access step not shown after checkReady stub. active=${afterReadyStub.activeStep} overlay=${afterReadyStub.overlayDisplay}. Dev host permission may already include <all_urls>, so the access step is skipped. Download was not clicked.`,
      );
    }

    const stepNow = await popup.evaluate(() => {
      const step = [...document.querySelectorAll('.wiz-section')].find((el) => el.classList.contains('active'));
      return step?.id || null;
    });
    if (stepNow === 'wiz-step-2') {
      await shot(popup, 'popup-wizard-step2.png');
      const beforeErrors = evidence.console.popup.length;
      await popup.locator('#btn-wiz-skip').click();
      await popup.waitForTimeout(400);
      const hidden = await popup.evaluate(() => getComputedStyle(document.getElementById('setup-overlay')).display);
      await shot(popup, 'popup-wizard-later.png');
      const threw = evidence.console.popup.slice(beforeErrors).some((e) => e.kind === 'pageerror');
      flow('wizard I will do this later', threw || hidden !== 'none' ? 'fail' : 'pass', 'popup-wizard-later.png', `overlay display=${hidden}`);
    } else if (afterReadyStub.overlayDisplay === 'none') {
      flow('wizard I will do this later', 'blocked', 'popup-wizard-after-ready-stub.png', 'Wizard already hidden; later button was not on screen.');
    } else {
      flow('wizard I will do this later', 'blocked', 'popup-wizard-after-ready-stub.png', `Visible step is ${stepNow}, not the price-key step.`);
    }

    // Era picker
    await popup.locator('#era-select').focus();
    await popup.keyboard.press('Alt+ArrowDown');
    await popup.waitForTimeout(400);
    const eraOpen = await shot(popup, 'popup-era-open.png');
    await popup.keyboard.press('Escape');
    await popup.locator('#era-select').selectOption('wotc');
    await popup.waitForTimeout(200);
    const eraAfter = await popup.evaluate(async () => {
      const sel = document.getElementById('era-select');
      const stored = await new Promise((resolve) => chrome.storage.local.get('scanEra', (v) => resolve(v.scanEra ?? null)));
      const opt = sel.selectedOptions[0];
      const rect = sel.getBoundingClientRect();
      return {
        value: sel.value,
        label: opt?.label,
        stored,
        rect: { w: rect.width, h: rect.height, right: rect.right },
      };
    });
    evidence.measurements.era = eraAfter;
    const eraShot = await shot(popup, 'popup-era-selected.png');
    flow(
      'era picker choose non-default',
      eraAfter.value === 'wotc' && eraAfter.stored === 'wotc' ? 'pass' : 'fail',
      `${eraOpen}, ${eraShot}`,
      JSON.stringify(eraAfter),
    );

    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.waitForTimeout(400);
    const eraStuck = await popup.evaluate(() => document.getElementById('era-select').value);
    await shot(popup, 'popup-era-after-reload.png');
    flow('era picker sticks after reload', eraStuck === 'wotc' ? 'pass' : 'fail', 'popup-era-after-reload.png', `value=${eraStuck}`);

    // CLEAR on empty
    const beforeClear = evidence.console.popup.length;
    await popup.locator('#btn-clear').click();
    await popup.waitForTimeout(200);
    const afterClear = await popup.evaluate(() => ({
      hint: document.getElementById('empty-hint')?.innerText?.replace(/\s+/g, ' ').trim(),
      hintVisible: (() => {
        const el = document.getElementById('empty-hint');
        if (!el) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      })(),
      msg: document.getElementById('msg-bar')?.textContent,
      value: document.getElementById('s-value')?.textContent,
    }));
    const clearShot = await shot(popup, 'popup-clear-empty.png');
    const clearThrew = evidence.console.popup.slice(beforeClear).some((e) => e.kind === 'pageerror');
    flow(
      'CLEAR on empty state',
      !clearThrew && afterClear.hintVisible ? 'pass' : 'fail',
      clearShot,
      JSON.stringify(afterClear),
    );

    // Injected results through the real scan click handler.
    await popup.evaluate((cards) => {
      window.__qaScan = {
        cards,
        scanId: 'qa-scan',
        srcWidth: 10,
        srcHeight: 10,
        pending: 0,
        shareExam: true,
      };
      window.__qaHighlights = [];
      window.__qaSend = async (msg, real) => {
        if (msg?.action === 'scanPage') return window.__qaScan;
        if (msg?.action === 'highlightCard') {
          window.__qaHighlights.push(msg);
          return { ok: true };
        }
        if (msg?.action === 'clearPageOverlay' || msg?.action === 'overlayWithGrid') return { ok: true };
        return real(msg);
      };
    }, resultCards());
    const beforeScan = evidence.console.popup.length;
    await popup.locator('#btn-scan').click();
    await popup.waitForTimeout(600);
    const rendered = await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('.card-row')];
      const results = document.getElementById('results');
      return {
        rowCount: rows.length,
        names: rows.slice(0, 6).map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 120)),
        hintPresent: Boolean(document.getElementById('empty-hint')),
        msg: document.getElementById('msg-bar')?.innerText,
        examHidden: document.getElementById('exam-strip').hidden,
        value: document.getElementById('s-value')?.textContent,
        scroll: results.scrollHeight > results.clientHeight + 4,
        scrollHeight: results.scrollHeight,
        clientHeight: results.clientHeight,
        scanLabel: document.getElementById('btn-label')?.textContent,
        prices: [...document.querySelectorAll('.card-price')].slice(0, 4).map((el) => el.textContent),
      };
    });
    evidence.measurements.results = rendered;
    evidence.measurements.popupOverflowResults = await overflow(popup);
    const resultsShot = await shot(popup, 'popup-results.png');
    const scanThrew = evidence.console.popup.slice(beforeScan).some((e) => e.kind === 'pageerror');
    flow(
      'injected results: priced, no price, unsure, scroll',
      !scanThrew && rendered.rowCount >= 4 && rendered.scroll ? 'pass' : 'fail',
      resultsShot,
      JSON.stringify(rendered),
    );

    await popup.locator('#results').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await popup.waitForTimeout(200);
    await shot(popup, 'popup-results-scrolled.png');
    flow('results list scrolls', 'pass', 'popup-results-scrolled.png', `scrollHeight=${rendered.scrollHeight} client=${rendered.clientHeight}`);

    await popup.locator('.card-row').first().hover();
    await popup.waitForTimeout(200);
    const hover = await popup.evaluate(() => window.__qaHighlights);
    await shot(popup, 'popup-row-hover.png');
    flow(
      'hover row sends highlight',
      Array.isArray(hover) && hover.length > 0 ? 'pass' : 'fail',
      'popup-row-hover.png',
      JSON.stringify(hover),
    );

    // Exam strip: dismiss, then scan again and press All right (real background).
    if (!rendered.examHidden) {
      await shot(popup, 'popup-exam-strip.png');
      const beforeDismiss = evidence.console.popup.length;
      await popup.locator('#exam-dismiss').click();
      await popup.waitForTimeout(200);
      const dismissed = await popup.evaluate(() => document.getElementById('exam-strip').hidden);
      const dismissThrew = evidence.console.popup.slice(beforeDismiss).some((e) => e.kind === 'pageerror');
      flow('exam dismiss', !dismissThrew && dismissed ? 'pass' : 'fail', 'popup-exam-strip.png', `hidden=${dismissed}`);

      await popup.locator('#btn-scan').click();
      await popup.waitForTimeout(400);
      const beforeYes = evidence.console.popup.length;
      await popup.locator('#exam-yes').click();
      await popup.waitForTimeout(800);
      const yesState = await popup.evaluate(() => ({
        hidden: document.getElementById('exam-strip').hidden,
        msg: document.getElementById('msg-bar')?.innerText,
      }));
      await shot(popup, 'popup-exam-yes.png');
      const yesThrew = evidence.console.popup.slice(beforeYes).some((e) => e.kind === 'pageerror');
      flow('exam All right', yesThrew ? 'fail' : 'pass', 'popup-exam-yes.png', JSON.stringify(yesState));
    } else {
      flow('exam strip', 'fail', resultsShot, 'shareExam true did not show #exam-strip');
    }

    // CLEAR returns the empty hint
    const beforeClear2 = evidence.console.popup.length;
    await popup.locator('#btn-clear').click();
    await popup.waitForTimeout(300);
    const cleared = await popup.evaluate(() => ({
      hint: document.getElementById('empty-hint')?.innerText?.replace(/\s+/g, ' ').trim() || null,
      rows: document.querySelectorAll('.card-row').length,
      value: document.getElementById('s-value')?.textContent,
      examHidden: document.getElementById('exam-strip').hidden,
    }));
    const clearedShot = await shot(popup, 'popup-cleared.png');
    const clear2Threw = evidence.console.popup.slice(beforeClear2).some((e) => e.kind === 'pageerror');
    flow(
      'CLEAR after results restores empty hint',
      !clear2Threw && cleared.rows === 0 && cleared.hint ? 'pass' : 'fail',
      clearedShot,
      JSON.stringify(cleared),
    );

    // Access notice. Dev manifest ships <all_urls>, so force contains() false only for this click.
    await popup.evaluate(() => {
      window.__qaScan = {
        cards: [],
        scanId: 'qa-access',
        srcWidth: 10,
        srcHeight: 10,
        pending: 0,
        usedScreenshotPath: true,
        reason: 'no-site-access',
      };
      const orig = chrome.permissions.contains.bind(chrome.permissions);
      chrome.permissions.contains = async (perm) => {
        if (perm?.origins?.includes('<all_urls>')) return false;
        return orig(perm);
      };
    });
    await popup.evaluate(() => chrome.storage.local.remove('siteAccessDismissedAt'));
    await popup.locator('#btn-scan').click();
    await popup.waitForTimeout(500);
    const notice = await popup.evaluate(() => {
      const el = document.getElementById('access-notice');
      return { hidden: el.hidden, text: el.innerText.replace(/\s+/g, ' ').trim() };
    });
    const noticeShot = await shot(popup, 'popup-access-notice.png');
    if (!notice.hidden) {
      const beforeSkip = evidence.console.popup.length;
      await popup.locator('#access-skip').click();
      await popup.waitForTimeout(200);
      const skipped = await popup.evaluate(() => document.getElementById('access-notice').hidden);
      const skipThrew = evidence.console.popup.slice(beforeSkip).some((e) => e.kind === 'pageerror');
      await shot(popup, 'popup-access-skipped.png');
      flow('access notice Not now', !skipThrew && skipped ? 'pass' : 'fail', noticeShot, notice.text);
      evidence.notes.push('Allow was not clicked. It calls chrome.permissions.request and can raise a browser permission prompt. Not now was clicked instead.');
    } else {
      flow('access notice', 'blocked', noticeShot, `Notice stayed hidden. ${notice.text}`);
    }

    // Options via the gear.
    const optionsPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await popup.locator('#open-options').click();
    let options = await optionsPromise;
    if (!options) {
      options = context.pages().find((p) => p.url().includes('options.html')) || null;
    }
    if (!options) {
      options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      evidence.notes.push('open-options did not open a page within 8s; options.html was opened directly.');
    }
    attachConsole(options, evidence.console.options);
    await options.setViewportSize({ width: 1100, height: 800 });
    await options.waitForLoadState('domcontentloaded');
    await options.waitForFunction(() => {
      const t = document.getElementById('corrections-count')?.textContent || '';
      const p = document.getElementById('test-photos-count')?.textContent || '';
      return t && !t.includes('…') && p && !p.includes('…');
    }, { timeout: 10000 }).catch(() => {});
    await options.waitForTimeout(800);
    evidence.measurements.optionsOverflow1100 = await overflow(options);
    const optionsInitial = await shotFull(options, 'options-initial.png');
    const optionsState = await options.evaluate(() => ({
      title: document.querySelector('h1')?.textContent,
      ppt: document.getElementById('ppt-status')?.textContent,
      condition: document.getElementById('price-condition')?.value,
      psa: document.getElementById('graded-PSA')?.checked,
      site: document.getElementById('site-access')?.checked,
      siteStatus: document.getElementById('site-access-status')?.textContent,
      lookalikeDisabled: document.getElementById('reduce-lookalikes')?.disabled,
      lookalikeChecked: document.getElementById('reduce-lookalikes')?.checked,
      lookalikeNote: document.getElementById('lookalike-note')?.textContent,
      shareDisabled: document.getElementById('share-optin')?.disabled,
      shareChecked: document.getElementById('share-optin')?.checked,
      shareStatus: document.getElementById('share-status')?.textContent,
      corrections: document.getElementById('corrections-count')?.textContent,
      references: document.getElementById('references-count')?.textContent,
      photos: document.getElementById('test-photos-count')?.textContent,
      exportCorrectionsDisabled: document.getElementById('export-corrections')?.disabled,
      exportPhotosDisabled: document.getElementById('export-test-photos')?.disabled,
      clearCorrectionsDisabled: document.getElementById('clear-corrections')?.disabled,
      clearPhotosDisabled: document.getElementById('clear-test-photos')?.disabled,
      backend: document.getElementById('backend-status')?.textContent,
      backendDetail: document.getElementById('backend-detail')?.innerText,
      backendOpen: document.getElementById('advanced-backend')?.open,
    }));
    evidence.measurements.optionsInitial = optionsState;
    flow('options initial 1100x800', options.url().includes('options.html') ? 'pass' : 'fail', optionsInitial, JSON.stringify(optionsState));

    await options.setViewportSize({ width: 480, height: 700 });
    await options.waitForTimeout(300);
    evidence.measurements.optionsOverflow480 = await overflow(options);
    const options480 = await shotFull(options, 'options-480.png');
    flow(
      'options 480x700 overflow',
      evidence.measurements.optionsOverflow480.overflowX > 1 ? 'fail' : 'pass',
      options480,
      `scrollWidth=${evidence.measurements.optionsOverflow480.scrollWidth} clientWidth=${evidence.measurements.optionsOverflow480.clientWidth}`,
    );
    await shot(options, 'options-480-viewport.png');

    await options.setViewportSize({ width: 1100, height: 800 });
    await options.locator('#price-condition').selectOption('LP');
    await options.waitForTimeout(200);
    const beforePsa = evidence.console.options.length;
    await options.locator('#graded-PSA').click();
    await options.waitForTimeout(200);
    const psaOn = await options.evaluate(() => document.getElementById('graded-PSA').checked);
    await shot(options, 'options-psa-on.png');
    await options.locator('#graded-PSA').click();
    await options.waitForTimeout(200);
    const priceState = await options.evaluate(async () => {
      const stored = await chrome.storage.sync.get('filters');
      return {
        condition: document.getElementById('price-condition').value,
        psa: document.getElementById('graded-PSA').checked,
        stored: stored.filters || null,
      };
    });
    await shot(options, 'options-psa-off.png');
    const psaThrew = evidence.console.options.slice(beforePsa).some((e) => e.kind === 'pageerror');
    flow(
      'price condition LP and PSA on/off',
      !psaThrew && priceState.condition === 'LP' && priceState.psa === false && psaOn === true ? 'pass' : 'fail',
      'options-psa-off.png',
      JSON.stringify(priceState),
    );

    // Site access: only toggle toward off (permissions.remove). Do not request.
    const siteBefore = await options.evaluate(() => ({
      checked: document.getElementById('site-access').checked,
      status: document.getElementById('site-access-status').textContent,
    }));
    if (siteBefore.checked) {
      const toggle = options.locator('#site-access').click({ timeout: 4000 }).then(() => 'clicked').catch((err) => `error:${err.message.split('\n')[0]}`);
      const result = await Promise.race([
        toggle,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
      ]);
      if (result === 'timeout') {
        leaveOpen = true;
        await shot(options, 'options-permission-dialog.png');
        flow('site-access toggle', 'blocked', 'options-permission-dialog.png', 'Toggle did not settle in 4s. Left the browser open in case a permission prompt is showing.');
      } else {
        await options.waitForTimeout(300);
        const siteAfter = await options.evaluate(() => ({
          checked: document.getElementById('site-access').checked,
          status: document.getElementById('site-access-status').textContent,
          note: document.getElementById('site-access-note').textContent,
        }));
        await shot(options, 'options-site-access.png');
        const siteThrew = evidence.console.options.some((e) => e.kind === 'pageerror' && e.text && e.url.includes('options'));
        flow('site-access toggle off', siteThrew ? 'fail' : 'pass', 'options-site-access.png', `${result} ${JSON.stringify(siteBefore)} -> ${JSON.stringify(siteAfter)}`);
      }
    } else {
      await shot(options, 'options-site-access.png');
      flow('site-access toggle', 'blocked', 'options-site-access.png', 'Toggle is off. Turning it on calls permissions.request. Left it off to avoid a permission prompt.');
    }

    const beforeSave = evidence.console.options.length;
    await options.locator('#ppt-key').fill('');
    await options.locator('#save-ppt').click();
    await options.waitForTimeout(200);
    const saveMsg = await options.evaluate(() => document.getElementById('ppt-test').textContent);
    await shot(options, 'options-empty-key.png');
    const saveThrew = evidence.console.options.slice(beforeSave).some((e) => e.kind === 'pageerror');
    flow(
      'save empty price key',
      !saveThrew && /paste a key/i.test(saveMsg) ? 'pass' : (saveThrew ? 'fail' : 'fail'),
      'options-empty-key.png',
      `message="${saveMsg}"`,
    );

    if (!optionsState.lookalikeDisabled) {
      const before = evidence.console.options.length;
      await options.locator('#reduce-lookalikes').click();
      await options.waitForTimeout(200);
      const on = await options.evaluate(() => ({
        checked: document.getElementById('reduce-lookalikes').checked,
        note: document.getElementById('lookalike-note').textContent,
      }));
      await options.locator('#reduce-lookalikes').click();
      await options.waitForTimeout(200);
      const off = await options.evaluate(() => document.getElementById('reduce-lookalikes').checked);
      await shot(options, 'options-lookalikes.png');
      const threw = evidence.console.options.slice(before).some((e) => e.kind === 'pageerror');
      flow('reduce lookalikes toggle', !threw && on.checked && off === false ? 'pass' : 'fail', 'options-lookalikes.png', JSON.stringify({ on, off }));
    } else {
      await shot(options, 'options-lookalikes.png');
      flow('reduce lookalikes toggle', 'blocked', 'options-lookalikes.png', `Control disabled. note="${optionsState.lookalikeNote}"`);
    }

    if (!optionsState.shareDisabled) {
      const before = evidence.console.options.length;
      const clickP = options.locator('#share-optin').click({ timeout: 8000 }).then(() => 'clicked').catch((err) => err.message.split('\n')[0]);
      const clickR = await Promise.race([clickP, new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000))]);
      await options.waitForTimeout(500);
      const shareOn = await options.evaluate(() => ({
        checked: document.getElementById('share-optin').checked,
        status: document.getElementById('share-status').textContent,
      }));
      await shot(options, 'options-share-on.png');
      if (shareOn.checked && clickR !== 'timeout') {
        await options.locator('#share-optin').click({ timeout: 8000 }).catch(() => {});
        await options.waitForTimeout(400);
      }
      const threw = evidence.console.options.slice(before).some((e) => e.kind === 'pageerror');
      flow('share opt-in toggle', threw ? 'fail' : (clickR === 'timeout' ? 'blocked' : 'pass'), 'options-share-on.png', `${clickR} ${JSON.stringify(shareOn)}`);
    } else {
      await shot(options, 'options-share-on.png');
      flow('share opt-in toggle', 'blocked', 'options-share-on.png', `Control disabled. status="${optionsState.shareStatus}"`);
    }

    const beforeDash = evidence.console.options.length;
    await options.locator('#advanced-backend summary').click();
    await options.waitForTimeout(300);
    const dash = await options.evaluate(() => ({
      open: document.getElementById('advanced-backend').open,
      status: document.getElementById('backend-status').textContent,
      detail: document.getElementById('backend-detail').innerText,
    }));
    await shot(options, 'options-dashboard.png');
    const dashErrors = evidence.console.options.slice(beforeDash).filter((e) => e.kind === 'pageerror' || e.kind === 'error');
    flow(
      'advanced local dashboard',
      dash.open && /not detected/i.test(dash.status) && dashErrors.length === 0 ? 'pass' : (dashErrors.length ? 'fail' : 'pass'),
      'options-dashboard.png',
      JSON.stringify({ ...dash, newConsole: dashErrors }),
    );

    evidence.measurements.correctionCounts = {
      corrections: optionsState.corrections,
      references: optionsState.references,
      photos: optionsState.photos,
      exportCorrectionsDisabled: optionsState.exportCorrectionsDisabled,
      exportPhotosDisabled: optionsState.exportPhotosDisabled,
    };
    await options.locator('#corrections-card').scrollIntoViewIfNeeded();
    await shot(options, 'options-corrections.png');
    if (!optionsState.exportCorrectionsDisabled) {
      const before = evidence.console.options.length;
      await options.locator('#export-corrections').click();
      await options.waitForTimeout(1000);
      const status = await options.evaluate(() => document.getElementById('corrections-status').textContent);
      const threw = evidence.console.options.slice(before).some((e) => e.kind === 'pageerror');
      await shot(options, 'options-export-corrections.png');
      flow('export corrections', threw ? 'fail' : 'pass', 'options-export-corrections.png', status);
    } else {
      flow('export corrections', 'pass', 'options-corrections.png', `Export disabled at count: ${optionsState.corrections}. Clear was not clicked.`);
    }
    if (!optionsState.exportPhotosDisabled) {
      const before = evidence.console.options.length;
      await options.locator('#export-test-photos').click();
      await options.waitForTimeout(800);
      const status = await options.evaluate(() => document.getElementById('test-photos-status').textContent);
      const threw = evidence.console.options.slice(before).some((e) => e.kind === 'pageerror');
      flow('export test photos', threw ? 'fail' : 'pass', 'options-corrections.png', status);
    } else {
      flow('export test photos', 'pass', 'options-corrections.png', `Export disabled at count: ${optionsState.photos}. Clear was not clicked.`);
    }

    // Overlay fixture
    const fixture = await context.newPage();
    attachConsole(fixture, evidence.console.fixture);
    await fixture.setViewportSize({ width: 1280, height: 800 });
    await fixture.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    const tabId = await worker.evaluate(async (port) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith(`http://127.0.0.1:${port}`));
      if (!tab) return { error: 'no tab', urls: tabs.map((t) => t.url) };
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return { id: tab.id };
    }, PORT);
    evidence.measurements.inject = tabId;
    if (!tabId?.id) {
      flow('overlay inject content.js', 'blocked', '', JSON.stringify(tabId));
    } else {
      await fixture.waitForFunction(() => window.__cardScannerLoaded === true, { timeout: 5000 }).catch(() => {});
      const loaded = await fixture.evaluate(() => ({
        loaded: window.__cardScannerLoaded === true,
        api: typeof window.__cardScanner,
      }));
      evidence.measurements.contentLoaded = loaded;

      const send = (msg) => worker.evaluate(async ({ tabId: id, msg: message }) => {
        try {
          const resp = await chrome.tabs.sendMessage(id, message);
          return { ok: true, resp: resp ?? null };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      }, { tabId: tabId.id, msg });

      const found = await send({ action: 'findCards' });
      evidence.measurements.findCards = found;

      const boxes = await fixture.evaluate(() => {
        const ids = ['c0', 'c1', 'c2'];
        return ids.map((id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return { id, box: [r.left, r.top, r.right, r.bottom], w: r.width, h: r.height };
        });
      });
      const view = await fixture.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }));
      evidence.measurements.fixtureView = view;
      const cards = [
        {
          box: boxes[0].box,
          identity: { name: 'Charizard VMAX Rainbow Rare' },
          confidence: 0.93,
          abstain: false,
          market_price: 420.5,
          display: { price: 420.5, name: 'Charizard VMAX Rainbow Rare' },
        },
        {
          box: boxes[1].box,
          identity: { name: 'Blastoise' },
          confidence: 0.62,
          abstain: false,
          market_price: 18,
          display: { price: 18, name: 'Blastoise' },
        },
        {
          box: boxes[2].box,
          identity: null,
          confidence: 0.2,
          abstain: true,
        },
      ];
      const shown = await send({ action: 'showOverlay', cards, srcWidth: view.w, srcHeight: view.h });
      evidence.measurements.showOverlay = shown;
      await fixture.waitForTimeout(250);
      await shot(fixture, 'overlay-three-cards.png');

      // Hover card 0 and highlight card 1 so labels paint.
      const c0 = boxes[0].box;
      await fixture.mouse.move((c0[0] + c0[2]) / 2, (c0[1] + c0[3]) / 2);
      await fixture.waitForTimeout(200);
      const highlighted = await send({ action: 'highlightCard', index: 1, scroll: false });
      evidence.measurements.highlight = highlighted;
      await fixture.waitForTimeout(250);
      const measure = await measureOverlay(fixture);
      evidence.measurements.overlayInitial = { boxes, measure };
      await shot(fixture, 'overlay-labels.png');
      await shot(fixture, 'overlay-highlight.png');
      flow(
        'overlay three cards showOverlay',
        shown.ok ? 'pass' : 'fail',
        'overlay-three-cards.png',
        `find=${JSON.stringify(found)} show=${JSON.stringify(shown)} boxes=${JSON.stringify(boxes.map((b) => ({ id: b.id, w: Math.round(b.w), h: Math.round(b.h) })))}`,
      );

      await fixture.setViewportSize({ width: 1000, height: 700 });
      await fixture.waitForTimeout(400);
      const afterResize = await measureOverlay(fixture);
      evidence.measurements.overlayResize = afterResize;
      await shot(fixture, 'overlay-after-resize.png');
      flow('overlay follows resize', 'pass', 'overlay-after-resize.png', JSON.stringify(afterResize.summary));

      await fixture.evaluate(() => window.scrollTo(0, 220));
      await fixture.waitForTimeout(400);
      const afterScroll = await measureOverlay(fixture);
      evidence.measurements.overlayScroll = afterScroll;
      await shot(fixture, 'overlay-after-scroll.png');
      flow('overlay follows scroll', 'pass', 'overlay-after-scroll.png', JSON.stringify(afterScroll.summary));

      const clearedOv = await send({ action: 'clearOverlay' });
      await fixture.waitForTimeout(200);
      const canvasGone = await fixture.evaluate(() => document.getElementById('__card-scanner-overlay__') == null);
      await shot(fixture, 'overlay-cleared.png');
      flow('clearOverlay', clearedOv.ok !== false && canvasGone ? 'pass' : 'fail', 'overlay-cleared.png', `canvasGone=${canvasGone} ${JSON.stringify(clearedOv)}`);

      // Show again, hide, restore. Need fresh anchors at current scroll.
      await fixture.evaluate(() => window.scrollTo(0, 0));
      await fixture.setViewportSize({ width: 1280, height: 800 });
      await fixture.waitForTimeout(300);
      await send({ action: 'findCards' });
      const boxes2 = await fixture.evaluate(() => ['c0', 'c1', 'c2'].map((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      }));
      const cards2 = cards.map((card, i) => ({ ...card, box: boxes2[i] }));
      const view2 = await fixture.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await send({ action: 'showOverlay', cards: cards2, srcWidth: view2.w, srcHeight: view2.h });
      await fixture.waitForTimeout(200);
      const hideResp = await send({ action: 'hideOverlay' });
      await fixture.waitForTimeout(200);
      const hiddenVis = await fixture.evaluate(() => {
        const c = document.getElementById('__card-scanner-overlay__');
        return c ? getComputedStyle(c).visibility : 'missing';
      });
      await shot(fixture, 'overlay-hidden.png');
      const restoreResp = await send({ action: 'restoreOverlay' });
      await fixture.waitForTimeout(200);
      const restoredVis = await fixture.evaluate(() => {
        const c = document.getElementById('__card-scanner-overlay__');
        return c ? getComputedStyle(c).visibility : 'missing';
      });
      await shot(fixture, 'overlay-restored.png');
      flow(
        'hideOverlay then restoreOverlay',
        hiddenVis === 'hidden' && restoredVis === 'visible' ? 'pass' : 'fail',
        'overlay-hidden.png',
        `hide=${JSON.stringify(hideResp)} vis=${hiddenVis} restore=${JSON.stringify(restoreResp)} vis=${restoredVis}`,
      );

      // Narrow card
      await fixture.locator('#cn').scrollIntoViewIfNeeded();
      await fixture.waitForTimeout(300);
      await send({ action: 'findCards' });
      const narrowBox = await fixture.evaluate(() => {
        const r = document.getElementById('cn').getBoundingClientRect();
        return { box: [r.left, r.top, r.right, r.bottom], w: r.width, h: r.height };
      });
      const narrowCard = {
        box: narrowBox.box,
        identity: { name: 'Charizard VMAX Rainbow Rare' },
        confidence: 0.93,
        abstain: false,
        market_price: 420.5,
        display: { price: 420.5, name: 'Charizard VMAX Rainbow Rare' },
      };
      const size = await fixture.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await send({
        action: 'showOverlay',
        cards: [narrowCard],
        srcWidth: size.w,
        srcHeight: size.h,
      });
      await send({ action: 'highlightCard', index: 0, scroll: false });
      await fixture.mouse.move(
        (narrowBox.box[0] + narrowBox.box[2]) / 2,
        (narrowBox.box[1] + narrowBox.box[3]) / 2,
      );
      await fixture.waitForTimeout(300);
      const narrowMeasure = await measureOverlay(fixture);
      evidence.measurements.overlayNarrow = { narrowBox, narrowMeasure };
      await shot(fixture, 'overlay-narrow.png');
      flow(
        'overlay narrow card under 140px',
        narrowBox.w < 140 ? 'pass' : 'fail',
        'overlay-narrow.png',
        `width=${narrowBox.w} measure=${JSON.stringify(narrowMeasure.summary)}`,
      );
    }

    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    log('wrote evidence.json');
  } finally {
    server.close();
    if (context && !leaveOpen) await context.close().catch(() => {});
    if (leaveOpen) log('LEFT BROWSER OPEN');
  }
}

async function measureOverlay(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('__card-scanner-overlay__');
    if (!canvas) return { summary: { canvas: false } };
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = img.data;
    const cards = [...document.querySelectorAll('#c0, #c1, #c2, #cn')].map((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -20 || r.top > window.innerHeight + 20 || r.width < 20) return null;
      const pad = 40;
      const x0 = Math.max(0, Math.floor((r.left - pad) * dpr));
      const y0 = Math.max(0, Math.floor((r.top - pad) * dpr));
      const x1 = Math.min(canvas.width, Math.ceil((r.right + pad) * dpr));
      const y1 = Math.min(canvas.height, Math.ceil((r.bottom + pad) * dpr));
      let gMinX = Infinity, gMinY = Infinity, gMaxX = -1, gMaxY = -1, green = 0;
      let lMinX = Infinity, lMinY = Infinity, lMaxX = -1, lMaxY = -1, dark = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * canvas.width + x) * 4;
          const R = data[i], G = data[i + 1], B = data[i + 2], A = data[i + 3];
          if (A > 140 && G > 140 && G > R + 40 && G > B + 20) {
            green++;
            if (x < gMinX) gMinX = x;
            if (y < gMinY) gMinY = y;
            if (x > gMaxX) gMaxX = x;
            if (y > gMaxY) gMaxY = y;
          }
          if (A > 200 && R < 40 && G < 45 && B < 55 && R > 4 && B > R) {
            dark++;
            if (x < lMinX) lMinX = x;
            if (y < lMinY) lMinY = y;
            if (x > lMaxX) lMaxX = x;
            if (y > lMaxY) lMaxY = y;
          }
        }
      }
      const toCss = (v) => v / dpr;
      const label = dark > 30 ? {
        x: toCss(lMinX),
        y: toCss(lMinY),
        w: toCss(lMaxX - lMinX),
        h: toCss(lMaxY - lMinY),
        dark,
      } : null;
      const greenBox = green > 10 ? {
        x: toCss(gMinX),
        y: toCss(gMinY),
        right: toCss(gMaxX),
        bottom: toCss(gMaxY),
        green,
      } : null;
      const card = { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      let labelOutside = null;
      if (label) {
        labelOutside = {
          left: +(card.x - label.x).toFixed(1),
          right: +((label.x + label.w) - card.right).toFixed(1),
          top: +(card.y - label.y).toFixed(1),
          bottom: +((label.y + label.h) - card.bottom).toFixed(1),
        };
      }
      let align = null;
      if (greenBox) {
        align = {
          dLeft: +(greenBox.x - card.x).toFixed(1),
          dTop: +(greenBox.y - card.y).toFixed(1),
          dRight: +(greenBox.right - card.right).toFixed(1),
          dBottom: +(greenBox.bottom - card.bottom).toFixed(1),
        };
      }
      return { id: el.id, card: { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.left.toFixed(1), y: +r.top.toFixed(1) }, greenBox, label, labelOutside, align };
    }).filter(Boolean);
    return {
      summary: {
        canvas: true,
        dpr,
        visibility: getComputedStyle(canvas).visibility,
        cards,
      },
    };
  });
}

main().catch((err) => {
  evidence.fatal = String(err?.stack || err);
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.error(err);
  process.exit(1);
});
