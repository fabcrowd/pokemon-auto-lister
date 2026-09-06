export const HEART_SELECTORS = {
  tileHeart: '[data-testid="ItemLike"]',
  itemPageHeart: '[data-testid="LikeComp"]',
};

/**
 * Heart a listing from the search results page by item id.
 * Caller must ensure the item is not already hearted in durable state
 * (double-click would un-heart).
 *
 * @param {import('playwright').Page} page
 * @param {string} itemId
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function heartItemOnSearchPage(page, itemId) {
  if (!itemId) {
    return { ok: false, reason: 'missing itemId' };
  }

  const clicked = await page.evaluate(
    ({ itemId: id, selectors }) => {
      /* eslint-disable-next-line no-undef -- runs in browser via Playwright */
      const tiles = Array.from(document.querySelectorAll('[data-testid="ProductThumbWrapper"]'));
      for (const tile of tiles) {
        const anchor = tile.closest('a') || tile.querySelector('a') || (tile.tagName === 'A' ? tile : null);
        const href = anchor?.getAttribute('href') || tile.getAttribute('href') || '';
        if (!href.includes(id)) {
          continue;
        }
        const heart = tile.querySelector(selectors.tileHeart);
        if (!heart) {
          return { ok: false, reason: 'heart control not found' };
        }
        heart.click();
        return { ok: true };
      }
      return { ok: false, reason: 'tile not found' };
    },
    { itemId, selectors: HEART_SELECTORS },
  );

  return clicked;
}
