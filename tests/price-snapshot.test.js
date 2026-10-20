import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applySnapshot, createSnapshotClient, parseSnapshot } from '../tools/extension-wasm/lib/price-snapshot.js';

const UPDATED = '2026-10-18T20:05:40Z';
const FILE = JSON.stringify({
  v: 1,
  updatedAt: UPDATED,
  prices: {
    517044: { Holofoil: 88.85 },
    89401: { Normal: 0.46, 'Reverse Holofoil': 9.5 },
  },
});

function grid(overrides = {}) {
  return {
    source: 'tcgdex',
    updatedAt: '2026-10-14T22:55:09.651Z',
    spreadRatio: 1,
    variants: {
      holofoil: { productId: 517044, market: 92.29, conditions: { NM: 92.29, LP: null, MP: null, HP: null, DMG: null } },
    },
    ...overrides,
  };
}

test('a matching product takes today\'s price and date', () => {
  const next = applySnapshot(grid(), parseSnapshot(FILE));
  assert.equal(next.updatedAt, UPDATED);
  assert.equal(next.variants.holofoil.market, 88.85);
  assert.equal(next.variants.holofoil.conditions.NM, 88.85);
  assert.equal(next.variants.holofoil.conditions.LP, null);
});

test('another product and another source leave the card alone', () => {
  const card = grid();
  const other = parseSnapshot(JSON.stringify({ v: 1, updatedAt: UPDATED, prices: { 999: { Holofoil: 1 } } }));
  assert.equal(applySnapshot(card, other), card);
  const tracker = grid({ source: 'ppt' });
  assert.equal(applySnapshot(tracker, parseSnapshot(FILE)), tracker);
});

test('two printings of one product stay on their own prices', () => {
  const card = grid({
    variants: {
      normal: { productId: 89401, market: 0.4, conditions: { NM: 0.4, LP: null, MP: null, HP: null, DMG: null } },
      reverseHolofoil: { productId: 89401, market: 8, conditions: { NM: 8, LP: null, MP: null, HP: null, DMG: null } },
    },
  });
  const next = applySnapshot(card, parseSnapshot(FILE));
  assert.equal(next.variants.normal.market, 0.46);
  assert.equal(next.variants.reverseHolofoil.market, 9.5);
  assert.equal(next.spreadRatio, 9.5 / 0.46);
});

test('a file that is not the snapshot is refused', () => {
  assert.throws(() => parseSnapshot('{"v":2}'), /no date/);
  assert.throws(() => parseSnapshot('x'.repeat(8_000_001)), /too large/);
});

function memory() {
  const data = new Map();
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, value); },
  };
}

test('the snapshot is downloaded once a day, and a failure keeps the previous copy', async () => {
  let now = 1_000;
  let calls = 0;
  let fail = false;
  const storage = memory();
  const client = createSnapshotClient({
    storage,
    now: () => now,
    url: 'https://github.com/fabcrowd/card-scanner-data/releases/download/prices/prices.json',
    fetchImpl: async () => {
      calls += 1;
      if (fail) throw new Error('offline');
      return { ok: true, status: 200, text: async () => FILE };
    },
  });
  assert.equal((await client.currentSnapshot()).updatedAt, UPDATED);
  assert.equal((await client.currentSnapshot()).prices['517044'].Holofoil, 88.85);
  assert.equal(calls, 1);
  now += 25 * 60 * 60 * 1000;
  fail = true;
  assert.equal((await client.currentSnapshot()).updatedAt, UPDATED);
  assert.equal(calls, 2);
  now += 60 * 1000;
  assert.equal(await client.refreshPriceSnapshot(), (await client.currentSnapshot()));
  assert.equal(calls, 2);
});
