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
