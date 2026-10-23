/**
 * Live load of the consumer extension (dist/extension-wasm).
 * Confirms the popup a buyer sees actually opens, and that the service worker starts.
 *
 * Run: npx playwright test extension-wasm-popup --project=extension
 */

import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
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
    // The card to choose comes first, under "To confirm"; confirmed rows follow.
    await expect(page.locator('.card-price')).toHaveText(['—', '$5.00', '$7.50']);
    await expect(page.locator('.card-row .picker-title')).toHaveText('Which card is this?');
    await expect(page.locator('.picker-sub')).toHaveText('Closest matches, best one first');
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
        { identity: null, confidence: 0.3, abstain: true, candidates: [{ id: 'a', name: 'Mew', set: 'Fossil', setCode: 'base3', number: '8' }], box: [0, 0, 1, 1] },
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

  // ─── Choose flow: two states only, confirmed or choose ───

  const SHOTS = path.resolve(__dirname, '../../.tmp/choose-flow');

  // Real pictures for the crop and the card art, so screenshots show what the list looks like.
  async function swatch(color, format) {
    const image = sharp({ create: { width: 126, height: 176, channels: 3, background: color } });
    const buffer = format === 'png' ? await image.png().toBuffer() : await image.jpeg().toBuffer();
    return `data:image/${format};base64,${buffer.toString('base64')}`;
  }

  // Opens a popup whose scan returns { cards, priced } built by `build(crop, arts)` inside the page.
  // Records saveCorrection and overlay pushes; priceCard answers from `priced`.
  async function popupWithChoose(build) {
    const crop = await swatch('#8855cc', 'jpeg');
    const arts = await Promise.all(['#cc5555', '#55aa66', '#5577cc', '#ccaa44', '#aa55aa'].map((c) => swatch(c, 'png')));
    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 720 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(({ src, crop, arts }) => {
      const { cards, priced } = new Function(`return (${src})`)()(crop, arts);
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__sent = [];
      window.__overlay = [];
      chrome.runtime.sendMessage = async (msg) => {
        if (msg?.action === 'scanPage') return { cards, scanId: 'c', srcWidth: 10, srcHeight: 10, pending: 0 };
        if (msg?.action === 'saveCorrection') { window.__sent.push(msg); return { ok: true }; }
        if (msg?.action === 'priceCard') return priced[msg.id] || { error: 'no price' };
        if (msg?.action === 'overlayWithGrid') { window.__overlay.push(msg); return { ok: true }; }
        if (msg?.action === 'highlightCard') return { ok: true };
        return real(msg);
      };
    }, { src: build.toString(), crop, arts });
    await page.evaluate(() => { document.getElementById('setup-overlay').style.display = 'none'; });
    await page.evaluate(() => { const b = document.getElementById('btn-scan'); b.disabled = false; b.click(); });
    return page;
  }

  // Two confirmed cards and four to choose: #2 has a candidate matching the photo's name line (preselected over the closest),
  // #4 leads clearly, #5 and #6 are close calls (tight scores, then no scores at all).
  const chooseScan = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const multi = { source: 'pokemontcg', variants: {
      normal: { market: 2, conditions: { NM: 2 } },
      holofoil: { market: 10, conditions: { NM: 10 } },
    } };
    const row = (id, name, set, setCode, number, art) => ({ id, name, set, setCode, number, imageUrl: art });
    const a1 = row('a-1', 'Pidgey', 'Jungle', 'base2', '57', arts[0]);
    const b2 = row('b-2', 'Rattata', 'Base Set', 'base1', '61', arts[1]);
    const c3 = row('c-3', 'Spearow', 'Jungle', 'base2', '62', arts[2]);
    const d4 = row('d-4', 'Zubat', 'Fossil', 'base3', '57', arts[3]);
    const e5 = row('e-5', 'Gastly', 'Fossil', 'base3', '50', arts[4]);
    const cards = [
      { identity: { id: 'x-1', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' }, confidence: 0.9, abstain: false, market_price: 5, price_grid: grid(5), box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.3, abstain: true, candidates: [a1, b2, c3], titleContradicts: 'Rattata', crop, box: [0, 0, 1, 1] },
      { identity: { id: 'x-2', name: 'Raichu', set: 'Base', setCode: 'base1', number: '14' }, confidence: 0.9, abstain: false, market_price: 7.5, price_grid: grid(7.5), box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.2, abstain: true, candidates: [d4, e5], ranked: [{ id: 'd-4', rank: 0.9 }, { id: 'e-5', rank: 0.8 }], crop, box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.2, abstain: true, candidates: [c3, e5], ranked: [{ id: 'c-3', rank: 0.9 }, { id: 'e-5', rank: 0.89 }], crop, box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.2, abstain: true, candidates: [c3, b2], crop, box: [0, 0, 1, 1] },
    ];
    const priced = {
      'a-1': { identity: a1, market_price: 3, price_variant: 'normal', price_grid: multi },
      'b-2': { identity: b2, market_price: 4, price_variant: 'normal', price_grid: grid(4) },
      'c-3': { identity: c3, market_price: 6, price_variant: 'normal', price_grid: grid(6) },
      'd-4': { identity: d4, market_price: 1, price_variant: 'normal', price_grid: grid(1) },
    };
    return { cards, priced };
  };

  test('a card below the bar is a choice: its crop beside the closest cards, best preselected, no name or price', async () => {
    const page = await popupWithChoose(chooseScan);
    const group = page.locator('#results > .choose-group');
    await expect(group).toHaveCount(1);
    await expect(group.locator('.choose-toggle')).toHaveText('To confirm (4)');
    await expect(page.locator('.choose-review')).toHaveText('Review all 4');
    const row = page.locator('.choose-row').first();
    await expect(row.locator('.scanned-card img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    await expect(row.locator('.pick-choice')).toHaveCount(3);
    await expect(row.locator('.pick-choice').first().locator('.pick-best')).toHaveText('Best match');
    await expect(row.locator('.pick-best')).toHaveCount(1);
    await expect(row.locator('.pick-choice').first().locator('img')).toHaveAttribute('src', /^data:image\/png/);
    // The candidate whose name matches the photo's name line is preselected: first, with the agreement mark and the best tag.
    await expect(row.locator('.pick-choice').first()).toContainText('Rattata');
    await expect(row.locator('.pick-choice').first()).toContainText('Base Set #61');
    await expect(row.locator('.pick-agree')).toHaveCount(1);
    await expect(row.locator('.pick-choice[data-pick="b-2"] .pick-agree')).toHaveCount(1);
    await expect(row.locator('.pick-choice[data-pick="b-2"] .pick-best')).toHaveCount(1);
    await expect(row.locator('.pick-choice').nth(1)).toContainText('Pidgey');
    await expect(row.locator('.card-price')).toHaveText('—');
    await expect(row.locator('.card-name')).toHaveText('Card 2');
    await expect(row.locator('[data-confirm-best]')).toHaveText('Confirm Rattata');
    await expect(row.locator('[data-open-search]')).toHaveText('None of these? Search');
    await expect(page.locator('#s-value')).toHaveText('$12.50');
    // The page overlay is told: choose for the three, identified for the two, and nothing to name.
    const overlay = await page.evaluate(() => window.__overlay.at(-1).cards.map((c) => [c.display?.state, c.display?.name ?? null, c.display?.price ?? null]));
    expect(overlay).toEqual([['identified', 'Pikachu', 5], ['choose', null, null], ['identified', 'Raichu', 7.5], ['choose', null, null], ['choose', null, null], ['choose', null, null]]);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'choose-list.png') });
    await page.close();
  });

  test('confirming the preselected card saves it as before, moves the row to confirmed and shows a range until the printing is picked', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row').first().locator('[data-confirm-best]').click();
    await expect(page.locator('.choose-toggle')).toHaveText('To confirm (3)');
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'saveCorrection', scanId: 'c', index: 1, pickedId: 'b-2', via: 'candidates' });
    await expect(page.locator('.card-row[data-idx="1"] .card-price')).toHaveText('$4.00');
    await expect(page.locator('.card-row[data-idx="1"] .card-name')).toContainText('Rattata');
    await expect(page.locator('.choose-row')).toHaveCount(3);
    await page.close();
  });

  test('tapping another candidate confirms that one, with its price', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row').first().locator('.pick-choice[data-pick="a-1"]').click();
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ index: 1, pickedId: 'a-1', via: 'candidates' });
    // Pidgey has two printings: a range, not one auto-picked price.
    await expect(page.locator('.card-row[data-idx="1"] .card-price')).toHaveText('$2.00–$10.00');
    await expect(page.locator('.card-row[data-idx="1"] .card-name')).toContainText('Pidgey');
    await page.close();
  });

  test('keyboard: Tab reaches the confirm button after the candidates, Enter confirms, focus stays in the row', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row').first().locator('.pick-choice').first().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('.choose-row').first().locator('[data-confirm-best]')).toBeFocused();
    await expect(page.locator('.choose-row').first().locator('[data-confirm-best]')).toHaveAccessibleName(/Confirm the best match for card 2: Rattata, Base Set, number 61/);
    await page.keyboard.press('Enter');
    await expect(page.locator('.card-row[data-idx="1"] .card-name')).toContainText('Rattata');
    const rowOfFocus = await page.evaluate(() => document.activeElement?.closest('.card-row')?.dataset.idx ?? null);
    expect(rowOfFocus).toBe('1');
    await page.close();
  });

  test('review all: clear matches ticked, the rest unticked and marked Check, Confirm N counts ticks, Escape closes', async () => {
    const page = await popupWithChoose(chooseScan);
    const panel = page.locator('#bulk-panel');
    await expect(panel).toBeHidden();
    await page.locator('.choose-review').click();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Ticked pairs look like clear matches; check the others yourself.');
    await expect(panel.locator('.bulk-pair')).toHaveCount(4);
    // Ticked: #2 (name matches the photo) and #4 (clear lead). Unticked: #5 (tight scores) and #6 (no scores).
    await expect(panel.locator('.bulk-keep:checked')).toHaveCount(2);
    await expect(panel.locator('.bulk-keep[data-idx="1"]')).toBeChecked();
    await expect(panel.locator('.bulk-keep[data-idx="3"]')).toBeChecked();
    await expect(panel.locator('.bulk-keep[data-idx="4"]')).not.toBeChecked();
    await expect(panel.locator('.bulk-keep[data-idx="5"]')).not.toBeChecked();
    await expect(panel.locator('.bulk-check')).toHaveCount(2);
    await expect(panel.locator('.bulk-pair[data-idx="4"] .bulk-check')).toHaveText('Check');
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 2');
    await expect(page.locator('#bulk-confirm')).toBeEnabled();
    await expect(panel.locator('.bulk-pair').first()).toContainText('Rattata');
    // Big enough to compare: the photo and the candidate art are at least 88 px tall.
    for (const img of await panel.locator('.bulk-pair').first().locator('.bulk-img').all()) {
      expect((await img.boundingBox()).height).toBeGreaterThanOrEqual(88);
    }
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'bulk-grid.png') });

    // Escape closes without confirming anything, and focus goes back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('.choose-review')).toBeFocused();
    expect(await page.evaluate(() => window.__sent.length)).toBe(0);

    await page.locator('.choose-review').click();
    await panel.locator('.bulk-keep[data-idx="4"]').check();
    await panel.locator('.bulk-keep[data-idx="3"]').uncheck();
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 2');
    await expect(panel.locator('.bulk-pair.skipped')).toHaveCount(2);
    await page.locator('#bulk-confirm').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('.choose-toggle')).toHaveText('To confirm (2)');
    await expect(page.locator('.choose-row')).toHaveCount(2);
    const sent = await page.evaluate(() => window.__sent.map((m) => [m.index, m.pickedId, m.via]));
    expect(sent).toEqual([[1, 'b-2', 'candidates'], [4, 'c-3', 'candidates']]);
    await expect(page.locator('.card-row[data-idx="1"] .card-price')).toHaveText('$4.00');
    await expect(page.locator('.card-row[data-idx="4"] .card-price')).toHaveText('$6.00');
    await page.close();
  });

  test('review all with nothing ticked: Confirm is disabled and says what to do', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-review').click();
    const panel = page.locator('#bulk-panel');
    await expect(panel.locator('#bulk-hint')).toBeHidden();
    await panel.locator('.bulk-keep[data-idx="1"]').uncheck();
    await panel.locator('.bulk-keep[data-idx="3"]').uncheck();
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 0');
    await expect(page.locator('#bulk-confirm')).toBeDisabled();
    await expect(panel.locator('#bulk-hint')).toBeVisible();
    await expect(panel.locator('#bulk-hint')).toHaveText('Tick the ones that look right');
    await panel.locator('.bulk-keep[data-idx="4"]').check();
    await expect(panel.locator('#bulk-hint')).toBeHidden();
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 1');
    await page.close();
  });

  // No title evidence anywhere: #1 leads on similarity score alone, #2 only differs by printing, #3 is a tight call.
  const scoreScan = (crop, arts) => {
    const row = (id, name, set, setCode, number, art) => ({ id, name, set, setCode, number, imageUrl: art });
    const a1 = row('a-1', 'Pidgey', 'Jungle', 'base2', '57', arts[0]);
    const a2 = row('a-2', 'Pidgey', 'Base Set', 'base1', '57', arts[1]);
    const b2 = row('b-2', 'Rattata', 'Base Set', 'base1', '61', arts[2]);
    const c3 = row('c-3', 'Spearow', 'Jungle', 'base2', '62', arts[3]);
    const sc = (...p) => p.map(([id, score]) => ({ id, rank: score, score }));
    const cards = [
      { identity: null, confidence: 0.2, abstain: true, candidates: [a1, b2], ranked: sc(['a-1', 0.9], ['b-2', 0.8]), crop, box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.2, abstain: true, candidates: [a1, a2], ranked: sc(['a-1', 0.9], ['a-2', 0.7]), crop, box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.2, abstain: true, candidates: [c3, b2], ranked: sc(['c-3', 0.9], ['b-2', 0.89]), crop, box: [0, 0, 1, 1] },
    ];
    return { cards, priced: {} };
  };

  test('review all: a lead on similarity score is ticked without title evidence; a printing-only pair is not', async () => {
    const page = await popupWithChoose(scoreScan);
    await page.locator('.choose-review').click();
    const panel = page.locator('#bulk-panel');
    await expect(panel.locator('.bulk-keep:checked')).toHaveCount(1);
    await expect(panel.locator('.bulk-keep[data-idx="0"]')).toBeChecked();
    await expect(panel.locator('.bulk-pair[data-idx="0"] .bulk-check')).toHaveCount(0);
    await expect(panel.locator('.bulk-keep[data-idx="1"]')).not.toBeChecked();
    await expect(panel.locator('.bulk-pair[data-idx="1"] .bulk-check')).toHaveText('Check');
    await expect(panel.locator('.bulk-keep[data-idx="2"]')).not.toBeChecked();
    await page.close();
  });

  test('review all: Tick all / Untick all only changes the ticks; Confirm N still needs its own press', async () => {
    const page = await popupWithChoose(scoreScan);
    await page.locator('.choose-review').click();
    const panel = page.locator('#bulk-panel');
    const toggle = panel.getByRole('button', { name: 'Tick all' });
    await expect(toggle).toBeVisible();
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 1');
    await toggle.click();
    await expect(panel.locator('.bulk-keep:checked')).toHaveCount(3);
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 3');
    await expect(panel.locator('.bulk-pair.skipped')).toHaveCount(0);
    expect(await page.evaluate(() => window.__sent.length)).toBe(0);
    await expect(panel.getByRole('button', { name: 'Untick all' })).toBeVisible();
    await panel.getByRole('button', { name: 'Untick all' }).click();
    await expect(panel.locator('.bulk-keep:checked')).toHaveCount(0);
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 0');
    await expect(page.locator('#bulk-confirm')).toBeDisabled();
    // Unticking one pair by hand after Tick all flips the label back.
    await panel.getByRole('button', { name: 'Tick all' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 3');
    await panel.locator('.bulk-keep[data-idx="2"]').uncheck();
    await expect(panel.getByRole('button', { name: 'Tick all' })).toBeVisible();
    await page.close();
  });

  test('review all can be driven from the keyboard: Space toggles a pair, Tab stays inside the panel', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-review').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#bulk-panel .bulk-keep').first()).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('#bulk-confirm')).toHaveText('Confirm 1');
    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.getElementById('bulk-panel').contains(document.activeElement));
    expect(inside).toBe(true);
    await page.close();
  });
});
