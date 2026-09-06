import { parseFirstMoney } from './deal.js';

export const SEARCH_SELECTORS = {
  tile: '[data-testid="ProductThumbWrapper"]',
  priceLoggedIn: '[data-testid="ProductThumbItemPrice"]',
  priceLoggedOut: '[data-testid="ItemPrice"]',
  sold: '[data-testid="ProductThumbItemSold"], [data-testid="ItemSold"]',
};

/**
 * Build Mercari search URL (newest-first when sort supported).
 *
 * @param {string} query
 * @returns {string}
 */
export function buildSearchUrl(query) {
  const params = new URLSearchParams({
    keyword: query,
    sortBy: '2', // newest
  });
  return `https://www.mercari.com/search/?${params.toString()}`;
}

/**
 * First listing photo — no page visit required.
 *
 * @param {string} itemId
 * @returns {string}
 */
export function mercariFirstPhotoUrl(itemId) {
  return `https://u-mercari-images.mercdn.net/photos/${itemId}_1.jpg`;
}

/**
 * Extract Mercari item id from a product href.
 *
 * @param {string|null|undefined} href
 * @returns {string|null}
 */
export function extractItemId(href) {
  if (typeof href !== 'string' || href.length === 0) {
    return null;
  }
  const match = href.match(/\/item\/(m\d+)/i) || href.match(/\/(m\d+)\//i) || href.match(/\b(m\d+)\b/i);
  return match ? match[1] : null;
}

/**
 * Pure parse of tile payloads collected from the page (for unit tests).
 *
 * @param {Array<{ href?: string, priceText?: string, sold?: boolean }>} tiles
 * @returns {Array<{ itemId: string, askPrice: number, href: string }>}
 */
export function parseSearchTiles(tiles) {
  const results = [];
  for (const tile of tiles ?? []) {
    if (tile.sold) {
      continue;
    }
    const itemId = extractItemId(tile.href);
    const askPrice = parseFirstMoney(tile.priceText);
    if (!itemId || askPrice == null || askPrice <= 0) {
      continue;
    }
    results.push({
      itemId,
      askPrice,
      href: tile.href,
    });
  }
  return results;
}

/**
 * Scan Mercari search results for listing tiles.
 *
 * @param {import('playwright').Page} page
 * @param {string} query
 * @returns {Promise<Array<{ itemId: string, askPrice: number, href: string }>>}
 */
export async function scanMercariSearch(page, query) {
  const url = buildSearchUrl(query);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(2000);
  }

  const rawTiles = await page.evaluate((selectors) => {
    /* eslint-disable-next-line no-undef -- runs in browser via Playwright */
    const nodes = Array.from(document.querySelectorAll(selectors.tile));
    return nodes.map((node) => {
      const anchor = node.closest('a') || node.querySelector('a') || (node.tagName === 'A' ? node : null);
      const href = anchor?.getAttribute('href') || node.getAttribute('href') || '';
      const priceEl =
        node.querySelector(selectors.priceLoggedIn) ||
        node.querySelector(selectors.priceLoggedOut) ||
        null;
      const sold = Boolean(node.querySelector(selectors.sold));
      return {
        href,
        priceText: priceEl?.textContent?.trim() || '',
        sold,
      };
    });
  }, SEARCH_SELECTORS);

  return parseSearchTiles(rawTiles);
}
