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
    await expect(page.locator('.set-select-row [role="radio"][aria-checked="true"]')).toHaveAttribute('data-strip-pick', 'sv02-5');
    await expect(page.locator('#s-value')).toHaveText('$3.00');
    await expect(page.locator('.card-row .card-price')).toHaveText('$3.00');

    await mark.evaluate((b) => b.click());
    await expect(page.locator('.card-row .guess-mark')).toHaveCount(0);
    await expect(page.locator('.set-select-row [role="radio"][aria-checked="true"]')).toHaveAttribute('data-strip-pick', 'sv02-5');
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
    await expect(page.locator('.set-select-row [role="radio"][aria-checked="true"]')).toHaveAttribute('data-strip-pick', 'sv02-5');
    await expect(page.locator('.card-row .guess-mark')).toHaveCount(1);
    await page.locator('.card-row .guess-mark').evaluate((b) => b.click());
    await expect(page.locator('.card-row .card-price')).toHaveText('$3.00');
    await page.close();
  });

  test('the ? beside the finish chips confirms the suggested printing: no price until then, then one price', async () => {
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
    const suggestedChip = page.locator('.variant-select-row:not(.set-select-row) .chip-suggested');
    await expect(suggestedChip).toHaveAttribute('data-strip-pick', 'reverseHolofoil');
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
    await expect(totals.locator('.lt-item').first()).toContainText('Confirmed value $5.00 (1)');
    const toConfirm = totals.locator('.lt-guess');
    await expect(toConfirm).toContainText('To confirm');
    await expect(toConfirm.locator('b')).toHaveText('2');
    await expect(toConfirm).toHaveAttribute('title', /Confirm each card to see its price/);
    await page.close();
  });

  test('the lot summary says how many confirmed cards have no price data', async () => {
    const page = await popupWithScan(() => {
      const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
      return [
        { identity: { id: 'x-1', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' }, confidence: 0.9, abstain: false, market_price: 5, price_grid: grid(5), box: [0, 0, 1, 1] },
        { identity: { id: 'x-8', name: 'Machamp', set: 'Base', setCode: 'base1', number: '8' }, confidence: 0.9, abstain: false, market_price: null, price_grid: null, box: [0, 0, 1, 1] },
      ];
    });
    const sure = page.locator('#lot-totals .lt-item').first();
    await expect(sure).toContainText('Confirmed value $5.00 (2, 1 without price)');
    await expect(sure.locator('.lt-n')).toHaveAttribute('title', '1 confirmed card has no price data');
    await page.close();
  });

  const exportLot = () => {
    const grid = (nm) => ({ source: 'pokemontcg', updatedAt: new Date().toISOString(), variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const pika = { identity: { id: 'x-1', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' }, confidence: 0.9, abstain: false, market_price: 5, price_grid: grid(5), box: [0, 0, 1, 1] };
    return [
      pika,
      { ...pika, box: [0, 0, 1, 1] },
      { identity: { id: 'x-2', name: 'Farfetch\'d, "Ash"', set: 'Jungle', setCode: 'base2', number: '27' }, confidence: 0.9, abstain: false, market_price: 3, price_grid: grid(3), box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.3, abstain: true, candidates: [{ id: 'a', name: 'Mew', set: 'Fossil', setCode: 'base3', number: '8' }], box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.2, abstain: true, box: [0, 0, 1, 1] },
    ];
  };

  test('the lot strip offers Copy and CSV for the confirmed cards, with a tooltip for the rest', async () => {
    const page = await popupWithScan(exportLot);
    const copy = page.locator('#lot-totals [data-lot-copy]');
    const csv = page.locator('#lot-totals [data-lot-csv]');
    await expect(copy).toHaveText('Copy 3 confirmed');
    await expect(csv).toHaveText('Download CSV (3)');
    await expect(copy).toHaveAttribute('aria-label', 'Copy 3 confirmed');
    await expect(csv).toHaveAttribute('aria-label', 'Download CSV (3)');
    await expect(copy).toHaveAttribute('title', '2 more cards still need confirming and are not included');
    await expect(csv).toHaveAttribute('title', '2 more cards still need confirming and are not included');
    await copy.focus();
    await expect(copy).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(csv).toBeFocused();
    await page.close();
  });

  test('with no confirmed card the lot strip has no export buttons', async () => {
    const page = await popupWithScan(() => [
      { identity: null, confidence: 0.3, abstain: true, candidates: [{ id: 'a', name: 'Mew', set: 'Fossil', setCode: 'base3', number: '8' }], box: [0, 0, 1, 1] },
    ]);
    await expect(page.locator('#lot-totals')).toBeVisible();
    await expect(page.locator('#lot-totals [data-lot-copy], #lot-totals [data-lot-csv]')).toHaveCount(0);
    await page.close();
  });

  test('Copy puts a tab-separated block on the clipboard and says how many cards', async () => {
    const page = await popupWithScan(exportLot);
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } });
    });
    await page.locator('[data-lot-copy]').evaluate((b) => b.click());
    await expect(page.locator('#msg-bar')).toHaveText('Copied 3 cards');
    const text = await page.evaluate(() => window.__copied);
    const lines = text.split('\n').filter(Boolean);
    expect(lines[0]).toBe('Name\tSet\tNumber\tPrinting\tFinish\tCondition\tQty\tPrice\tLow\tHigh\tPrice source\tPrice date\tPrice age days\tBasis');
    expect(lines).toHaveLength(3);
    const pika = lines[1].split('\t');
    expect(pika.slice(0, 3)).toEqual(['Pikachu', 'Base', '58']);
    expect(pika[5]).toBe('NM');
    expect(pika[6]).toBe('2');
    expect(pika[7]).toBe('5.00');
    expect(pika[13]).toBe('raw, English, Near Mint');
    expect(text).not.toMatch(/Mew|http/);
    await page.close();
  });

  test('a refused clipboard write falls back to the textarea copy and still reports; both failing says use CSV', async () => {
    const page = await popupWithScan(exportLot);
    await page.evaluate(() => {
      window.__fallback = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
      document.execCommand = (cmd) => { window.__fallback = document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement.value : 'no textarea'; return cmd === 'copy'; };
    });
    await page.locator('[data-lot-copy]').evaluate((b) => b.click());
    await expect(page.locator('#msg-bar')).toHaveText('Copied 3 cards');
    expect(await page.evaluate(() => window.__fallback)).toMatch(/^Name\tSet\tNumber/);
    await expect(page.locator('textarea')).toHaveCount(0);
    await page.evaluate(() => { document.execCommand = () => false; });
    await page.locator('[data-lot-copy]').evaluate((b) => b.click());
    await expect(page.locator('#msg-bar')).toHaveText('Copy failed: use Download CSV');
    await page.close();
  });

  test('Download CSV saves card-lot-DATE.csv as UTF-8 with a BOM and CRLF line endings', async () => {
    const page = await popupWithScan(exportLot);
    await page.evaluate(() => {
      window.__download = null;
      window.HTMLAnchorElement.prototype.click = function click() {
        window.__download = { name: this.download, href: this.href };
        fetch(this.href).then((r) => r.arrayBuffer()).then((b) => { window.__download.bytes = Array.from(new Uint8Array(b)); });
      };
    });
    await page.locator('[data-lot-csv]').evaluate((b) => b.click());
    await page.waitForFunction(() => window.__download?.bytes);
    const file = await page.evaluate(() => window.__download);
    expect(file.name).toMatch(/^card-lot-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.href).toMatch(/^blob:/);
    expect(file.bytes.slice(0, 3)).toEqual([0xEF, 0xBB, 0xBF]);
    const text = Buffer.from(file.bytes.slice(3)).toString('utf8');
    expect(text.startsWith('Name,Set,Number,Printing')).toBe(true);
    expect(text.split('\r\n')).toHaveLength(4);
    expect(text).not.toMatch(/(^|[^\r])\n/);
    expect(text).toContain('"Farfetch\'d, ""Ash"""');
    await expect(page.locator('#msg-bar')).toContainText('Saved 3 cards as card-lot-');
    await page.close();
  });

  test('the est. value header and the lot strip say the prices are Near Mint', async () => {
    const page = await popupWithScan(exportLot);
    const tip = 'Prices are Near Mint market prices unless your price-service key provides other conditions';
    await expect(page.locator('#s-cond')).toHaveText('NM');
    await expect(page.locator('#s-cond')).toHaveAttribute('title', tip);
    await expect(page.locator('#lot-totals .lt-cond')).toHaveText('Near Mint');
    await expect(page.locator('#lot-totals .lt-cond')).toHaveAttribute('title', tip);
    await page.locator('#btn-clear').evaluate((b) => b.click());
    await expect(page.locator('#s-cond')).toBeHidden();
    await page.close();
  });

  test('Clear returns the popup to its empty state: no lot line, groups, or value', async () => {
    const page = await popupWithScan(() => [
      { identity: { id: 'x-1', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' }, confidence: 0.9, abstain: false, market_price: 5,
        price_grid: { source: 'pokemontcg', variants: { normal: { market: 5, conditions: { NM: 5 } } } }, box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.3, abstain: true, candidates: [{ id: 'a', name: 'Mew', set: 'Fossil', setCode: 'base3', number: '8' }], box: [0, 0, 1, 1] },
    ]);
    await expect(page.locator('#lot-totals')).toBeVisible();
    await expect(page.locator('#results .card-row, #results .choose-group').first()).toBeVisible();
    await page.locator('#btn-clear').evaluate((b) => b.click());
    await expect(page.locator('#lot-totals')).toBeHidden();
    await expect(page.locator('#lot-totals')).toHaveText('');
    await expect(page.locator('#lot-edition')).toBeHidden();
    await expect(page.locator('#fullsize-notice')).toBeHidden();
    await expect(page.locator('#results .card-row')).toHaveCount(0);
    await expect(page.locator('#results .choose-group, #results [data-review-all]')).toHaveCount(0);
    await expect(page.locator('#s-value')).toHaveText('—');
    await expect(page.locator('#empty-hint')).toBeVisible();
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
    await page.locator('.card-row[data-idx="1"] .chip[data-strip-pick="1stEditionHolofoil"]').evaluate((b) => b.click());
    await expect(prices).toHaveText(['$40.00–$3000.00', '$3000.00', '$5.00']);

    // Keyboard reachable: focus the control and change it with the arrow keys.
    await lot.focus();
    await page.keyboard.press('ArrowDown');
    await expect(lot).toHaveValue('unlimited');
    await expect(prices).toHaveText(['$40.00', '$3000.00', '$5.00']);
    await expect(page.locator('.card-row[data-idx="0"] .chip[aria-checked="true"]')).toHaveAttribute('data-strip-pick', 'unlimitedHolofoil');

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
  async function popupWithChoose(build, saveResp = { ok: true }) {
    const crop = await swatch('#8855cc', 'jpeg');
    const arts = await Promise.all(['#cc5555', '#55aa66', '#5577cc', '#ccaa44', '#aa55aa'].map((c) => swatch(c, 'png')));
    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 720 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(({ src, crop, arts, saveResp }) => {
      const { cards, priced, found, rescan } = new Function(`return (${src})`)()(crop, arts);
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__sent = [];
      window.__overlay = [];
      window.__priceCalls = [];
      let scans = 0;
      chrome.runtime.sendMessage = async (msg) => {
        if (msg?.action === 'scanPage') { scans += 1; return { cards: scans > 1 && rescan ? rescan : cards, scanId: 'c', srcWidth: 10, srcHeight: 10, pending: 0 }; }
        if (msg?.action === 'saveCorrection' || msg?.action === 'saveSkip' || msg?.action === 'unskip') { window.__sent.push(msg); return msg.action === 'saveCorrection' ? saveResp : { ok: true }; }
        if (msg?.action === 'findCards') return { cards: found || [] };
        if (msg?.action === 'priceCard') { window.__priceCalls.push(msg.id); return priced[msg.id] || { error: 'no price' }; }
        if (msg?.action === 'overlayWithGrid') { window.__overlay.push(msg); return { ok: true }; }
        if (msg?.action === 'highlightCard') return { ok: true };
        return real(msg);
      };
    }, { src: build.toString(), crop, arts, saveResp });
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

  test('keyboard: Tab reaches the confirm button after the candidates, Enter confirms, focus moves on to the next row to confirm', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row').first().locator('.pick-choice').first().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('.choose-row').first().locator('[data-confirm-best]')).toBeFocused();
    await expect(page.locator('.choose-row').first().locator('[data-confirm-best]')).toHaveAccessibleName(/Confirm the best match for card 2: Rattata, Base Set, number 61/);
    await page.keyboard.press('Enter');
    await expect(page.locator('.card-row[data-idx="1"] .card-name')).toContainText('Rattata');
    // The confirmed row is no longer a row to choose: focus advances to the next one's preselected Confirm button.
    const next = page.locator('.choose-row[data-idx="3"] [data-confirm-best]');
    await expect(next).toBeFocused();
    await expect(page.locator('#msg-bar')).toHaveText('Confirmed Rattata. 3 to confirm.');
    await page.close();
  });

  test('keyboard: confirming the last row to confirm moves focus to the lot Copy button and keeps it there', async () => {
    const page = await popupWithChoose(chooseScan);
    for (const idx of [1, 3, 4, 5]) {
      const confirm = page.locator(`.choose-row[data-idx="${idx}"] [data-confirm-best]`);
      await confirm.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(`.card-row[data-idx="${idx}"] .card-price`)).toHaveText(/\$/);
    }
    await expect(page.locator('#lot-totals [data-lot-copy]')).toBeFocused();
    await expect(page.locator('#msg-bar')).toHaveText(/^Confirmed .+\. Nothing left to confirm\.$/);
    await page.close();
  });

  test('confirming with a mouse click does not move keyboard focus around the page', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row[data-idx="1"] [data-confirm-best]').click();
    await expect(page.locator('.card-row[data-idx="1"] .card-name')).toContainText('Rattata');
    await expect(page.locator('#msg-bar')).toContainText('Confirmed Rattata');
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
    // Pair 1 was the scanner's own preselection (confirmed, not saved); pair 4 was a Check pair ticked by hand (saved).
    expect(sent).toEqual([[4, 'c-3', 'candidates']]);
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

  // Self-contained (it runs inside the page): #0 leads on score (preticked), #1 is a Check pair; both priced.
  const bulkSaveScan = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const row = (id, name, set, setCode, number, art) => ({ id, name, set, setCode, number, imageUrl: art });
    const a1 = row('a-1', 'Pidgey', 'Jungle', 'base2', '57', arts[0]);
    const a2 = row('a-2', 'Pidgey', 'Base Set', 'base1', '57', arts[1]);
    const b2 = row('b-2', 'Rattata', 'Base Set', 'base1', '61', arts[2]);
    const sc = (...p) => p.map(([id, score]) => ({ id, rank: score, score }));
    return {
      cards: [
        { identity: null, confidence: 0.2, abstain: true, candidates: [a1, b2], ranked: sc(['a-1', 0.9], ['b-2', 0.8]), crop, box: [0, 0, 1, 1] },
        { identity: null, confidence: 0.2, abstain: true, candidates: [a1, a2], ranked: sc(['a-1', 0.9], ['a-2', 0.7]), crop, box: [0, 0, 1, 1] },
      ],
      priced: { 'a-1': { identity: a1, market_price: 3, price_variant: 'normal', price_grid: grid(3) } },
    };
  };

  test('review all: Tick all confirms for the session but saves no correction; a Check pair ticked by hand is saved', async () => {
    const page = await popupWithChoose(bulkSaveScan);
    await page.locator('.choose-review').click();
    const panel = page.locator('#bulk-panel');
    await panel.getByRole('button', { name: 'Tick all' }).click();
    await page.locator('#bulk-confirm').click();
    await expect(page.locator('.card-row[data-idx="0"] .card-price')).toHaveText('$3.00');
    await expect(page.locator('.card-row[data-idx="1"] .card-price')).toHaveText('$3.00');
    await expect(page.locator('.choose-row')).toHaveCount(0);
    expect(await page.evaluate(() => window.__sent)).toEqual([]);
    await page.close();

    const again = await popupWithChoose(bulkSaveScan);
    await again.locator('.choose-review').click();
    await again.locator('#bulk-panel .bulk-keep[data-idx="1"]').check();
    await again.locator('#bulk-confirm').click();
    await expect(again.locator('.card-row[data-idx="1"] .card-price')).toHaveText('$3.00');
    // Card 0 was the scanner's own preselection (not saved); card 1 was a Check pair the user ticked themselves.
    const sent = await again.evaluate(() => window.__sent.map((m) => [m.action, m.index]));
    expect(sent).toEqual([['saveCorrection', 1]]);
    await again.close();
  });

  // ─── Stakes: price decides how much picture evidence a card needs ───

  // 0: small photo, cheap candidate (promoted)   1: small photo, expensive candidate (stays Choose)
  // 2: picture-confirmed, not high, $80 (demoted) 3: high tier, $80 (untouched)
  // 4: user-confirmed earlier, not high, $80 (untouched)   5: small photo, price unknown (stays Choose)
  const stakesScan = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const row = (id, name, set, setCode, number, art) => ({ id, name, set, setCode, number, imageUrl: art });
    const cheap = row('c-1', 'Pidgey', 'Jungle', 'base2', '57', arts[0]);
    const cheap2 = row('c-2', 'Rattata', 'Base Set', 'base1', '61', arts[1]);
    const dear = row('x-1', 'Charizard', 'Base Set', 'base1', '4', arts[2]);
    const dear2 = row('x-2', 'Charmeleon', 'Base Set', 'base1', '24', arts[3]);
    const held = row('h-1', 'Blastoise', 'Base Set', 'base1', '2', arts[4]);
    const held2 = row('h-2', 'Wartortle', 'Base Set', 'base1', '42', arts[0]);
    const unk = row('u-1', 'Zubat', 'Fossil', 'base3', '57', arts[1]);
    const cards = [
      { identity: null, confidence: 0.49, abstain: true, unsure: true, smallRow: true, smallRowCos: 0.7, readHeight: 150, candidates: [cheap, cheap2], crop, box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.49, abstain: true, unsure: true, smallRow: true, smallRowCos: 0.7, readHeight: 150, candidates: [dear, dear2], crop, box: [0, 0, 1, 1] },
      { identity: held, confidence: 0.7, abstain: false, market_price: 80, price_grid: grid(80), candidates: [held2, held], crop, box: [0, 0, 1, 1] },
      { identity: { id: 'x-9', name: 'Venusaur', set: 'Base', setCode: 'base1', number: '15' }, confidence: 0.9, abstain: false, market_price: 80, price_grid: grid(80), titleConfirmed: true, box: [0, 0, 1, 1] },
      { identity: { id: 'x-8', name: 'Mewtwo', set: 'Base', setCode: 'base1', number: '10' }, confidence: 0.7, abstain: false, market_price: 80, price_grid: grid(80), userConfirmed: true, candidates: [held, held2], crop, box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.49, abstain: true, unsure: true, smallRow: true, smallRowCos: 0.7, readHeight: 150, candidates: [unk, cheap2], crop, box: [0, 0, 1, 1] },
    ];
    const priced = {
      'c-1': { identity: cheap, market_price: 3, price_variant: 'normal', price_grid: grid(3) },
      'c-2': { identity: cheap2, market_price: 2, price_variant: 'normal', price_grid: grid(2) },
      'x-1': { identity: dear, market_price: 120, price_variant: 'normal', price_grid: grid(120) },
      'h-1': { identity: held, market_price: 80, price_variant: 'normal', price_grid: grid(80) },
    };
    return { cards, priced };
  };

  test('a cheap small-photo card is confirmed without asking, with a price, and nothing is saved or sent for learning', async () => {
    const page = await popupWithChoose(stakesScan);
    await expect(page.locator('.card-row[data-idx="0"] .card-name')).toContainText('Pidgey');
    await expect(page.locator('.card-row[data-idx="0"] .card-price')).toHaveText('$3.00');
    await expect(page.locator('.choose-row[data-idx="0"]')).toHaveCount(0);
    await expect(page.locator('.card-row[data-idx="0"] [data-open-search]')).toHaveText('Wrong card?');
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toEqual([]);
    const overlay = await page.evaluate(() => window.__overlay.at(-1).cards[0].display);
    expect(overlay).toMatchObject({ state: 'identified', name: 'Pidgey', price: 3 });
    await page.close();
  });

  test('an expensive small-photo card stays a choice, and so does one whose price is unknown', async () => {
    const page = await popupWithChoose(stakesScan);
    await expect(page.locator('.card-row[data-idx="0"] .card-name')).toContainText('Pidgey');
    await expect(page.locator('.choose-row[data-idx="1"]')).toHaveCount(1);
    await expect(page.locator('.choose-row[data-idx="1"] .card-price')).toHaveText('—');
    await expect(page.locator('.choose-row[data-idx="5"]')).toHaveCount(1);
    const calls = await page.evaluate(() => window.__priceCalls);
    expect([...calls].sort()).toEqual(['c-1', 'c-2', 'u-1', 'x-1', 'x-2']);
    await page.close();
  });

  test('a cheap small-photo card with a pricier runner-up among its candidates stays a choice', async () => {
    const page = await popupWithChoose((crop, arts) => {
      const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
      const row = (id, name, set, setCode, number, art) => ({ id, name, set, setCode, number, imageUrl: art });
      const cheap = row('c-1', 'Pidgey', 'Jungle', 'base2', '57', arts[0]);
      const promo = row('p-1', 'Pidgey', 'Promo', 'basep', '9', arts[1]);
      return {
        cards: [{ identity: null, confidence: 0.49, abstain: true, unsure: true, smallRow: true, smallRowCos: 0.7, readHeight: 150, candidates: [cheap, promo], crop, box: [0, 0, 1, 1] }],
        priced: {
          'c-1': { identity: cheap, market_price: 3, price_variant: 'normal', price_grid: grid(3) },
          'p-1': { identity: promo, market_price: 60, price_variant: 'normal', price_grid: grid(60) },
        },
      };
    });
    await expect(page.locator('.choose-row[data-idx="0"]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.__priceCalls.length)).toBe(2);
    await expect(page.locator('.card-row[data-idx="0"] .card-price')).toHaveText('—');
    await page.close();
  });

  test('a picture-confirmed card that is not high and costs $50 or more becomes a choice marked as high value', async () => {
    const page = await popupWithChoose(stakesScan);
    await expect(page.locator('.card-row[data-idx="0"] .card-name')).toContainText('Pidgey');
    const row = page.locator('.choose-row[data-idx="2"]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.value-chip')).toHaveText('Check: high value');
    await expect(row.locator('.pick-choice').first()).toContainText('Blastoise');
    await expect(row.locator('[data-confirm-best]')).toHaveText('Confirm Blastoise');
    await expect(row.locator('.card-price')).toHaveText('—');
    const display = await page.evaluate(() => window.__overlay.at(-1).cards[2].display);
    expect(display).toMatchObject({ state: 'choose', valueCheck: true });
    // Confirming it is the user's answer: it is saved, and stays confirmed at that price.
    await row.locator('[data-confirm-best]').click();
    await expect(page.locator('.card-row[data-idx="2"] .card-price')).toHaveText('$80.00');
    await expect(page.locator('.choose-row[data-idx="2"]')).toHaveCount(0);
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'saveCorrection', index: 2, pickedId: 'h-1' });
    await page.close();
  });

  test('a high-tier, title-confirmed or user-confirmed expensive card is untouched', async () => {
    const page = await popupWithChoose(stakesScan);
    await expect(page.locator('.card-row[data-idx="0"] .card-name')).toContainText('Pidgey');
    for (const idx of [3, 4]) {
      await expect(page.locator(`.card-row[data-idx="${idx}"] .card-price`)).toHaveText('$80.00');
      await expect(page.locator(`.choose-row[data-idx="${idx}"]`)).toHaveCount(0);
    }
    await page.close();
  });

  test('a confirmed card whose printings range $0.21 to $103 but typically cost a few dollars is not asked about', async () => {
    const page = await popupWithChoose((crop, arts) => {
      const cond = (nm) => ({ market: nm, conditions: { NM: nm } });
      const potion = { id: 'p-1', name: 'Potion', set: 'Base Set', setCode: 'base1', number: '94', imageUrl: arts[0] };
      const grid = { source: 'pokemontcg', variants: { normal: cond(0.21), reverseHolofoil: cond(0.5), unlimitedHolofoil: cond(10), '1stEditionHolofoil': cond(103.66) } };
      return { cards: [{ identity: potion, confidence: 0.7, abstain: false, market_price: 0.21, price_grid: grid, candidates: [potion], crop, box: [0, 0, 1, 1] }], priced: {} };
    });
    await expect(page.locator('.card-row[data-idx="0"] .card-name')).toContainText('Potion');
    await expect(page.locator('.choose-row')).toHaveCount(0);
    await expect(page.locator('.card-row[data-idx="0"] .card-price')).toHaveText('$0.21–$103.66');
    await page.close();
  });

  test('the lot summary follows: promoted cards are Confirmed value, demoted ones are still to confirm', async () => {
    const page = await popupWithChoose(stakesScan);
    await expect(page.locator('.card-row[data-idx="0"] .card-name')).toContainText('Pidgey');
    const totals = page.locator('#lot-totals');
    await expect(totals.locator('.lt-item').first()).toContainText('Confirmed value $163.00 (3)');
    await expect(totals.locator('.lt-guess b')).toHaveText('3');
    await expect(page.locator('.choose-toggle')).toHaveText('To confirm (3)');
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

  // ─── Image pickers: printings and versions are thumbnails, finishes are chips with prices ───

  const PICKER_SHOTS = path.resolve(__dirname, '../../.tmp/image-pickers');

  const printingScan = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const row = (id, set, setCode, number, art) => ({ id, name: 'Eevee', set, setCode, number, imageUrl: art });
    const sets = [
      row('sv01-5', 'Scarlet & Violet', 'sv01', '005', arts[0]),
      row('sv02-5', 'Paldea Evolved', 'sv02', '005', arts[1]),
      row('pre-74', 'Prismatic Evolutions', 'pre', '74', arts[2]),
    ];
    const cards = [{
      identity: { id: 'sv02-5', name: 'Eevee', set: 'Paldea Evolved', setCode: 'sv02', number: '005' },
      setChoices: sets, setConfirmed: false, setRange: { low: 2, high: 9, count: 3, total: 3 },
      confidence: 0.9, abstain: false, box: [0, 0, 1, 1],
    }];
    return { cards, priced: { 'pre-74': { identity: sets[2], market_price: 9, price_variant: 'normal', price_grid: grid(9) } } };
  };

  test('printings are a strip of card thumbnails with set name and number, in a labelled radiogroup', async () => {
    const page = await popupWithChoose(printingScan);
    const group = page.getByRole('radiogroup', { name: 'Choose the printing' });
    await expect(group).toBeVisible();
    const tiles = group.getByRole('radio');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.first().locator('img')).toHaveAttribute('src', /^data:image\/png/);
    await expect(tiles.nth(2)).toContainText('Prismatic Evolutions');
    await expect(tiles.nth(2)).toContainText('#74');
    await expect(group.getByRole('radio', { name: 'Prismatic Evolutions number 74' })).toHaveCount(1);
    await expect(page.locator('.set-select-row select, .set-select-row option')).toHaveCount(0);
    await expect(page.locator('.card-row .card-price')).toHaveText('$2.00–$9.00');
    fs.mkdirSync(PICKER_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(PICKER_SHOTS, 'printing-strip.png') });
    await page.close();
  });

  test('tapping a printing tile saves the same correction as the old menu and prices that printing', async () => {
    const page = await popupWithChoose(printingScan);
    await page.getByRole('radio', { name: 'Prismatic Evolutions number 74' }).click();
    await expect(page.locator('.card-row .card-price')).toHaveText('$9.00');
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'saveCorrection', scanId: 'c', index: 0, pickedId: 'pre-74', via: 'set-menu' });
    expect(await page.evaluate(() => window.__priceCalls)).toEqual(['pre-74']);
    await expect(page.locator('.set-select-row [aria-checked="true"]')).toHaveAttribute('data-strip-pick', 'pre-74');
    expect(await page.evaluate(() => document.activeElement?.closest('.card-row')?.dataset.idx ?? null)).toBe('0');
    await page.screenshot({ path: path.join(PICKER_SHOTS, 'row-after-pick.png') });
    await page.close();
  });

  test('keyboard: arrows move through the printing strip, Enter selects, focus stays in the row', async () => {
    const page = await popupWithChoose(printingScan);
    const tiles = page.getByRole('radiogroup', { name: 'Choose the printing' }).getByRole('radio');
    await tiles.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tiles.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tiles.nth(2)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tiles.nth(1)).toBeFocused();
    expect(await page.evaluate(() => window.__sent.length)).toBe(0);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.locator('.card-row .card-price')).toHaveText('$9.00');
    expect((await page.evaluate(() => window.__sent))[0]).toMatchObject({ pickedId: 'pre-74', via: 'set-menu' });
    expect(await page.evaluate(() => document.activeElement?.closest('.card-row')?.dataset.idx ?? null)).toBe('0');
    await page.close();
  });

  test('more than 8 printings: the first 8 and a More tile that expands in place', async () => {
    const page = await popupWithChoose((crop, arts) => {
      const sets = Array.from({ length: 11 }, (_, i) => ({ id: `s-${i}`, name: 'Pikachu', set: `Set ${i + 1}`, setCode: `s${i}`, number: String(i + 1), imageUrl: arts[i % 5] }));
      return { cards: [{ identity: sets[0], setChoices: sets, setConfirmed: false, setRange: { low: 1, high: 4, count: 11, total: 11 }, confidence: 0.9, abstain: false, box: [0, 0, 1, 1] }], priced: {} };
    });
    const group = page.getByRole('radiogroup', { name: 'Choose the printing' });
    await expect(group.getByRole('radio')).toHaveCount(8);
    await group.getByRole('button', { name: 'More +3' }).click();
    await expect(group.getByRole('radio')).toHaveCount(11);
    await expect(group.getByRole('button', { name: 'Fewer' })).toBeFocused();
    await group.getByRole('button', { name: 'Fewer' }).click();
    await expect(group.getByRole('radio')).toHaveCount(8);
    await page.close();
  });

  test('art that fails to load becomes a text tile with the name and set, and the choice still works', async () => {
    const page = await popupWithChoose((crop, arts) => {
      const grid = { source: 'pokemontcg', variants: { normal: { market: 7, conditions: { NM: 7 } } } };
      const sets = [
        { id: 'a-1', name: 'Eevee', set: 'Jungle', setCode: 'base2', number: '51', imageUrl: 'data:image/png;base64,AAAA' },
        { id: 'b-1', name: 'Eevee', set: 'Fossil', setCode: 'base3', number: '51', imageUrl: arts[0] },
      ];
      return { cards: [{ identity: sets[0], setChoices: sets, setConfirmed: false, setRange: { low: 1, high: 7, count: 2, total: 2 }, confidence: 0.9, abstain: false, box: [0, 0, 1, 1] }],
        priced: { 'a-1': { identity: sets[0], market_price: 7, price_variant: 'normal', price_grid: grid } } };
    });
    const broken = page.getByRole('radio', { name: 'Jungle number 51' });
    await expect(broken.locator('.strip-art')).toHaveClass(/no-art/);
    await expect(broken.locator('img')).toHaveCount(0);
    await expect(broken.locator('.strip-fallback')).toBeVisible();
    await expect(broken.locator('.strip-fallback')).toContainText('Eevee');
    await expect(broken.locator('.strip-fallback')).toContainText('Jungle');
    await broken.click();
    await expect(page.locator('.card-row .card-price')).toHaveText('$7.00');
    await page.close();
  });

  const versionScan = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const ex = { id: 'p-1', name: 'Pikachu ex', set: 'Surging Sparks', setCode: 'sv08', number: '57', imageUrl: arts[0] };
    const v = { id: 'p-2', name: 'Pikachu V', set: 'Vivid Voltage', setCode: 'swsh4', number: '43', imageUrl: arts[1], market_price: 2, price_variant: 'normal', price_grid: grid(2), setChoices: [] };
    return { cards: [{ identity: ex, confidence: 0.9, abstain: false, market_price: 30, price_grid: grid(30), versionChoices: [v], box: [0, 0, 1, 1] }], priced: {} };
  };

  test('other versions are a thumbnail strip with the version name; one tap swaps the row to it', async () => {
    const page = await popupWithChoose(versionScan);
    const group = page.getByRole('radiogroup', { name: 'Choose the version' });
    await expect(group.getByRole('radio')).toHaveCount(2);
    await expect(group.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
    await expect(group.getByRole('radio').nth(1)).toContainText('Pikachu V');
    await expect(group.getByRole('radio').nth(1).locator('img')).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.locator('.version-select-row select')).toHaveCount(0);
    await group.getByRole('radio').nth(1).click();
    await expect(page.locator('.card-row .card-name')).toContainText('Pikachu V');
    await expect(page.locator('.card-row .card-price')).toHaveText('$2.00');
    await expect(page.getByRole('radiogroup', { name: 'Choose the version' }).getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
    await page.close();
  });

  const finishScan = () => ({
    cards: [{
      identity: { id: 'x-1', name: 'Eevee', set: 'Jungle', setCode: 'base2', number: '51' }, confidence: 0.9, abstain: false, box: [0, 0, 1, 1],
      price_grid: { source: 'pokemontcg', variants: {
        normal: { market: 2, conditions: { NM: 2, LP: 1.5 } },
        holofoil: { market: 10, conditions: { NM: 10, LP: 8 } },
        reverseHolofoil: { market: 4, conditions: { NM: 4 } },
        '1stEditionHolofoil': { market: 0, conditions: {} },
      } },
    }],
    priced: {},
  });

  test('finishes are large chips with the finish and its price; one tap sets the printing and the price', async () => {
    const page = await popupWithChoose(finishScan);
    const group = page.getByRole('radiogroup', { name: /^Choose the finish/ });
    const chips = group.getByRole('radio');
    await expect(chips).toHaveCount(4);
    await expect(chips.nth(0)).toContainText('Normal');
    await expect(chips.nth(0)).toContainText('$2.00');
    await expect(chips.nth(1)).toContainText('$10.00');
    await expect(chips.nth(2)).toContainText('Reverse Holo');
    await expect(chips.nth(2)).toContainText('$4.00');
    await expect(chips.nth(3)).toHaveText('1st Ed Holofoil');
    expect((await chips.nth(0).boundingBox()).height).toBeGreaterThanOrEqual(40);
    await expect(page.locator('.variant-select-row select')).toHaveCount(0);
    await expect(page.locator('.card-row .card-price')).toHaveText('$2.00–$10.00');
    fs.mkdirSync(PICKER_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(PICKER_SHOTS, 'finish-chips.png') });
    await chips.nth(2).click();
    await expect(page.locator('.card-row .card-price')).toHaveText('$4.00');
    await expect(group.getByRole('radio', { name: 'Reverse Holo, $4.00 NM' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#s-value')).toHaveText('$4.00');
    await expect(page.getByRole('radiogroup', { name: /^Choose the finish/ }).getByRole('radio', { name: 'Reverse Holo, $4.00 NM' })).toBeFocused();
    // Arrow keys move, Enter picks.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await expect(page.locator('.card-row .card-price')).toHaveText('$10.00');
    expect(await page.evaluate(() => window.__sent.length)).toBe(0);
    await page.screenshot({ path: path.join(PICKER_SHOTS, 'finish-chosen.png') });
    await page.close();
  });

  test('the status line counts the cards as they are now after a cheap card is promoted', async () => {
    const page = await popupWithChoose(stakesScan);
    await expect(page.locator('.card-row[data-idx="0"] .card-name')).toContainText('Pidgey');
    await expect(page.locator('#msg-bar')).toHaveText('Found 6 cards: 3 identified, 3 need your pick.');
    await expect(page.locator('.lt-guess b')).toHaveText('3');
    await expect(page.locator('.choose-toggle')).toHaveText('To confirm (3)');
    await page.close();
  });

  // ─── Tapping the image of a suggestion confirms it, like the ? button ───

  const guessedScan = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const sets = [
      { id: 'sv01-5', name: 'Eevee', set: 'Scarlet & Violet', setCode: 'sv01', number: '005', imageUrl: arts[0] },
      { id: 'sv02-5', name: 'Eevee', set: 'Paldea Evolved', setCode: 'sv02', number: '005', imageUrl: arts[1] },
    ];
    return { cards: [{
      identity: sets[1], setChoices: sets, setConfirmed: false, setRange: { low: 2, high: 9, count: 2, total: 2 },
      bestGuess: { source: 'page', reason: 'likely Paldea Evolved' }, confidence: 0.7, abstain: false, market_price: 3, box: [0, 0, 1, 1],
      price_grid: grid(3),
    }], priced: { 'sv01-5': { identity: sets[0], market_price: 2, price_variant: 'normal', price_grid: grid(2) } } };
  };

  test('tapping the suggested printing tile confirms it exactly like the ? button', async () => {
    const page = await popupWithChoose(guessedScan);
    await expect(page.locator('.card-row .card-price')).toHaveText('$2.00–$9.00');
    const tile = page.getByRole('radio', { name: 'Suggested: Paldea Evolved number 005' });
    await expect(tile).toHaveAttribute('aria-checked', 'true');
    await tile.click();
    await expect(page.locator('.card-row .guess-mark')).toHaveCount(0);
    await expect(page.locator('.card-row .card-price')).toHaveText('$3.00');
    await expect(page.locator('.strip-suggested')).toHaveCount(0);
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'saveCorrection', scanId: 'c', index: 0, pickedId: 'sv02-5', via: 'guess-confirmed' });
    expect(await page.evaluate(() => window.__priceCalls)).toEqual([]);
    // Already confirmed: another tap does nothing and sends nothing.
    await page.getByRole('radio', { name: 'Paldea Evolved number 005' }).click();
    expect(await page.evaluate(() => window.__sent.length)).toBe(1);
    await expect(page.locator('.card-row .card-price')).toHaveText('$3.00');
    await page.close();
  });

  test('tapping a different printing tile than the suggested one picks that one', async () => {
    const page = await popupWithChoose(guessedScan);
    await page.getByRole('radio', { name: 'Scarlet & Violet number 005' }).click();
    await expect(page.locator('.card-row .card-price')).toHaveText('$2.00');
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pickedId: 'sv01-5', via: 'set-menu' });
    await page.close();
  });

  test('tapping the suggested finish chip confirms it like the ? button; a confirmed chip does nothing', async () => {
    const page = await popupWithChoose(() => ({
      cards: [{
        identity: { id: 'x-1', name: 'Eevee', set: 'Jungle', setCode: 'base2', number: '51' }, confidence: 0.9, abstain: false, box: [0, 0, 1, 1],
        variant: { edition: 'standard', finish: 'reverse', stamp: 'none' },
        price_grid: { source: 'pokemontcg', variants: {
          normal: { market: 2, conditions: { NM: 2 } }, holofoil: { market: 10, conditions: { NM: 10 } }, reverseHolofoil: { market: 4, conditions: { NM: 4 } },
        } },
      }],
      priced: {},
    }));
    const chip = page.locator('.chip-suggested');
    await expect(chip).toHaveAttribute('data-strip-pick', 'reverseHolofoil');
    await chip.click();
    await expect(page.locator('button[data-variant-confirm]')).toHaveCount(0);
    await expect(page.locator('.card-row .card-price')).toHaveText('$4.00');
    await expect(page.locator('.chip[aria-checked="true"]')).toHaveAttribute('data-strip-pick', 'reverseHolofoil');
    await page.locator('.chip[aria-checked="true"]').click();
    await expect(page.locator('.card-row .card-price')).toHaveText('$4.00');
    expect(await page.evaluate(() => window.__sent.length)).toBe(0);
    await page.close();
  });

  // ─── Round 3: catalog art for every choice, a version tap stays confirmed, focus stays in the strip ───

  // A card-shaped picture (name and number drawn on it) served for the catalog host, so screenshots show real art.
  async function artPng(label, color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352"><rect width="252" height="352" rx="14" fill="${color}"/><rect x="16" y="16" width="220" height="40" rx="6" fill="#fff" fill-opacity="0.85"/><text x="26" y="44" font-size="22" font-family="Arial" font-weight="700" fill="#222">${label}</text><rect x="16" y="70" width="220" height="150" rx="8" fill="#fff" fill-opacity="0.35"/></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  test('a printing strip for Scarlet & Violet sets loads each choice own catalog art and never asks pokemontcg.io', async () => {
    const hosts = [];
    const onRequest = (request) => hosts.push(request.url());
    context.on('request', onRequest);
    const pokemontcg = async (route) => route.fulfill({ status: 404, contentType: 'image/png', body: await artPng('CARD BACK', '#223') });
    await context.route('https://images.pokemontcg.io/**', pokemontcg);
    const bodies = { 'sv01-5': await artPng('Eevee 005', '#c0504d'), 'sv03-166': await artPng('Eevee 166', '#4f81bd'), 'sv04-9': await artPng('Eevee 009', '#9bbb59') };
    const tcgdex = async (route) => {
      const url = route.request().url();
      const key = Object.keys(bodies).find((k) => url.includes(`/${k.split('-')[0]}/`)) || 'sv01-5';
      await route.fulfill({ status: 200, contentType: 'image/png', body: bodies[key] });
    };
    await context.route('https://assets.tcgdex.net/**', tcgdex);
    try {
      const page = await popupWithChoose(() => {
        const row = (id, set, setCode, number, imageUrl) => ({ id, name: 'Eevee', set, setCode, number, ...(imageUrl ? { imageUrl } : {}) });
        const sets = [
          row('sv01-5', 'Scarlet & Violet', 'sv01', '005', 'https://assets.tcgdex.net/en/sv/sv01/005/high.webp'),
          row('sv03-166', 'Obsidian Flames', 'sv03', '166', 'https://assets.tcgdex.net/en/sv/sv03/166/high.webp'),
          row('sv04-9', 'Paradox Rift', 'sv04', '009'),
        ];
        return { cards: [{ identity: sets[1], setChoices: sets, setConfirmed: false, bestGuess: { source: 'page', reason: 'likely Obsidian Flames' }, setRange: { low: 1, high: 6, count: 3, total: 3 }, confidence: 0.7, abstain: false, market_price: 3, box: [0, 0, 1, 1] }], priced: {} };
      });
      const tiles = page.getByRole('radiogroup', { name: 'Choose the printing' }).getByRole('radio');
      await expect(tiles).toHaveCount(3);
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.strip-art img')].every((i) => i.complete && i.naturalWidth > 100))).toBe(true);
      await expect(page.locator('.strip-art.no-art')).toHaveCount(0);
      expect(hosts.filter((u) => u.includes('images.pokemontcg.io'))).toEqual([]);
      expect(hosts.some((u) => u === 'https://assets.tcgdex.net/en/sv/sv03/166/high.webp')).toBe(true);
      // The row with no imageUrl asks the catalog host for its own picture, not pokemontcg.io.
      expect(hosts.some((u) => u === 'https://assets.tcgdex.net/en/sv/sv04/009/high.webp')).toBe(true);
      fs.mkdirSync(PICKER_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(PICKER_SHOTS, 'printing-strip-sv-art.png') });
      await page.close();
    } finally {
      context.off('request', onRequest);
      await context.unroute('https://images.pokemontcg.io/**', pokemontcg);
      await context.unroute('https://assets.tcgdex.net/**', tcgdex);
    }
  });

  test('a picture that decodes to a speck is a failure: the tile becomes a text tile', async () => {
    const page = await popupWithChoose(() => {
      const speck = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const sets = [
        { id: 'a-1', name: 'Eevee', set: 'Jungle', setCode: 'base2', number: '51', imageUrl: speck },
        { id: 'b-1', name: 'Eevee', set: 'Fossil', setCode: 'base3', number: '51', imageUrl: speck },
      ];
      return { cards: [{ identity: sets[0], setChoices: sets, setConfirmed: false, setRange: { low: 1, high: 7, count: 2, total: 2 }, confidence: 0.9, abstain: false, box: [0, 0, 1, 1] }], priced: {} };
    });
    await expect(page.locator('.strip-art.no-art')).toHaveCount(2);
    await expect(page.getByRole('radio', { name: 'Jungle number 51' }).locator('.strip-fallback')).toBeVisible();
    await page.close();
  });

  const confirmedThenVersion = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const pidgey = { id: 'a-1', name: 'Pidgey', set: 'Jungle', setCode: 'base2', number: '57', imageUrl: arts[0] };
    const pidgeotto = { id: 'a-2', name: 'Pidgeotto', set: 'Jungle', setCode: 'base2', number: '22', imageUrl: arts[1], market_price: 6, price_variant: 'normal', price_grid: grid(6), setChoices: [] };
    return {
      cards: [{ identity: null, confidence: 0.3, abstain: true, unsure: true, candidates: [pidgey], versionChoices: [pidgeotto], crop, box: [0, 0, 1, 1] }],
      priced: { 'a-1': { identity: pidgey, market_price: 3, price_variant: 'normal', price_grid: grid(3) } },
    };
  };

  test('after confirming from Choose, tapping another version keeps the row confirmed with the new name and price', async () => {
    const page = await popupWithChoose(confirmedThenVersion);
    await page.locator('.choose-row [data-confirm-best]').click();
    await expect(page.locator('.card-row[data-idx="0"] .card-price')).toHaveText('$3.00');
    await expect(page.locator('.choose-row')).toHaveCount(0);
    await page.getByRole('radiogroup', { name: 'Choose the version' }).getByRole('radio', { name: /Pidgeotto/ }).click();
    await expect(page.locator('.card-row[data-idx="0"] .card-name')).toContainText('Pidgeotto');
    await expect(page.locator('.card-row[data-idx="0"] .card-price')).toHaveText('$6.00');
    await expect(page.locator('.choose-row')).toHaveCount(0);
    await expect(page.locator('#msg-bar')).not.toContainText('need your pick');
    await expect(page.locator('.lt-guess b')).toHaveText('0');
    await expect(page.locator('#msg-bar')).not.toContainText('Price updated for Pidgey');
    await page.screenshot({ path: path.join(PICKER_SHOTS, 'version-swap.png') });
    await page.close();
  });

  test('finishing the model download clears the progress text', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() => {
      const listeners = [];
      const onMessage = chrome.runtime.onMessage;
      const add = onMessage.addListener.bind(onMessage);
      onMessage.addListener = (fn) => { listeners.push(fn); add(fn); };
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (msg) => {
        if (msg?.action !== 'startSetup') return real(msg);
        for (const fn of listeners) fn({ action: 'setupProgress', file: 'meta.json', fileIndex: 4, fileDone: true, totalFiles: 5, bytesLoaded: 1, bytesTotal: 1 });
        if (!document.getElementById('setup-status').textContent.includes('Downloading 5 of 5')) throw new Error('progress text never shown');
        return { ok: true };
      };
      document.getElementById('btn-setup').click();
    });
    await expect.poll(() => page.evaluate(() => document.getElementById('setup-status').textContent)).toBe('');
    await page.close();
  });

  test('focus stays in the strip: on the chosen finish chip, the newly checked printing tile, and the new version tile', async () => {
    const page = await popupWithChoose(finishScan);
    const chips = page.getByRole('radiogroup', { name: /^Choose the finish/ }).getByRole('radio');
    await chips.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.locator('.card-row .card-price')).toHaveText('$10.00');
    expect(await page.evaluate(() => document.activeElement?.dataset.stripPick)).toBe('holofoil');
    expect(await page.evaluate(() => document.activeElement?.dataset.stripKind)).toBe('finish');
    await page.close();

    const sets = await popupWithChoose(printingScan);
    const tiles = sets.getByRole('radiogroup', { name: 'Choose the printing' }).getByRole('radio');
    await tiles.first().focus();
    await sets.keyboard.press('ArrowRight');
    await sets.keyboard.press('ArrowRight');
    await sets.keyboard.press('Enter');
    await expect(sets.locator('.card-row .card-price')).toHaveText('$9.00');
    await expect.poll(() => sets.evaluate(() => { const a = document.activeElement; return [a?.dataset.stripKind, a?.dataset.stripPick, a?.getAttribute('aria-checked')]; })).toEqual(['set', 'pre-74', 'true']);
    await sets.close();

    const versions = await popupWithChoose(versionScan);
    const vt = versions.getByRole('radiogroup', { name: 'Choose the version' }).getByRole('radio');
    await vt.first().focus();
    await versions.keyboard.press('ArrowRight');
    await versions.keyboard.press('Enter');
    await expect(versions.locator('.card-row .card-name')).toContainText('Pikachu V');
    await expect.poll(() => versions.evaluate(() => { const a = document.activeElement; return [a?.dataset.stripKind, a?.getAttribute('aria-checked'), a?.textContent]; })).toEqual(['version', 'true', expect.stringContaining('Pikachu V')]);
    await versions.close();
  });
  // ─── Corrections that stick: the why-record, the chips, and what memory confirms ───

  const MEM_SHOTS = path.resolve(__dirname, '../../.tmp/g12');
  // 0: confirmed by the user's earlier correction, $5     1: same, $80, below the high bar (back to Choose)
  // 2: same, $80, at the high bar (stays confirmed)       3: picture-confirmed with a why-record (the one to correct)
  // 4: a card to choose that negative memory knows
  const memoryScan = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const row = (id, name, set, setCode, number, art) => ({ id, name, set, setCode, number, imageUrl: art });
    const oddish = row('m-1', 'Oddish', 'Jungle', 'base2', '58', arts[0]);
    const venus = row('m-2', 'Venusaur', 'Base Set', 'base1', '15', arts[1]);
    const blast = row('m-3', 'Blastoise', 'Base Set', 'base1', '2', arts[2]);
    const other = row('m-4', 'Pidgey', 'Jungle', 'base2', '57', arts[3]);
    const found = row('f-1', 'Raichu', 'Base Set', 'base1', '14', arts[4]);
    const correctionWhy = (cos) => ({ w: 1, src: 'correction', cos, lead: 0.1, h: 240, others: ['Pidgey', 'Rattata'], ref: { id: 's0:1', cos, n: 1, ts: Date.UTC(2026, 9, 20), bar: 0.86 } });
    const memory = (cardId, cos, n = 1) => ({ level: 'confirm', cardId, cos, refId: 's0:1', n, ts: Date.UTC(2026, 9, 20) });
    const cards = [
      { identity: oddish, confidence: 0.79, abstain: false, market_price: 5, price_grid: grid(5), confirmedBy: 'correction', memory: memory('m-1', 0.9), referencedId: 'm-1', why: correctionWhy(0.9), box: [0, 0, 1, 1] },
      { identity: venus, confidence: 0.79, abstain: false, market_price: 80, price_grid: grid(80), confirmedBy: 'correction', memory: memory('m-2', 0.85), referencedId: 'm-2', why: correctionWhy(0.85), candidates: [other, venus], crop, box: [0, 0, 1, 1] },
      { identity: blast, confidence: 0.79, abstain: false, market_price: 80, price_grid: grid(80), confirmedBy: 'correction', memory: memory('m-3', 0.87), referencedId: 'm-3', why: correctionWhy(0.87), candidates: [other, blast], crop, box: [0, 0, 1, 1] },
      { identity: { id: 'x-1', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' }, confidence: 0.7, abstain: false, market_price: 5, price_grid: grid(5), why: { w: 1, src: 'picture', cos: 0.812, lead: 0.05, h: 212, title: 'agree', others: ['Pidgey', 'Rattata'] }, box: [0, 0, 1, 1] },
      { identity: null, confidence: 0.3, abstain: true, unsure: true, memory: { level: 'negative', cardId: 'm-1', cos: 0.85, refId: 's0:1', n: 1, wrongId: 'x-9' }, referencedId: 'm-1', candidates: [oddish, other], crop, box: [0, 0, 1, 1] },
    ];
    const priced = {
      'm-1': { identity: oddish, market_price: 5, price_variant: 'normal', price_grid: grid(5) },
      'm-2': { identity: venus, market_price: 80, price_variant: 'normal', price_grid: grid(80) },
      'f-1': { identity: found, market_price: 7, price_variant: 'normal', price_grid: grid(7) },
    };
    return { cards, priced, found: [found] };
  };

  test('a row confirmed by an earlier correction says so, and "Why this card?" explains it in plain words', async () => {
    const page = await popupWithChoose(memoryScan);
    const row = page.locator('.card-row[data-idx="0"]');
    await expect(row.locator('.card-name')).toContainText('Oddish');
    await expect(row.locator('.memory-chip')).toHaveText('From your correction');
    await expect(row.locator('.why-pop')).toHaveCount(0);
    await row.locator('.why-btn').click();
    await expect(row.locator('.why-btn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#why-0')).toContainText('From your earlier correction on 2026-10-20: you said it was Oddish');
    await expect(page.locator('#why-0')).toContainText('0.90 similarity (needed 0.86)');
    await expect(page.locator('#why-0')).toContainText('Closest others: Pidgey, Rattata');
    await expect(row.locator('[data-open-search]')).toHaveText('Wrong card?');
    fs.mkdirSync(MEM_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(MEM_SHOTS, 'why-popover.png') });
    await row.locator('.why-btn').click();
    await expect(page.locator('#why-0')).toHaveCount(0);
    await page.close();
  });

  test('a picture-confirmed row explains the match by picture', async () => {
    const page = await popupWithChoose(memoryScan);
    await page.locator('.card-row[data-idx="3"] .why-btn').click();
    await expect(page.locator('#why-3')).toContainText('Matched by picture: 0.81 similarity, clearly ahead of the next card, 212 px tall.');
    await expect(page.locator('#why-3')).toContainText('The title line agrees.');
    await page.close();
  });

  test('a correction-confirmed card worth $50 or more needs the high bar: below it back to Choose with the card preselected, at it kept', async () => {
    const page = await popupWithChoose(memoryScan);
    const choose = page.locator('.choose-row[data-idx="1"]');
    await expect(choose).toHaveCount(1);
    await expect(choose.locator('.value-chip')).toHaveText('Check: high value');
    await expect(choose.locator('.memory-chip')).toHaveText('You corrected this before');
    await expect(choose.locator('.pick-choice').first()).toContainText('Venusaur');
    await expect(choose.locator('[data-confirm-best]')).toHaveText('Confirm Venusaur');
    const kept = page.locator('.card-row[data-idx="2"]');
    await expect(kept.locator('.card-price')).toHaveText('$80.00');
    await expect(kept.locator('.memory-chip')).toHaveText('From your correction');
    await expect(page.locator('.choose-row[data-idx="2"]')).toHaveCount(0);
    await page.close();
  });

  test('negative memory: a card to choose that memory knows shows the corrected card first with the chip', async () => {
    const page = await popupWithChoose(memoryScan);
    const choose = page.locator('.choose-row[data-idx="4"]');
    await expect(choose.locator('.memory-chip')).toHaveText('You corrected this before');
    await expect(choose.locator('.pick-choice').first()).toContainText('Oddish');
    await expect(choose.locator('.pick-best')).toHaveCount(1);
    fs.mkdirSync(MEM_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(MEM_SHOTS, 'choose-corrected-before.png') });
    await page.close();
  });

  async function correctWrongCard(saveResp) {
    const page = await popupWithChoose(memoryScan, saveResp);
    const row = page.locator('.card-row[data-idx="3"]');
    await row.locator('[data-open-search]').click();
    await row.locator('.picker-input').fill('rai');
    await row.locator('.picker-results [data-pick="f-1"]').click();
    return page;
  }

  test('"Wrong card?" saves the correction with the why-record of the wrong confirmation, and the row says Corrected, remembered', async () => {
    const page = await correctWrongCard({ ok: true, count: 1, remembered: true });
    const row = page.locator('.card-row[data-idx="3"]');
    await expect(row.locator('.card-name')).toContainText('Raichu');
    await expect(row.locator('.memory-chip')).toHaveText('Corrected, remembered');
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'saveCorrection', index: 3, pickedId: 'f-1', via: 'wrong-card' });
    expect(sent[0].guess.id).toBe('x-1');
    expect(sent[0].guess.why).toMatchObject({ src: 'picture', cos: 0.812, h: 212, title: 'agree', price: 5 });
    await row.locator('.why-btn').click();
    await expect(page.locator('#why-3')).toContainText('You chose this. The picture alone said Raichu at 0.81.');
    fs.mkdirSync(MEM_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(MEM_SHOTS, 'corrected-row.png') });
    await page.close();
  });

  test('a card corrected the same way twice says Corrected, remembered (x2)', async () => {
    const page = await correctWrongCard({ ok: true, count: 2, remembered: true });
    await expect(page.locator('.card-row[data-idx="3"] .memory-chip')).toHaveText('Corrected, remembered (x2)');
    await page.close();
  });

  test('with "Use my corrections" off the row says only Corrected', async () => {
    const page = await correctWrongCard({ ok: true, count: 1, remembered: false });
    await expect(page.locator('.card-row[data-idx="3"] .memory-chip')).toHaveText('Corrected');
    await page.close();
  });

  // ─── "Can't price this": the user's way out for a card the catalog cannot name ───

  const SKIP_SHOTS = path.resolve(__dirname, '../../.tmp/skip');
  const skipNameRe = /^Skip this card: I can't price it \(not English, not a card\)$/;

  test('every Choose row has a Can\'t price this button with its own accessible name, reachable by keyboard', async () => {
    const page = await popupWithChoose(chooseScan);
    const buttons = page.locator('.choose-row [data-skip-card]');
    await expect(buttons).toHaveCount(4);
    await expect(buttons.first()).toHaveText("Can't price this");
    await expect(buttons.first()).toHaveAccessibleName(skipNameRe);
    await page.locator('.choose-row').first().locator('[data-open-search]').focus();
    await page.keyboard.press('Tab');
    await expect(buttons.first()).toBeFocused();
    fs.mkdirSync(SKIP_SHOTS, { recursive: true });
    await page.locator('.choose-row').first().screenshot({ path: path.join(SKIP_SHOTS, 'choose-row-with-skip.png') });
    await page.close();
  });

  test('skipping a Choose row: it moves to a collapsed Skipped (1) group, counts change, the tag is Skipped, focus and the live message follow', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row[data-idx="1"] [data-skip-card]').click();
    await expect(page.locator('.choose-toggle')).toHaveText('To confirm (3)');
    await expect(page.locator('.choose-review')).toHaveText('Review all 3');
    await expect(page.locator('.choose-row[data-idx="1"]')).toHaveCount(0);
    const toggle = page.locator('.skipped-toggle');
    await expect(toggle).toHaveText('Skipped (1)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#skipped-list')).toBeHidden();
    // The group is the last thing in the list.
    expect(await page.evaluate(() => document.getElementById('results').lastElementChild.classList.contains('skipped-group'))).toBe(true);
    // Lot: To confirm drops to 3, Confirmed value is unchanged, Skipped 1 appears.
    await expect(page.locator('#lot-totals .lt-guess b')).toHaveText('3');
    await expect(page.locator('#lot-totals .lt-skipped')).toHaveText('Skipped 1');
    await expect(page.locator('#s-value')).toHaveText('$12.50');
    // The scanner is told, with the scan and the card; the page overlay says skipped and names nothing.
    const sent = await page.evaluate(() => window.__sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'saveSkip', scanId: 'c', index: 1 });
    const overlay = await page.evaluate(() => window.__overlay.at(-1).cards.map((c) => [c.display?.state, c.display?.name ?? null, c.display?.price ?? null]));
    expect(overlay[1]).toEqual(['skipped', null, null]);
    // Focus lands on the next Choose row's Confirm button, as after a confirm, and the message is announced.
    await expect(page.locator('.choose-row[data-idx="3"] [data-confirm-best]')).toBeFocused();
    await expect(page.locator('#msg-bar')).toHaveText('Skipped. 3 to confirm.');
    await expect(page.locator('#msg-bar')).toHaveAttribute('role', 'status');
    // Open the group: the crop and Put back, never a name or a price.
    await toggle.click();
    const row = page.locator('.skipped-row[data-idx="1"]');
    await expect(row).toBeVisible();
    await expect(row.locator('img.unrec-thumb')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    await expect(row.locator('.card-price, .card-name')).toHaveCount(0);
    await expect(row.locator('[data-put-back]')).toHaveText('Put back');
    await expect(row.locator('[data-put-back]')).toHaveAccessibleName('Put back card 2: return it to the cards to confirm');
    await page.screenshot({ path: path.join(SKIP_SHOTS, 'skipped-group.png') });
    await page.close();
  });

  test('Put back returns the card to Choose with its candidates, focus on its Confirm button', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row[data-idx="1"] [data-skip-card]').click();
    await page.locator('.skipped-toggle').click();
    await page.locator('.skipped-row[data-idx="1"] [data-put-back]').click();
    await expect(page.locator('.skipped-group')).toHaveCount(0);
    await expect(page.locator('.choose-toggle')).toHaveText('To confirm (4)');
    const row = page.locator('.choose-row[data-idx="1"]');
    await expect(row.locator('.pick-choice')).toHaveCount(3);
    await expect(row.locator('[data-confirm-best]')).toHaveText('Confirm Rattata');
    await expect(row.locator('[data-confirm-best]')).toBeFocused();
    await expect(page.locator('#lot-totals .lt-skipped')).toHaveCount(0);
    await expect(page.locator('#msg-bar')).toHaveText('Put back. 4 to confirm.');
    const sent = await page.evaluate(() => window.__sent.map((m) => [m.action, m.index]));
    expect(sent).toEqual([['saveSkip', 1], ['unskip', 1]]);
    await page.close();
  });

  test('skip and Put back work from the keyboard alone', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row[data-idx="1"] [data-skip-card]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.choose-row[data-idx="3"] [data-confirm-best]')).toBeFocused();
    await page.locator('.skipped-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.skipped-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(page.locator('.skipped-row [data-put-back]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.choose-row[data-idx="1"] [data-confirm-best]')).toBeFocused();
    await page.close();
  });

  test('skipping the last card to confirm moves focus to Copy and says nothing is left', async () => {
    const page = await popupWithChoose(chooseScan);
    for (const idx of [1, 3, 4, 5]) {
      await page.locator(`.choose-row[data-idx="${idx}"] [data-skip-card]`).focus();
      await page.keyboard.press('Enter');
    }
    await expect(page.locator('.skipped-toggle')).toHaveText('Skipped (4)');
    await expect(page.locator('.choose-group')).toHaveCount(0);
    await expect(page.locator('#lot-totals [data-lot-copy]')).toBeFocused();
    await expect(page.locator('#msg-bar')).toHaveText('Skipped. Nothing left to confirm.');
    await page.close();
  });

  test('the export leaves skipped cards out and its tooltip says how many', async () => {
    const page = await popupWithChoose(chooseScan);
    const copy = page.locator('#lot-totals [data-lot-copy]');
    await expect(copy).toHaveAttribute('title', '4 more cards still need confirming and are not included');
    await page.locator('.choose-row[data-idx="1"] [data-skip-card]').click();
    await expect(copy).toHaveText('Copy 2 confirmed');
    await expect(copy).toHaveAttribute('title', '3 more cards still need confirming and are not included. 1 skipped card is not included');
    await expect(page.locator('#lot-totals [data-lot-csv]')).toHaveAttribute('title', /1 skipped card is not included/);
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } });
    });
    await copy.evaluate((b) => b.click());
    await expect(page.locator('#msg-bar')).toHaveText('Copied 2 cards');
    const lines = (await page.evaluate(() => window.__copied)).split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    await page.close();
  });

  test('Review all ignores skipped cards', async () => {
    const page = await popupWithChoose(chooseScan);
    await page.locator('.choose-row[data-idx="3"] [data-skip-card]').click();
    await page.locator('.choose-review').click();
    await expect(page.locator('.bulk-pair')).toHaveCount(3);
    await page.close();
  });

  test('a card that is not in a skipped state keeps no Skipped count in the lot strip', async () => {
    const page = await popupWithChoose(chooseScan);
    await expect(page.locator('#lot-totals .lt-skipped')).toHaveCount(0);
    await expect(page.locator('.skipped-group')).toHaveCount(0);
    await page.close();
  });

  // A confident read of a crop like a skipped one: the scanner (background) hands it over as Choose, flagged skippedBefore.
  const rescanScan = (crop, arts) => {
    const grid = (nm) => ({ source: 'pokemontcg', variants: { normal: { market: nm, conditions: { NM: nm } } } });
    const row = (id, name, set, setCode, number, art) => ({ id, name, set, setCode, number, imageUrl: art });
    const a1 = row('a-1', 'Pidgey', 'Jungle', 'base2', '57', arts[0]);
    const b2 = row('b-2', 'Rattata', 'Base Set', 'base1', '61', arts[1]);
    const first = { identity: null, confidence: 0.3, abstain: true, candidates: [a1, b2], crop, box: [0, 0, 1, 1] };
    const again = { identity: a1, confidence: 0.4, abstain: false, choose: true, skippedBefore: true, candidates: [a1, b2], smallRow: true, crop, box: [0, 0, 1, 1], market_price: 3, price_grid: grid(3) };
    return { cards: [first], rescan: [again], priced: { 'a-1': { identity: a1, market_price: 3, price_variant: 'normal', price_grid: grid(3) } } };
  };

  test('a rescan of a skipped crop stays Choose with the You skipped this before chip and a highlighted skip button; nothing is auto-skipped or auto-confirmed', async () => {
    const page = await popupWithChoose(rescanScan);
    await page.locator('.choose-row[data-idx="0"] [data-skip-card]').click();
    await expect(page.locator('.skipped-toggle')).toHaveText('Skipped (1)');
    await page.evaluate(() => { const b = document.getElementById('btn-scan'); b.disabled = false; b.click(); });
    const row = page.locator('.choose-row[data-idx="0"]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.memory-chip')).toHaveText('You skipped this before');
    await expect(row.locator('[data-skip-card]')).toHaveClass(/skip-btn-hot/);
    await expect(row.locator('[data-skip-card]')).toBeVisible();
    await expect(page.locator('.skipped-group')).toHaveCount(0);
    await expect(page.locator('.choose-toggle')).toHaveText('To confirm (1)');
    // Not named, not priced, even though it is a cheap small-photo card that would otherwise be promoted.
    await expect(row.locator('.card-price')).toHaveText('—');
    await expect(page.locator('#s-value')).toHaveText('—');
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__priceCalls)).toEqual([]);
    await expect(row.locator('[data-confirm-best]')).toHaveText('Confirm Pidgey');
    const overlay = await page.evaluate(() => window.__overlay.at(-1).cards.map((c) => c.display?.state));
    expect(overlay).toEqual(['choose']);
    await page.screenshot({ path: path.join(SKIP_SHOTS, 'skipped-before-chip.png') });
    // The user's own confirm still works and prices it.
    await row.locator('[data-confirm-best]').click();
    await expect(page.locator('.card-row[data-idx="0"] .card-price')).toHaveText('$3.00');
    await page.close();
  });

  test('the settings page has "Use my corrections" on by default and remembers a switch-off', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const toggle = page.locator('#use-references');
    await expect(toggle).toBeChecked();
    await expect(page.locator('label[for="use-references"]')).toContainText('Use my corrections');
    await toggle.uncheck();
    expect(await page.evaluate(async () => (await chrome.storage.local.get('useReferences')).useReferences)).toBe(false);
    await page.reload();
    await expect(page.locator('#use-references')).not.toBeChecked();
    await page.evaluate(() => chrome.storage.local.remove('useReferences'));
    await page.close();
  });
});
