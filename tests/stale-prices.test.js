import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fromPokemontcgPayload, fromTcgdexPayload } from '../tools/extension-wasm/lib/condition-pricing.js';
import { isStale, lotEstimate, staleDays, STALE_PRICE_DAYS } from '../tools/extension-wasm/lib/card-display.js';
import { lotExportRows } from '../tools/extension-wasm/lib/lot-export.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

const identity = { name: 'Snorunt', setCode: 'ex5', number: '73' };
const tcgdexCard = (updated) => ({
  name: 'Snorunt',
  localId: '73',
  set: { id: 'ex5' },
  pricing: { tcgplayer: { ...(updated === undefined ? {} : { updated }), normal: { marketPrice: 99, productId: 7 } } },
});

const cardWith = (price_grid) => ({
  identity: { id: 'ex5-73', name: 'Snorunt', set: 'Hidden Legends', number: '73' },
  confidence: 0.9,
  price_grid,
});

const none = () => null;

test('the stale window is 30 days', () => {
  assert.equal(STALE_PRICE_DAYS, 30);
});

test('a TCGdex grid dated 661 days ago is stale, tagged, left out of the lot total and the export', () => {
  const grid = fromTcgdexPayload(tcgdexCard(daysAgo(661)), identity);
  const stale = cardWith(grid);
  const fresh = cardWith(fromTcgdexPayload(tcgdexCard(daysAgo(2)), identity));
  assert.equal(isStale(stale, NOW), true);
  assert.equal(isStale(fresh, NOW), false);
  assert.equal(staleDays(grid, NOW), 661);

  const lot = lotEstimate([stale, fresh], none, ['NM'], NOW);
  assert.equal(lot.high, 99, 'only the fresh card is summed');
  assert.equal(lot.toCheck, 1);
  assert.equal(lot.identified, 1);

  const out = lotExportRows([stale, fresh], none, ['NM'], NOW);
  assert.equal(out.count, 1);
  assert.equal(out.notIncluded, 1);
});

test('a pokemontcg.io grid is stale by the same rule', () => {
  const grid = fromPokemontcgPayload({ normal: { market: 5 } }, '2025/01/01', NOW);
  assert.equal(isStale(cardWith(grid), NOW), true);
});

test('any grid carrying a date older than 30 days is stale, whatever its source', () => {
  for (const source of ['backend', 'ppt', 'tcgdex', 'pokemontcg']) {
    const grid = { source, updatedAt: daysAgo(31), variants: { normal: { conditions: { NM: 4 }, market: 4 } } };
    assert.equal(isStale(cardWith(grid), NOW), true, source);
    assert.equal(isStale(cardWith({ ...grid, updatedAt: daysAgo(30) }), NOW), false, `${source} at exactly 30 days`);
  }
});

test('a missing or unparseable date is unknown, not stale', () => {
  const variants = { normal: { conditions: { NM: 4 }, market: 4 } };
  assert.equal(isStale(cardWith({ source: 'backend', variants }), NOW), false);
  assert.equal(isStale(cardWith({ source: 'tcgdex', updatedAt: null, variants }), NOW), false);
  assert.equal(isStale(cardWith({ source: 'tcgdex', updatedAt: 'not a date', variants }), NOW), false);
  assert.equal(isStale(cardWith(fromTcgdexPayload(tcgdexCard(undefined), identity)), NOW), false);
  assert.equal(isStale(cardWith(null), NOW), false);
});

test('a date in the future is not stale', () => {
  const grid = { source: 'tcgdex', updatedAt: daysAgo(-5), variants: { normal: { conditions: { NM: 4 }, market: 4 } } };
  assert.equal(isStale(cardWith(grid), NOW), false);
});
