/**
 * Live load of the consumer extension (dist/extension-wasm).
 * Confirms the popup a buyer sees actually opens, and that the service worker starts.
 *
 * Run: npx playwright test extension-wasm-popup --project=extension
 */

import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../dist/extension-wasm');

test.describe('Consumer extension popup', () => {
  let context;
  let extensionId;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
      ],
    });

    let worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', {
        predicate: (w) => w.url().startsWith('chrome-extension://'),
        timeout: 15_000,
      });
    }
    extensionId = new URL(worker.url()).hostname;
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('popup opens with a scan button and an era picker', async () => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(page.locator('.logo')).toContainText('Card Scanner');
    await expect(page.locator('#btn-label')).toHaveText('SCAN PAGE');
    await expect(page.locator('.action-bar #era-select')).toBeVisible();
    // The scan button follows the background's readiness (models downloaded), which the popup asks for after it
    // loads. Ask the same question, then wait for the button to settle to that answer instead of sampling it early.
    const ready = await page.evaluate(async () => Boolean((await chrome.runtime.sendMessage({ action: 'checkReady' }))?.ready));
    if (ready) await expect(page.locator('#btn-scan')).toBeEnabled();
    else {
      await expect(page.locator('#btn-scan')).toBeDisabled();
      await expect(page.locator('#setup-overlay')).toBeVisible();
    }
    const paint = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      wizard: getComputedStyle(document.getElementById('setup-overlay')).display,
      wizardText: document.getElementById('setup-overlay').innerText.slice(0, 180),
    }));
    expect(paint.background).toBe('rgb(8, 9, 13)');
    if (paint.wizard !== 'none') {
      expect(paint.wizardText).toMatch(/Download the AI models|Read full-size photos|Unlock full prices/);
    }
    expect(errors, errors.join('\n')).toEqual([]);

    // The real window is a narrow popup. The era picker and scan button have to fit.
    await page.setViewportSize({ width: 420, height: 640 });
    const fit = await page.evaluate(() => {
      const era = document.getElementById('era-select').getBoundingClientRect();
      const scan = document.getElementById('btn-scan').getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        eraRight: era.right,
        scanRight: scan.right,
      };
    });
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);
    expect(fit.eraRight).toBeLessThanOrEqual(420);
    expect(fit.scanRight).toBeLessThanOrEqual(420);

    await page.screenshot({
      path: path.join(__dirname, 'screenshots', 'ext-wasm-popup.png'),
    });
    await page.close();
  });

  test('a card photo that is still loading is reported, then found', async () => {
    const listing = await context.newPage();
    let releaseImage;
    const imageHeld = new Promise((resolve) => { releaseImage = resolve; });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await listing.route('http://127.0.0.1:8765/**', async (route) => {
      if (route.request().url().endsWith('.png')) {
        await imageHeld;
        await route.fulfill({ status: 200, contentType: 'image/png', body: png });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>lot</title><img width="220" height="310" alt="Charizard" src="http://127.0.0.1:8765/card.png">',
      });
    });
    await listing.goto('http://127.0.0.1:8765/lot', { waitUntil: 'domcontentloaded' });

    const worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    const ask = () => worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith('http://127.0.0.1:8765/lot'));
      if (!tab) return { error: 'no tab' };
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      const found = await chrome.tabs.sendMessage(tab.id, { action: 'findCards' });
      return { cards: found.cards?.length ?? 0, pending: found.pending ?? 0 };
    });

    const whileLoading = await ask();
    expect(whileLoading.cards).toBe(0);
    expect(whileLoading.pending).toBeGreaterThan(0);

    releaseImage();
    await listing.waitForFunction(() => {
      const img = document.querySelector('img');
      return img && img.complete && img.naturalWidth > 0;
    });
    const loaded = await ask();
    expect(loaded.cards).toBe(1);
    expect(loaded.pending).toBe(0);
    await listing.close();
  });

  test('a screenshot scan offers site access; Allow offers a rescan, Not now is remembered', async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    // The dev build holds <all_urls> already, so pretend it is missing; the click handler is the real one.
    await page.evaluate(() => {
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (msg) => (msg?.action === 'scanPage'
        ? { cards: [], scanId: 'x', srcWidth: 10, srcHeight: 10, pending: 0, usedScreenshotPath: true, reason: 'no-site-access' }
        : real(msg));
      window.__granted = false;
      window.__asked = [];
      chrome.permissions.contains = async () => window.__granted;
      chrome.permissions.request = async (req) => { window.__asked.push(req); return window.__granted = true; };
      chrome.storage.local.remove('siteAccessDismissedAt');
    });
    // The fresh profile has no models, so the setup overlay covers the button; click it directly.
    const scan = () => page.evaluate(() => { const b = document.getElementById('btn-scan'); b.disabled = false; b.click(); });
    const notice = page.locator('#access-notice');

    await scan();
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('small cards come out sharper');
    await expect(page.locator('button#access-allow')).toBeVisible();
    await page.evaluate(() => { document.getElementById('setup-overlay').style.display = 'none'; });
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'ext-wasm-popup-site-access.png') });

    await page.locator('#access-allow').evaluate((b) => b.click());
    expect(await page.evaluate(() => window.__asked)).toEqual([{ origins: ['<all_urls>'] }]);
    await expect(page.locator('#access-outcome')).toContainText('scan again to read the original photos');
    await expect(page.locator('#access-rescan')).toBeVisible();

    await page.evaluate(() => { window.__granted = false; });
    await scan();
    await expect(notice).toBeVisible();
    await page.locator('#access-skip').evaluate((b) => b.click());
    await expect(notice).toBeHidden();
    await scan();
    await expect(page.locator('#msg-bar')).toContainText('No Pok');
    await expect(notice).toBeHidden();
    await page.close();
  });

  test('a lot of 3+ cards shows an estimate, and an unrecognised card asks with its closest matches', async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() => {
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__highlights = [];
      const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
      const near = [{ id: 'a-1', name: 'Pidgey', set: 'Set A', setCode: 'a', number: '1' }, { id: 'b-2', name: 'Rattata', set: 'Set B', setCode: 'b', number: '2' }];
      const crop = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
      const cards = [
        { identity: { id: 'x-1', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' }, confidence: 0.9, abstain: false, market_price: 5, price_grid: grid(5), box: [0, 0, 1, 1] },
        { identity: { id: 'x-2', name: 'Raichu', set: 'Base', setCode: 'base1', number: '14' }, confidence: 0.9, abstain: false, market_price: 7.5, price_grid: grid(7.5), box: [0, 0, 1, 1] },
        { identity: null, confidence: 0.3, abstain: true, candidates: near, crop, box: [0, 0, 1, 1] },
      ];
      chrome.runtime.sendMessage = async (msg) => {
        if (msg?.action === 'scanPage') return { cards, scanId: 'y', srcWidth: 10, srcHeight: 10, pending: 0 };
        if (msg?.action === 'highlightCard') { window.__highlights.push(msg); return { ok: true }; }
        return real(msg);
      };
    });
    await page.evaluate(() => { const b = document.getElementById('btn-scan'); b.disabled = false; b.click(); });
    await expect(page.locator('#s-value')).toHaveText('$12.50');
    await expect(page.locator('#s-value')).toHaveAttribute('title', '2 of 3 cards identified · 1 still to identify');
    await expect(page.locator('#stat-value')).toHaveAttribute('aria-label', '2 of 3 cards identified · 1 still to identify');
    await expect(page.locator('.card-price')).toHaveText(['$5.00', '$7.50', '—']);
    await expect(page.locator('.card-row .picker-title')).toHaveText('Which card is this?');
    await expect(page.locator('.picker-sub')).toHaveText('Closest matches');
    await expect(page.locator('.pick-card')).toHaveCount(2);
    await expect(page.locator('.unrec-toggle')).toHaveCount(0);

    const scanned = page.locator('.card-row.asking .scanned-card');
    await expect(scanned).toHaveCount(1);
    await expect(scanned.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    await expect(scanned).toContainText('On the page');
    await page.evaluate(() => { document.getElementById('setup-overlay').style.display = 'none'; });
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'ext-wasm-popup-ask.png') });
    await scanned.evaluate((b) => b.click());
    const sent = await page.evaluate(() => window.__highlights);
    expect(sent.at(-1)).toEqual({ action: 'highlightCard', index: 2, scroll: true });
    await page.close();
  });

  test('a set the page heading names is priced and marked; confirming it saves the answer and keeps the Set? menu', async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() => {
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__sent = [];
      const cards = [{
        identity: { id: 'sv02-5', name: 'Eevee', set: 'Paldea Evolved', setCode: 'sv02', number: '005' },
        setChoices: [
          { id: 'sv01-5', name: 'Eevee', set: 'Scarlet & Violet', setCode: 'sv01', number: '005' },
          { id: 'sv02-5', name: 'Eevee', set: 'Paldea Evolved', setCode: 'sv02', number: '005' },
        ],
        setConfirmed: false,
        bestGuess: { source: 'hint', reason: 'Page says Paldea Evolved' },
        confidence: 0.7, abstain: false, market_price: 3, box: [0, 0, 1, 1],
        price_grid: { source: 'pokemontcg', variants: { normal: { market: 3, conditions: { NM: 3 } } } },
      }];
      chrome.runtime.sendMessage = async (msg) => {
        if (msg?.action === 'scanPage') return { cards, scanId: 'g', srcWidth: 10, srcHeight: 10, pending: 0 };
        if (msg?.action === 'saveCorrection') { window.__sent.push(msg); return { ok: true }; }
        return real(msg);
      };
    });
    await page.evaluate(() => { const b = document.getElementById('btn-scan'); b.disabled = false; b.click(); });

    const mark = page.locator('.card-row .guess-mark');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveAttribute('title', 'Page says Paldea Evolved');
    await expect(page.locator('.set-select-row select')).toHaveValue('sv02-5');
    await expect(page.locator('#s-value')).toHaveText('$3.00');
    await expect(page.locator('.card-row .card-price')).toHaveText('$3.00');

    await mark.evaluate((b) => b.click());
    await expect(page.locator('.card-row .guess-mark')).toHaveCount(0);
    await expect(page.locator('.set-select-row select')).toHaveValue('sv02-5');
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'saveCorrection', scanId: 'g', index: 0, pickedId: 'sv02-5', via: 'guess-confirmed' });
    await page.close();
  });

  // Opens a fresh popup whose scan returns the cards built by `build` (run inside the page).
  async function popupWithScan(build) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate((src) => {
      const cards = new Function(`return (${src})()`)();
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (msg) => (msg?.action === 'scanPage'
        ? { cards, scanId: 'z', srcWidth: 10, srcHeight: 10, pending: 0 }
        : real(msg));
    }, build.toString());
    await page.evaluate(() => { const b = document.getElementById('btn-scan'); b.disabled = false; b.click(); });
    return page;
  }

  test('a set borrowed from the other cards on the page is a range with the Set? menu preselected until confirmed', async () => {
    const page = await popupWithScan(() => [{
      identity: { id: 'sv02-5', name: 'Eevee', set: 'Paldea Evolved', setCode: 'sv02', number: '005' },
      setChoices: [
        { id: 'sv01-5', name: 'Eevee', set: 'Scarlet & Violet', setCode: 'sv01', number: '005' },
        { id: 'sv02-5', name: 'Eevee', set: 'Paldea Evolved', setCode: 'sv02', number: '005' },
      ],
      setConfirmed: false,
      setRange: { low: 2, high: 9, count: 2, total: 2 },
      bestGuess: { source: 'page', reason: 'likely Paldea Evolved: 2 other cards on this page are from it' },
      confidence: 0.7, abstain: false, market_price: 3, box: [0, 0, 1, 1],
      price_grid: { source: 'pokemontcg', variants: { normal: { market: 3, conditions: { NM: 3 } } } },
    }]);
    await expect(page.locator('.card-row .card-price')).toHaveText('$2.00–$9.00');
    await expect(page.locator('.set-select-row select')).toHaveValue('sv02-5');
    await expect(page.locator('.card-row .guess-mark')).toHaveCount(1);
    await page.locator('.card-row .guess-mark').evaluate((b) => b.click());
    await expect(page.locator('.card-row .card-price')).toHaveText('$3.00');
    await page.close();
  });

  test('the ? beside Variant confirms the suggested printing: no price until then, then one price', async () => {
    const page = await popupWithScan(() => [{
      identity: { id: 'x-1', name: 'Eevee', set: 'Jungle', setCode: 'base2', number: '51' },
      confidence: 0.9, abstain: false, box: [0, 0, 1, 1],
      variant: { edition: 'standard', finish: 'reverse', stamp: 'none' },
      price_grid: { source: 'pokemontcg', variants: {
        normal: { market: 2, conditions: { NM: 2 } },
        holofoil: { market: 10, conditions: { NM: 10 } },
        reverseHolofoil: { market: 4, conditions: { NM: 4 } },
      } },
    }]);
    const select = page.locator('.variant-select-row:not(.set-select-row) select');
    await expect(select).toHaveValue('reverseHolofoil');
    await expect(page.locator('.card-row .card-price')).toHaveText('$2.00–$10.00');
    await expect(page.locator('#s-value')).toHaveText('$2.00–$10.00');
    const confirm = page.locator('button[data-variant-confirm]');
    await expect(confirm).toHaveCount(1);
    await expect(confirm).toHaveAttribute('aria-label', /Suggested printing Reverse Holo/);
    await confirm.evaluate((b) => b.click());
    await expect(page.locator('button[data-variant-confirm]')).toHaveCount(0);
    await expect(page.locator('.card-row .card-price')).toHaveText('$4.00');
    await expect(page.locator('#s-value')).toHaveText('$4.00');
    await expect(page.locator('#lot-edition')).toBeHidden();
    await page.close();
  });

  test('the lot summary counts the cards still to confirm next to the sure total', async () => {
    const page = await popupWithScan(() => {
      const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
      return [
        { identity: { id: 'x-1', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' }, confidence: 0.9, abstain: false, market_price: 5, price_grid: grid(5), box: [0, 0, 1, 1] },
        { identity: null, confidence: 0.3, abstain: true, topGuess: { id: 'a', name: 'Mew', set: 'Fossil', setCode: 'base3', number: '8' }, box: [0, 0, 1, 1] },
        { identity: null, confidence: 0.2, abstain: true, box: [0, 0, 1, 1] },
        { cardBack: true, box: [0, 0, 1, 1] },
      ];
    });
    const totals = page.locator('#lot-totals');
    await expect(totals).toBeVisible();
    await expect(totals.locator('.lt-item').first()).toContainText('Sure $5.00 (1)');
    const toConfirm = totals.locator('.lt-guess');
    await expect(toConfirm).toContainText('To confirm');
    await expect(toConfirm.locator('b')).toHaveText('2');
    await expect(toConfirm).toHaveAttribute('title', /Confirm each card to see its price/);
    await page.close();
  });

  test('one Base Set edition for the lot applies to every row not picked individually', async () => {
    const page = await popupWithScan(() => {
      const row = (n) => ({ market: n, conditions: { NM: n } });
      const baseHolo = (id, name, number) => ({
        identity: { id, name, set: 'Base Set', setCode: 'base1', number },
        confidence: 0.9, abstain: false, box: [0, 0, 1, 1],
        finishSure: 'holofoil', variant: { edition: null, finish: 'holofoil', stamp: 'none' },
        price_grid: { source: 'pokemontcg', variants: { unlimitedHolofoil: row(40), shadowlessHolofoil: row(300), '1stEditionHolofoil': row(3000) } },
      });
      return [
        baseHolo('base1-4', 'Charizard', '4'),
        baseHolo('base1-2', 'Blastoise', '2'),
        { identity: { id: 'x-1', name: 'Pikachu', set: 'Jungle', setCode: 'base2', number: '60' }, confidence: 0.9, abstain: false, box: [0, 0, 1, 1],
          price_grid: { source: 'pokemontcg', variants: { normal: row(5) } } },
      ];
    });
    const prices = page.locator('.card-row .card-price');
    await expect(prices).toHaveText(['$40.00–$3000.00', '$40.00–$3000.00', '$5.00']);
    const lot = page.getByLabel('Base Set editions', { exact: true }).locator('select');
    await expect(lot).toBeVisible();
    await expect(lot.locator('option')).toHaveText(['Apply to all…', 'Unlimited', 'Shadowless', '1st Edition']);

    // The second row is set on its own first; the lot choice must leave it alone.
    await page.locator('.card-row[data-idx="1"] .variant-select-row select').selectOption('1stEditionHolofoil');
    await expect(prices).toHaveText(['$40.00–$3000.00', '$3000.00', '$5.00']);

    // Keyboard reachable: focus the control and change it with the arrow keys.
    await lot.focus();
    await page.keyboard.press('ArrowDown');
    await expect(lot).toHaveValue('unlimited');
    await expect(prices).toHaveText(['$40.00', '$3000.00', '$5.00']);
    await expect(page.locator('.card-row[data-idx="0"] .variant-select-row select')).toHaveValue('unlimitedHolofoil');

    await lot.selectOption('shadowless');
    await expect(prices).toHaveText(['$300.00', '$3000.00', '$5.00']);
    await page.close();
  });
});
