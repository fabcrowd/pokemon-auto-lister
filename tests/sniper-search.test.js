import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl,
  mercariFirstPhotoUrl,
  extractItemId,
  parseSearchTiles,
} from '../src/sniper/mercariSearch.js';
import { heartItemOnSearchPage } from '../src/sniper/heart.js';

describe('mercariSearch helpers', () => {
  it('builds a search URL with keyword', () => {
    const url = buildSearchUrl('pokemon psa 8');
    assert.match(url, /mercari\.com\/search/);
    assert.match(url, /keyword=pokemon/);
  });

  it('builds first photo CDN URL', () => {
    assert.equal(
      mercariFirstPhotoUrl('m12345678901'),
      'https://u-mercari-images.mercdn.net/photos/m12345678901_1.jpg',
    );
  });

  it('extracts item ids from hrefs', () => {
    assert.equal(extractItemId('/item/m12345678901/'), 'm12345678901');
    assert.equal(extractItemId('https://www.mercari.com/item/m999/'), 'm999');
    assert.equal(extractItemId('/sell/'), null);
  });

  it('parses tiles, skips sold, uses first money token', () => {
    const parsed = parseSearchTiles([
      { href: '/item/m111/', priceText: '$99.75$105', sold: false },
      { href: '/item/m222/', priceText: '$40', sold: true },
      { href: '/item/m333/', priceText: '$55.00', sold: false },
      { href: '/bad/', priceText: '$10', sold: false },
    ]);
    assert.deepEqual(parsed, [
      { itemId: 'm111', askPrice: 99.75, href: '/item/m111/' },
      { itemId: 'm333', askPrice: 55, href: '/item/m333/' },
    ]);
  });
});

describe('heartItemOnSearchPage', () => {
  it('clicks ItemLike on the matching tile', async () => {
    const clicks = [];
    const page = {
      evaluate: async (fn, arg) =>
        fn(
          {
            ...arg,
            // simulate DOM via the evaluate callback's expected shape by
            // invoking a stub that mirrors production return
          },
          // Playwright page.evaluate serializes — we stub the whole call:
        ),
    };
    // Replace with direct stub of evaluate result path
    page.evaluate = async (_fn, { itemId }) => {
      assert.equal(itemId, 'm111');
      clicks.push(itemId);
      return { ok: true };
    };

    const result = await heartItemOnSearchPage(page, 'm111');
    assert.equal(result.ok, true);
    assert.deepEqual(clicks, ['m111']);
  });

  it('rejects missing itemId', async () => {
    const result = await heartItemOnSearchPage({}, '');
    assert.equal(result.ok, false);
  });
});
