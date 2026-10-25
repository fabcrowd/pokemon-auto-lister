import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HIGH_STAKES_MIN_USD, bestMatchPrice, isHighValue, priceTypicalOf, unconfirmedTotal,
} from '../tools/extension-wasm/lib/stakes.js';

test('the high-value threshold is the PM number', () => {
  assert.equal(HIGH_STAKES_MIN_USD, 50);
});

test('isHighValue is a flag only: not user-confirmed and typical price at $50 or more', () => {
  assert.equal(isHighValue({}, 50), true);
  assert.equal(isHighValue({}, 49.99), false);
  assert.equal(isHighValue({ userConfirmed: true }, 500), false);
  assert.equal(isHighValue({}, null), false);
  assert.equal(isHighValue({}, NaN), false);
});

const grid = (values) => ({ source: 'pokemontcg', variants: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { market: v, conditions: { NM: v } }])) });


const one = (grid_, extra = {}) => ({ identity: { id: 'a', name: 'A' }, setChoices: [], price_grid: grid_, ...extra });

test('priceTypicalOf: the quote when settled, else the median NM price over the printings, else null', () => {
  // range $0.21-$103.66 over four printings: the lower middle value (2nd lowest)
  const potion = one(grid({ normal: 0.21, reverse: 0.5, holo: 10, first: 103.66 }));
  assert.equal(priceTypicalOf(potion, null), 0.5);
  // odd count: the middle one
  assert.equal(priceTypicalOf(one(grid({ a: 1, b: 7, c: 200 })), null), 7);
  // a settled printing is quoted
  assert.equal(priceTypicalOf(potion, 'first'), 103.66);
  // one printing: that price
  assert.equal(priceTypicalOf(one(grid({ normal: 303 })), null), 303);
  // printings with no NM price are left out; none at all: no typical price
  const partial = one({ source: 'x', variants: { a: { conditions: { NM: 4 } }, b: { conditions: {} }, c: { conditions: { NM: 8 } } } });
  assert.equal(priceTypicalOf(partial, null), 4, 'two prices: the lower one');
  assert.equal(priceTypicalOf(one({ source: 'x', variants: { a: { conditions: {} } } }), null), null);
  assert.equal(priceTypicalOf(one(null, { market_price: null }), null), null);
  // legacy single market price
  assert.equal(priceTypicalOf(one(null, { market_price: 60 }), null), 60);
  // an open set with only a range row has no per-printing prices: no demotion price
  assert.equal(priceTypicalOf({ identity: { name: 'A' }, setChoices: [{ id: 'x' }, { id: 'y' }], setRange: { low: 2, high: 60, count: 2, total: 2 }, price_grid: null }, null), null);
});

const cand = (grid_, extra = {}) => ({ identity: { id: 'c', name: 'C' }, setChoices: [], setConfirmed: true, price_grid: grid_, ...extra });

test('bestMatchPrice: a single printing is quoted', () => {
  assert.deepEqual(bestMatchPrice({}, cand(grid({ normal: 1.2 })), ['NM']), { price: 1.2, kind: 'quoted', stale: false });
});

test('bestMatchPrice: an open printing with a suggested variant prices at that variant; the prompt stays', () => {
  const resp = cand(grid({ normal: 1, holofoil: 9 }));
  const scanned = { variant: { finish: 'holofoil' } };
  const out = bestMatchPrice(scanned, resp, ['NM']);
  assert.equal(out.kind, 'suggested');
  assert.equal(out.price, 9);
});

test('bestMatchPrice: open printing, nothing suggested: the typical (lower middle) price, marked typical, never a range', () => {
  const out = bestMatchPrice({}, cand(grid({ normal: 0.34, first: 103.66 })), ['NM']);
  assert.deepEqual(out, { price: 0.34, kind: 'typical', stale: false });
});

test('bestMatchPrice: no data is none; an unloaded answer is null', () => {
  assert.deepEqual(bestMatchPrice({}, cand(null, { market_price: null }), ['NM']), { price: null, kind: 'none', stale: false });
  assert.equal(bestMatchPrice({}, undefined, ['NM']), null);
});

test('bestMatchPrice: an old price is flagged stale', () => {
  const old = cand({ ...grid({ normal: 4 }), updatedAt: '2020-01-01T00:00:00Z' });
  assert.equal(bestMatchPrice({}, old, ['NM']).stale, true);
});

test('unconfirmedTotal sums non-stale priced best matches of Choose cards only; skipped and confirmed excluded', () => {
  const chooseCard = (extra = {}) => ({ identity: {}, abstain: true, candidates: [{ id: 'a', name: 'A' }], ...extra });
  const cards = [chooseCard(), chooseCard(), chooseCard(), chooseCard({ skipped: true }), { identity: { id: 'k', name: 'K' }, confidence: 0.9, setChoices: [], setConfirmed: true }];
  const answers = [
    { price: 1.5, kind: 'quoted', stale: false },
    { price: 2, kind: 'typical', stale: true },
    { price: null, kind: 'none', stale: false },
    { price: 9, kind: 'quoted', stale: false },
    { price: 7, kind: 'quoted', stale: false },
  ];
  assert.deepEqual(unconfirmedTotal(cards, (card, idx) => answers[idx]), { total: 1.5, count: 1 });
});
