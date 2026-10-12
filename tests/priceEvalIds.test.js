import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idsToPrice, pokemontcgCorrect, sameProduct, tcgdexCorrect, trackedFetch } from '../scripts/price-eval-ids.mjs';

test('sameProduct accepts JustTCG set prefixes, accents and zero-padded numbers', () => {
  assert.equal(
    sameProduct({ set: 'Perfect Order', number: '123' }, { set: 'ME03: Perfect Order', number: '123/088' }),
    true,
  );
  assert.equal(sameProduct({ set: 'Pokémon GO', number: '3' }, { set: 'Pokemon GO', number: '003/078' }), true);
  assert.equal(
    sameProduct({ set: 'Trading Card Game Classic', number: '003' }, { set: 'Trading Card Game Classic', number: '003/034' }),
    true,
  );
});

test('sameProduct rejects a same-name card from another set or number', () => {
  assert.equal(
    sameProduct({ set: 'Trading Card Game Classic', number: '003' }, { set: 'Dark Explorers', number: '3/108' }),
    false,
  );
  assert.equal(sameProduct({ set: 'Base Set', number: '15' }, { set: 'Base Set', number: '18/102' }), false);
  assert.equal(sameProduct({ set: 'Base Set', number: '15' }, null), false);
});

test('idsToPrice keeps exact-identified ids not already cached, with their identity', () => {
  const report = {
    images: [
      {
        truth: ['base1-15', 'lc-18', null],
        preds: [[[0, 0, 1, 1], 'base1-15'], [[0, 0, 1, 1], 'dp3-3'], [[0, 0, 1, 1], 'base1-15']],
        identities: [
          { name: 'Venusaur', set: 'Base Set', number: '15' },
          { name: 'Charizard', set: 'Secret Wonders', number: '3' },
          { name: 'Venusaur', set: 'Base Set', number: '15' },
        ],
      },
      {
        truth: ['sv1-1'],
        preds: [[[0, 0, 1, 1], 'sv1-1']],
        identities: [{ name: 'Sprigatito', set: 'Scarlet & Violet', number: '1' }],
      },
    ],
  };
  const todo = idsToPrice(report, { 'sv1-1': { market: 1, correct: true } });
  assert.deepEqual(todo, [['base1-15', { name: 'Venusaur', set: 'Base Set', number: '15' }]]);
});

test('sameProduct accepts JustTCG spellings of promo and Radiant Collection sets', () => {
  assert.equal(
    sameProduct({ set: 'SVP Black Star Promos', number: '078' }, { set: 'SV: Scarlet & Violet Promo Cards', number: '078' }),
    true,
  );
  assert.equal(
    sameProduct({ set: 'Legendary Treasures', number: 'RC10' }, { set: 'Legendary Treasures: Radiant Collection', number: 'RC10/RC25' }),
    true,
  );
});

test('sameProduct needs a number on both sides', () => {
  assert.equal(sameProduct({ set: 'Base Set', number: '' }, { set: 'Base Set', number: '' }), false);
});

test('trackedFetch records thrown network errors so they are not cached as misses', async () => {
  const tracked = trackedFetch(async () => { throw new Error('ECONNRESET'); });
  await assert.rejects(tracked.fetchImpl('https://x'));
  assert.equal(tracked.takeError(), 'ECONNRESET');
  assert.equal(tracked.takeError(), null);
  const ok = trackedFetch(async () => ({ ok: false, status: 429 }));
  await ok.fetchImpl('https://x');
  assert.equal(ok.takeError(), 'HTTP 429');
});

test('tcgdexCorrect requires the priced product to be the identified catalog id', () => {
  assert.equal(tcgdexCorrect('sv03.5-071', { productId: 'sv03.5-071', market: 0.2 }), true);
  assert.equal(tcgdexCorrect('sv03.5-071', { productId: 'sv03.5-072', market: 0.2 }), false);
  assert.equal(tcgdexCorrect('sv03.5-071', null), false);
});

test('pokemontcgCorrect requires the returned card to be the mapped catalog id', () => {
  assert.equal(pokemontcgCorrect('svp-078', { pokemontcgId: 'svp-78', tcgplayer: { market: 1 } }), true);
  assert.equal(pokemontcgCorrect('svp-078', { pokemontcgId: 'svp-79', tcgplayer: { market: 1 } }), false);
  assert.equal(pokemontcgCorrect('svp-078', { pokemontcgId: 'svp-78', tcgplayer: null }), false);
});

test('trackedFetch forgets a 5xx once a retry of the lookup succeeds', async () => {
  const responses = [{ ok: false, status: 500 }, { ok: true, status: 200 }];
  const tracked = trackedFetch(async () => responses.shift());
  await tracked.fetchImpl('https://x');
  await tracked.fetchImpl('https://x');
  assert.equal(tracked.takeError(), null);
});
