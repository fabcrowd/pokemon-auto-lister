/**
 * Visual smoke test — opens the real chrome-extension:// popup,
 * drives it through every meaningful UI state, and saves screenshots
 * to tests/e2e/screenshots/visual/ so you can eyeball everything.
 *
 * Run: npx playwright test extension-visual --project=extension
 */

import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs   from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = path.resolve(__dirname, '../../dist/extension');
const SHOT_DIR  = path.join(__dirname, 'screenshots', 'visual');

fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── Fixture data ──────────────────────────────────────────────────────────────

const SINGLE_HIGH = [{
  box: [40, 60, 310, 460],
  identity: { name: 'Charizard', set: 'Base Set (Unlimited)', setCode: 'BS', number: '4/102', game: 'pokemon' },
  confidence: 0.94,
  market_price: 647.00,
  price_variant: 'mercari',
  abstain: false,
}];

const MULTI_CARDS = [
  {
    box: [20,  30, 295, 440],
    identity: { name: 'Charizard',  set: 'Base Set', setCode: 'BS', number: '4/102',  game: 'pokemon' },
    confidence: 0.94, market_price: 647.00, price_variant: 'mercari', abstain: false,
  },
  {
    box: [320, 30, 595, 440],
    identity: { name: 'Blastoise',  set: 'Base Set', setCode: 'BS', number: '2/102',  game: 'pokemon' },
    confidence: 0.72, market_price: 210.50, price_variant: 'market',  abstain: false,
  },
  {
    box: [20, 460, 295, 870],
    identity: { name: 'Venusaur',   set: 'Base Set', setCode: 'BS', number: '15/102', game: 'pokemon' },
    confidence: 0.61, market_price:  89.99, price_variant: 'market',  abstain: false,
  },
];

const LOW_CONF = [{
  box: [80, 100, 350, 420],
  identity: { name: 'Pikachu', set: 'Base Set', setCode: 'BS', number: '58/102', game: 'pokemon' },
  confidence: 0.38,
  market_price: 24.00,
  price_variant: 'market',
  abstain: false,
}];

const NO_PRICE = [{
  box: [60, 80, 320, 430],
  identity: { name: 'Bulbasaur', set: 'Base Set', setCode: 'BS', number: '44/102', game: 'pokemon' },
  confidence: 0.88,
  market_price: null,
  price_variant: null,
  abstain: false,
}];

const ABSTAIN = [{
  box: [100, 120, 370, 430],
  identity: { name: 'Unknown', set: '', setCode: '', number: '', game: 'pokemon' },
  confidence: 0.12,
  market_price: null,
  price_variant: null,
  abstain: true,
}];

const HIGH_VALUE_STACK = [
  { box: [10,10,290,440], identity: { name: 'Charizard 1st Ed', set: 'Base Set 1st Ed', setCode: 'BS1', number: '4/102', game: 'pokemon' }, confidence: 0.97, market_price: 12500, price_variant: 'psa10', abstain: false },
  { box: [310,10,600,440], identity: { name: 'Blastoise 1st Ed', set: 'Base Set 1st Ed', setCode: 'BS1', number: '2/102',  game: 'pokemon' }, confidence: 0.91, market_price: 3200,  price_variant: 'psa9',  abstain: false },
  { box: [10,460,290,870], identity: { name: 'Venusaur 1st Ed',  set: 'Base Set 1st Ed', setCode: 'BS1', number: '15/102', game: 'pokemon' }, confidence: 0.89, market_price: 1800,  price_variant: 'psa9',  abstain: false },
  { box: [310,460,600,870], identity: { name: 'Pikachu Yellow', set: 'Promo', setCode: 'PR', number: '1',      game: 'pokemon' }, confidence: 0.78, market_price: 550,   price_variant: 'market', abstain: false },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });
  console.log(`  📸 ${name}.png`);
}

async function ready(page, extId) {
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.waitForFunction(() => typeof window.updateResults === 'function', { timeout: 8_000 });
}

async function inject(page, cards, ms = 280) {
  await page.evaluate(({ cards, ms }) => {
    window.updateResults(cards);
    window.updateStats(cards, ms);
    window.renderOverlay(cards);
  }, { cards, ms });
  // Give canvas paint a tick to settle
  await page.waitForTimeout(80);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('Visual smoke — Card Scanner popup', () => {
  let context;
  let EXT_ID;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
      ],
    });

    let sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', {
        predicate: w => w.url().startsWith('chrome-extension://'),
        timeout: 10_000,
      });
    }
    EXT_ID = new URL(sw.url()).hostname;
    console.log(`\n  Extension ID: ${EXT_ID}`);
    console.log(`  Screenshots → ${SHOT_DIR}\n`);
  });

  test.afterAll(async () => { await context.close(); });

  // ── 1. Idle state ──────────────────────────────────────────────────────────
  test('01 idle — camera placeholder + connecting pill', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await shot(page, '01-idle');

    await expect(page.locator('#cam-placeholder')).toBeVisible();
    await expect(page.locator('.logo')).toContainText('Card Scanner');
    await page.close();
  });

  // ── 2. Server online ───────────────────────────────────────────────────────
  test('02 server health — pill settles ok or err', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await page.evaluate(() => window.checkHealth());
    await page.waitForFunction(() => {
      const p = document.getElementById('server-pill');
      return p && (p.classList.contains('ok') || p.classList.contains('err'));
    }, { timeout: 8_000 });

    const cls = await page.locator('#server-pill').getAttribute('class');
    await shot(page, `02-server-${cls.includes('ok') ? 'ok' : 'err'}`);
    expect(cls).toMatch(/ok|err/);
    await page.close();
  });

  // ── 3. Scanning button state ───────────────────────────────────────────────
  test('03 scan button — active scanning state', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await page.locator('#btn-scan').click();
    await expect(page.locator('body')).toHaveClass(/scanning/);
    await shot(page, '03-scanning-active');

    await page.locator('#btn-scan').click();
    await expect(page.locator('body')).not.toHaveClass(/scanning/);
    await shot(page, '03-scanning-stopped');
    await page.close();
  });

  // ── 4. Single high-confidence card ────────────────────────────────────────
  test('04 single card — Charizard high confidence with overlay', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await inject(page, SINGLE_HIGH, 312);
    await shot(page, '04-single-charizard');

    await expect(page.locator('.card-name').first()).toContainText('Charizard');
    await expect(page.locator('.price-main').first()).toContainText('$647.00');
    await expect(page.locator('.conf-stripe.high')).toBeVisible();
    await expect(page.locator('#s-detected')).toHaveText('1');
    await expect(page.locator('#s-value')).toContainText('$647.00');
    await page.close();
  });

  // ── 5. Multiple cards ─────────────────────────────────────────────────────
  test('05 multi-card — 3 cards at different confidence tiers', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await inject(page, MULTI_CARDS, 498);
    await shot(page, '05-multi-card');

    await expect(page.locator('.card-row')).toHaveCount(3);
    // High + medium + medium stripes (0.94 / 0.82 / 0.61)
    await expect(page.locator('.conf-stripe.high')).toHaveCount(1);
    await expect(page.locator('.conf-stripe.medium')).toHaveCount(2);
    await expect(page.locator('#s-detected')).toHaveText('3');
    await page.close();
  });

  // ── 6. Low-confidence card ────────────────────────────────────────────────
  test('06 low confidence — stripe colour and rendering', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await inject(page, LOW_CONF, 390);
    await shot(page, '06-low-confidence');

    await expect(page.locator('.conf-stripe.low')).toBeVisible();
    await expect(page.locator('.card-name').first()).toContainText('Pikachu');
    await page.close();
  });

  // ── 7. No-price card ──────────────────────────────────────────────────────
  test('07 no price — shows dash, no price-main element', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await inject(page, NO_PRICE, 305);
    await shot(page, '07-no-price');

    await expect(page.locator('.no-price')).toHaveText('—');
    await expect(page.locator('.price-main')).toHaveCount(0);
    await page.close();
  });

  // ── 8. Abstain card ───────────────────────────────────────────────────────
  test('08 abstain card — dashed box stripe', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await inject(page, ABSTAIN, 210);
    await shot(page, '08-abstain');

    await expect(page.locator('.conf-stripe.abstain')).toBeVisible();
    await expect(page.locator('.price-main')).toHaveCount(0);
    await page.close();
  });

  // ── 9. Empty results after clear ──────────────────────────────────────────
  test('09 empty — hint text visible after clear', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await inject(page, MULTI_CARDS);            // populate first
    await page.evaluate(() => window.updateResults([]));
    await shot(page, '09-empty-results');

    await expect(page.locator('#empty-hint')).toBeVisible();
    await expect(page.locator('.card-row')).toHaveCount(0);
    await page.close();
  });

  // ── 10. High-value stack ──────────────────────────────────────────────────
  test('10 high-value stack — 4 graded cards, total value shown', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await inject(page, HIGH_VALUE_STACK, 621);
    await shot(page, '10-high-value-stack');

    await expect(page.locator('.card-row')).toHaveCount(4);
    await expect(page.locator('#s-detected')).toHaveText('4');
    // Total = 12500 + 3200 + 1800 + 550 = 18050
    await expect(page.locator('#s-value')).toContainText('$18050.00');
    await page.close();
  });

  // ── 11. XSS safety ───────────────────────────────────────────────────────
  test('11 XSS — injected script tag is escaped', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);
    await page.evaluate(() => window.updateResults([{
      box: [10,10,100,100],
      identity: { name: '<script>window.__xss=1</script>', set: '', setCode: '', number: '', game: 'pokemon' },
      confidence: 0.9, market_price: 1, price_variant: 'market', abstain: false,
    }]));
    await shot(page, '11-xss-escaped');

    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    const html = await page.locator('.card-name').first().innerHTML();
    expect(html).toContain('&lt;script&gt;');
    await page.close();
  });

  // ── 13. Overlay toggle — drawn after scan, cleared after stop ────────────
  test('13 overlay toggle — corner boxes + price badges drawn, cleared on stop', async () => {
    const page = await context.newPage();
    await ready(page, EXT_ID);

    // Inject two cards so we get multiple corner-box outlines + badges
    await inject(page, MULTI_CARDS, 310);
    await shot(page, '13a-overlay-on');

    // Canvas must have drawn pixels — corner boxes and price badges
    const hasPixelsAfterScan = await page.evaluate(() => {
      const canvas = document.getElementById('overlay');
      const data   = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return data.some(v => v !== 0);
    });
    expect(hasPixelsAfterScan).toBe(true);

    // Results panel shows all three cards with prices
    await expect(page.locator('.card-row')).toHaveCount(3);
    await expect(page.locator('.price-main').first()).toBeVisible();

    // Simulate stopping the scan (mirrors stopScanning() — clears the canvas)
    await page.evaluate(() => window.stopScanning());
    await shot(page, '13b-overlay-off');

    // Canvas must now be blank
    const hasPixelsAfterStop = await page.evaluate(() => {
      const canvas = document.getElementById('overlay');
      const data   = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return data.some(v => v !== 0);
    });
    expect(hasPixelsAfterStop).toBe(false);

    // Scan button is back to idle state
    await expect(page.locator('body')).not.toHaveClass(/scanning/);
    await expect(page.locator('#btn-label')).toHaveText('SCAN');

    // Results panel still shows the cards (results are not wiped on stop)
    await expect(page.locator('.card-row')).toHaveCount(3);

    await page.close();
  });

  // ── 12. Live server round-trip ────────────────────────────────────────────
  test('12 live server — real /detect response rendered', async () => {
    const scanImg = path.resolve(__dirname, '../../data/_scan-e2e.jpg');
    if (!fs.existsSync(scanImg)) {
      test.skip(true, 'No _scan-e2e.jpg fixture');
    }

    const b64 = fs.readFileSync(scanImg).toString('base64');
    let cards;
    try {
      const res = await fetch('http://127.0.0.1:3000/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: b64 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cards = (data.cards || []).filter(c => !c.abstain);
    } catch (e) {
      test.skip(true, `Server not reachable: ${e.message}`);
    }

    if (!cards?.length) test.skip(true, 'No non-abstain cards from server');

    const page = await context.newPage();
    await ready(page, EXT_ID);
    await inject(page, cards, 0);
    await shot(page, '12-live-server-result');

    await expect(page.locator('.card-name').first()).toBeVisible();
    await expect(page.locator('.card-row').first()).toBeVisible();
    await page.close();
  });
});
