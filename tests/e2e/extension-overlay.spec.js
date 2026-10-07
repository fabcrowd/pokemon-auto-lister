import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POPUP_PATH = path.resolve(__dirname, '../../tools/chrome-extension/popup.html');
const POPUP_URL  = 'file:///' + POPUP_PATH.replace(/\\/g, '/');

const CHARIZARD_CARDS = [
  {
    box: [10, 10, 599, 826],
    identity: {
      name: 'Charizard',
      set: 'Base Set (Unlimited)',
      number: '4/102',
      game: 'pokemon',
    },
    confidence: 0.3,
    market_price: 647,
    price_variant: 'mercari',
    abstain: false,
  },
];

test.describe('Extension overlay', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: () => Promise.reject(new Error('camera mocked')),
        },
        writable: true,
      });
    });
  });

  async function loadPopup(page) {
    await page.goto(POPUP_URL);
    await page.waitForFunction(() => typeof window.updateResults === 'function', { timeout: 5000 });
  }

  test('renders Charizard name and price in results panel', async ({ page }) => {
    await page.goto(POPUP_URL);

    // Wait for popup.js to define global functions
    await page.waitForFunction(() => typeof window.updateResults === 'function', { timeout: 5000 });

    // Inject scan result directly — bypasses video.readyState check entirely
    await page.evaluate((cards) => {
      window.updateResults(cards);
      window.updateStats(cards, 420);
      window.renderOverlay(cards);
    }, CHARIZARD_CARDS);

    const cardName  = page.locator('.card-name').first();
    const priceMain = page.locator('.price-main').first();
    const priceType = page.locator('.price-type').first();
    const sDetected = page.locator('#s-detected');
    const sValue    = page.locator('#s-value');

    await expect(cardName).toContainText('Charizard');
    await expect(priceMain).toContainText('$647.00');
    await expect(priceType).toContainText('mercari');
    await expect(sDetected).toHaveText('1');
    await expect(sValue).toContainText('$647.00');

    const screenshotDir = path.join(__dirname, 'screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, 'overlay-charizard.png'),
      fullPage: true,
    });
  });

  test('empty state shows hint and no card rows', async ({ page }) => {
    await loadPopup(page);
    await page.evaluate(() => window.updateResults([]));
    await expect(page.locator('#empty-hint')).toBeVisible();
    await expect(page.locator('.card-row')).toHaveCount(0);
  });

  test('XSS in card name is escaped, not executed', async ({ page }) => {
    await loadPopup(page);
    const xssCard = [{
      box: [10, 10, 100, 100],
      identity: { name: '<script>window.__xss=1</script>', set: '', number: '', game: 'pokemon' },
      confidence: 0.9,
      market_price: 1.00,
      price_variant: 'market',
      abstain: false,
    }];
    await page.evaluate((cards) => window.updateResults(cards), xssCard);
    const xssRan = await page.evaluate(() => window.__xss);
    expect(xssRan).toBeUndefined();
    const nameText = await page.locator('.card-name').first().innerHTML();
    expect(nameText).toContain('&lt;script&gt;');
  });

  test('null market_price renders dash, not a price', async ({ page }) => {
    await loadPopup(page);
    const noPrice = [{
      box: [10, 10, 100, 100],
      identity: { name: 'Bulbasaur', set: 'Base Set', number: '44/102', game: 'pokemon' },
      confidence: 0.85,
      market_price: null,
      price_variant: null,
      abstain: false,
    }];
    await page.evaluate((cards) => window.updateResults(cards), noPrice);
    await expect(page.locator('.no-price')).toHaveText('—');
    await expect(page.locator('.price-main')).toHaveCount(0);
  });

  test('abstain card gets abstain stripe, no price-main', async ({ page }) => {
    await loadPopup(page);
    const abstainCard = [{
      box: [10, 10, 100, 100],
      identity: { name: 'Unknown', set: '', number: '', game: 'pokemon' },
      confidence: 0.1,
      market_price: null,
      price_variant: null,
      abstain: true,
    }];
    await page.evaluate((cards) => window.updateResults(cards), abstainCard);
    await expect(page.locator('.conf-stripe.abstain')).toHaveCount(1);
    await expect(page.locator('.price-main')).toHaveCount(0);
  });

  test('multiple cards render one row each', async ({ page }) => {
    await loadPopup(page);
    const threeCards = [
      { box: [0,0,10,10], identity: { name: 'Pikachu', set: '', number: '', game: 'pokemon' }, confidence: 0.9, market_price: 5, price_variant: 'market', abstain: false },
      { box: [0,0,10,10], identity: { name: 'Mewtwo',  set: '', number: '', game: 'pokemon' }, confidence: 0.8, market_price: 20, price_variant: 'market', abstain: false },
      { box: [0,0,10,10], identity: { name: 'Mew',     set: '', number: '', game: 'pokemon' }, confidence: 0.6, market_price: 10, price_variant: 'market', abstain: false },
    ];
    await page.evaluate((cards) => window.updateResults(cards), threeCards);
    await expect(page.locator('.card-row')).toHaveCount(3);
  });

  test('updateStats with no prices shows dashes', async ({ page }) => {
    await loadPopup(page);
    await page.evaluate(() => window.updateStats([], 99));
    await expect(page.locator('#s-detected')).toHaveText('—');
    await expect(page.locator('#s-value')).toHaveText('—');
    await expect(page.locator('#s-ms')).toHaveText('99');
  });

  test('server pill shows ok when /health returns 200', async ({ page }) => {
    await page.addInitScript(() => {
      window.fetch = async (url) => {
        if (url.includes('/health')) return { ok: true };
        return originalFetch(url);
      };
    });
    await loadPopup(page);
    await page.evaluate(() => window.checkHealth());
    await expect(page.locator('#server-pill')).toHaveClass(/ok/);
    await expect(page.locator('#stext')).toHaveText('server ok');
  });

  test('server pill shows err when /health is unreachable', async ({ page }) => {
    await page.addInitScript(() => {
      window.fetch = async () => { throw new Error('offline'); };
    });
    await loadPopup(page);
    await page.evaluate(() => window.checkHealth());
    await expect(page.locator('#server-pill')).toHaveClass(/err/);
    await expect(page.locator('#stext')).toHaveText('offline');
  });

  test('scan toggle button starts and stops scanning', async ({ page }) => {
    await loadPopup(page);
    const btn = page.locator('#btn-scan');
    const label = page.locator('#btn-label');
    await btn.click();
    await expect(page.locator('body')).toHaveClass(/scanning/);
    await expect(label).toHaveText('STOP');
    await btn.click();
    await expect(page.locator('body')).not.toHaveClass(/scanning/);
    await expect(label).toHaveText('SCAN');
  });

  test('renders real card data from live /detect server', async ({ page }) => {
    // Call the server from the test process (avoids file:// → http:// CORS restriction)
    const imageB64 = fs.readFileSync(
      path.resolve(__dirname, '../../data/_scan-e2e.jpg'),
    ).toString('base64');

    let cards;
    try {
      const res = await fetch('http://127.0.0.1:3000/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: imageB64 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cards = (data.cards || []).filter((c) => !c.abstain);
    } catch {
      test.skip(true, 'Server not running or returned no cards');
    }

    if (!cards || cards.length === 0) {
      test.skip(true, 'No non-abstain cards returned by server');
    }

    await page.goto(POPUP_URL);
    await page.waitForFunction(() => typeof window.updateResults === 'function', { timeout: 5000 });

    // Inject the real server result into the overlay
    await page.evaluate((c) => {
      window.updateResults(c);
      window.updateStats(c, 0);
      window.renderOverlay(c);
    }, cards);

    const cardName = page.locator('.card-name').first();
    await expect(cardName).toBeVisible();

    const priceMain = page.locator('.price-main').first();
    await expect(priceMain).toBeVisible();

    await page.screenshot({
      path: path.join(__dirname, 'screenshots', 'overlay-live-detect.png'),
      fullPage: true,
    });
  });
});
