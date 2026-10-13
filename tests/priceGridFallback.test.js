import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { chainPriceGrids } from '../src/pricing/priceGrid.js';
import { tcgdexPriceGrid } from '../src/pricing/tcgdex.js';
import { createServer } from '../src/server.js';

test('tcgdexPriceGrid maps TCGdex printings to the extension grid (market as NM)', () => {
  const grid = tcgdexPriceGrid({
    id: 'sv03.5-071', name: 'Victreebel', localId: '071', set: { name: '151' },
    pricing: { tcgplayer: { unit: 'USD', normal: { marketPrice: 0.2 }, 'reverse-holofoil': { marketPrice: 0.31 } } },
  });
  assert.equal(grid.source, 'tcgdex');
  assert.equal(grid.number, '071');
  assert.deepEqual(grid.variants.Normal, { NM: 0.2, LP: null, MP: null, HP: null, DMG: null });
  assert.equal(grid.variants['Reverse Holofoil'].NM, 0.31);
  assert.deepEqual(grid.graded, {});
  assert.equal(tcgdexPriceGrid({ pricing: {} }), null);
});

test('chainPriceGrids falls back when the first source has nothing or throws', async () => {
  const empty = { getPriceGrid: async () => null };
  const broken = { getPriceGrid: async () => { throw new Error('JustTCG /sets failed: 429'); } };
  const backup = { getPriceGrid: async (identity) => ({ source: 'tcgdex', name: identity.name }) };
  assert.equal((await chainPriceGrids(empty, backup).getPriceGrid({ name: 'Mew' })).source, 'tcgdex');
  assert.equal((await chainPriceGrids(broken, backup).getPriceGrid({ name: 'Mew' })).source, 'tcgdex');
  assert.equal(await chainPriceGrids(empty, null).getPriceGrid({ name: 'Mew' }), null);
});

test('chainPriceGrids keeps the first source when it answers', async () => {
  const primary = { getPriceGrid: async () => ({ source: 'justtcg' }) };
  const backup = { getPriceGrid: async () => assert.fail('should not be called') };
  assert.equal((await chainPriceGrids(primary, backup).getPriceGrid({ name: 'Mew' })).source, 'justtcg');
});

test('chainPriceGrids rethrows when every source fails', async () => {
  const broken = { getPriceGrid: async () => { throw new Error('down'); } };
  await assert.rejects(chainPriceGrids(broken, broken).getPriceGrid({ name: 'Mew' }), /down/);
});

test('GET /api/price-grid rejects a name with no set or number', async () => {
  const server = createServer({ priceGridClient: { getPriceGrid: async () => ({ source: 'justtcg' }) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/price-grid?name=Charizard' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert.equal(status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('chainPriceGrids reports no data (not an error) when a later source answers null', async () => {
  const broken = { getPriceGrid: async () => { throw new Error('JustTCG /sets failed: 429'); } };
  const empty = { getPriceGrid: async () => null };
  assert.equal(await chainPriceGrids(broken, empty).getPriceGrid({ name: 'Mew' }), null);
});
