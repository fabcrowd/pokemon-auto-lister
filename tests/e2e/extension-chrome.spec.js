/**
 * Chrome extension smoke test — launches Chromium with the extension loaded,
 * opens the real chrome-extension:// popup URL, and verifies the UI.
 *
 * Run: npx playwright test extension-chrome --project=extension
 */

import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = path.resolve(__dirname, '../../dist/extension');

test.describe('Chrome extension (loaded in real browser)', () => {
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

    // Discover extension ID from the service worker URL
    let sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', {
        predicate: w => w.url().startsWith('chrome-extension://'),
        timeout: 10_000,
      });
    }
    extensionId = new URL(sw.url()).hostname;
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('popup opens and shows Card Scanner header', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Header logo text
    const logo = page.locator('.logo');
    await expect(logo).toContainText('Card Scanner');

    // Server pill is present (connecting…, server ok, or offline)
    const pill = page.locator('#server-pill');
    await expect(pill).toBeVisible();

    await page.screenshot({
      path: path.join(__dirname, 'screenshots', 'ext-chrome-popup.png'),
    });
    await page.close();
  });

  test('camera placeholder is shown on open', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Camera placeholder should be visible (no real webcam in test)
    const placeholder = page.locator('#cam-placeholder');
    await expect(placeholder).toBeVisible({ timeout: 5_000 });

    await page.close();
  });

  test('scan button toggles scanning state', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    const btn   = page.locator('#btn-scan');
    const label = page.locator('#btn-label');

    await expect(label).toHaveText('SCAN');

    await btn.click();
    await expect(page.locator('body')).toHaveClass(/scanning/);
    await expect(label).toHaveText('STOP');

    await btn.click();
    await expect(page.locator('body')).not.toHaveClass(/scanning/);
    await expect(label).toHaveText('SCAN');

    await page.close();
  });

  test('server pill reflects health endpoint', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Wait for popup.js to initialise, then trigger health check manually
    await page.waitForFunction(() => typeof window.checkHealth === 'function', { timeout: 5_000 });
    await page.evaluate(() => window.checkHealth());

    // Wait for pill to settle (ok or err)
    await page.waitForFunction(
      () => {
        const pill = document.getElementById('server-pill');
        return pill && (pill.classList.contains('ok') || pill.classList.contains('err'));
      },
      { timeout: 8_000 },
    );

    const cls = await page.locator('#server-pill').getAttribute('class');
    expect(cls).toMatch(/ok|err/);

    await page.screenshot({
      path: path.join(__dirname, 'screenshots', 'ext-chrome-server-pill.png'),
    });
    await page.close();
  });

  test('results panel injects Charizard card and renders correctly', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Wait for popup.js functions to be available
    await page.waitForFunction(() => typeof window.updateResults === 'function', { timeout: 5_000 });

    const charizard = [{
      box: [10, 10, 599, 826],
      identity: { name: 'Charizard', set: 'Base Set (Unlimited)', setCode: 'BS', number: '4/102', game: 'pokemon' },
      confidence: 0.92,
      market_price: 647,
      price_variant: 'mercari',
      abstain: false,
    }];

    await page.evaluate((cards) => {
      window.updateResults(cards);
      window.updateStats(cards, 310);
    }, charizard);

    await expect(page.locator('.card-name').first()).toContainText('Charizard');
    await expect(page.locator('.price-main').first()).toContainText('$647.00');
    await expect(page.locator('#s-detected')).toHaveText('1');

    await page.screenshot({
      path: path.join(__dirname, 'screenshots', 'ext-chrome-charizard.png'),
    });
    await page.close();
  });
});
