import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_SCRIPT = path.resolve(__dirname, '../../tools/extension-wasm/content.js');

test.describe('screen card candidate detection', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(() => {
      globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
    });
  });

  test('includes card-shaped CSS background images in normal scan results', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.locator('body').evaluate((body) => {
      body.innerHTML = '<div id="card" style="position:absolute;left:100px;top:100px;width:200px;height:280px"></div>';
      body.querySelector('#card').style.backgroundImage = 'url("data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=")';
    });
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    const result = await page.evaluate(() => window.__cardScanner.find());

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].rect.x).toBe(100);
    expect(result.cards[0].rect.y).toBe(100);
  });

  test('keeps single-card listings and rejects sealed-product thumbnails by accessible context', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.locator('body').evaluate((body) => {
      const image = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22280%22/%3E';
      body.innerHTML = `
        <a href="/product/single" style="position:absolute;left:100px;top:100px">
          <img alt="Charizard" width="200" height="280" src="${image}">
          <span>Base Set Charizard</span>
        </a>
        <a href="/product/collection" style="position:absolute;left:400px;top:100px">
          <img alt="Celebrations Ultra-Premium Collection" width="200" height="280" src="${image}">
          <span>Celebrations Ultra-Premium Collection</span>
        </a>
        <a href="/product/legendary-collection" style="position:absolute;left:700px;top:100px">
          <img alt="Legendary Collection Charizard" width="200" height="280" src="${image}">
          <span>Legendary Collection Charizard</span>
        </a>
        <a href="/product/tcg-classic" style="position:absolute;left:100px;top:450px">
          <div style="width:200px;height:280px;background-image:url('${image}')"></div>
          <span>Pokemon Trading Card Game Classic</span>
        </a>`;
    });
    await page.locator('img').evaluateAll((images) => Promise.all(images.map((img) => img.decode())));
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    const result = await page.evaluate(() => window.__cardScanner.find({ diag: true }));

    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].rect.x).toBe(100);
    expect(result.cards[1].rect.x).toBe(700);
    expect(result.rejected.some((candidate) => candidate.reason === 'sealed-product')).toBe(true);
    expect(result.bgCandidates).toHaveLength(0);
  });

  test('rejects card images mostly clipped outside the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.locator('body').evaluate((body) => {
      body.innerHTML = '<img id="partial" style="position:absolute;left:-150px;top:100px;width:200px;height:280px" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22280%22/%3E">';
    });
    await page.locator('#partial').evaluate((img) => img.decode());
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    const result = await page.evaluate(() => window.__cardScanner.find());

    expect(result.cards).toHaveLength(0);
    expect(result.photos).toHaveLength(0);
  });

  test('rejects CSS background card candidates mostly clipped outside the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.locator('body').evaluate((body) => {
      body.innerHTML = '<div id="partial" style="position:absolute;left:-150px;top:100px;width:200px;height:280px"></div>';
      body.querySelector('#partial').style.backgroundImage = 'url("data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=")';
    });
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    const result = await page.evaluate(() => window.__cardScanner.find());

    expect(result.cards).toHaveLength(0);
    expect(result.photos).toHaveLength(0);
  });
});
