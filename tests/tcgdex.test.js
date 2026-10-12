import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTcgdexClient, ecbEurUsdRate, extractTcgdexUsd, tcgdexIdFor } from '../src/pricing/tcgdex.js';

const victreebel = {
  id: 'sv03.5-071',
  localId: '071',
  name: 'Victreebel',
  set: { id: 'sv03.5', name: '151' },
  pricing: {
    cardmarket: { unit: 'EUR', trend: 0.07, avg7: 0.09 },
    tcgplayer: {
      unit: 'USD',
      'reverse-holofoil': { marketPrice: 0.31 },
      normal: { marketPrice: 0.2, midPrice: 0.25 },
    },
  },
};

function stubFetch(byId) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const id = decodeURIComponent(String(url).split('/cards/')[1] || '');
    const card = byId[id];
    return card
      ? { ok: true, status: 200, json: async () => card }
      : { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('tcgdexIdFor uses a catalog productId, else setCode + number', () => {
  assert.equal(tcgdexIdFor({ productId: 'sv03.5-071' }), 'sv03.5-071');
  assert.equal(tcgdexIdFor({ setCode: 'base1', number: '4' }), 'base1-4');
  assert.equal(tcgdexIdFor({ productId: 'label:CLV-003', setCode: 'base1', number: '4' }), 'base1-4');
  assert.equal(tcgdexIdFor({ name: 'Pikachu' }), null);
});

test('extractTcgdexUsd prefers holofoil, then normal, then reverse holo', () => {
  assert.equal(extractTcgdexUsd(victreebel.pricing.tcgplayer), 0.2);
  assert.equal(extractTcgdexUsd({ holofoil: { marketPrice: 9 }, normal: { marketPrice: 1 } }), 9);
  assert.equal(extractTcgdexUsd({ 'reverse-holofoil': { marketPrice: 0.31 } }), 0.31);
  assert.equal(extractTcgdexUsd({ '1st-edition-holofoil': { marketPrice: 0, midPrice: 40 } }), 40);
  assert.equal(extractTcgdexUsd(null), null);
});

test('getMarketPrice prices the exact catalog card by id', async () => {
  const { fetchImpl, calls } = stubFetch({ 'sv03.5-071': victreebel });
  const client = createTcgdexClient({ fetchImpl });
  const result = await client.getMarketPrice({ name: 'Victreebel', set: '151', number: '071', productId: 'sv03.5-071' });
  assert.equal(result.market, 0.2);
  assert.equal(result.source, 'tcgdex');
  assert.equal(result.productId, 'sv03.5-071');
  assert.equal(result.number, '071');
  assert.equal(result.set, '151');
  assert.equal(calls.length, 1);
  await client.getMarketPrice({ name: 'Victreebel', productId: 'sv03.5-071' });
  assert.equal(calls.length, 1, 'cached');
});

test('getMarketPrice refuses a card whose name differs from the identity', async () => {
  const { fetchImpl } = stubFetch({ 'sv03.5-071': victreebel });
  const client = createTcgdexClient({ fetchImpl });
  assert.equal(await client.getMarketPrice({ name: 'Bellsprout', productId: 'sv03.5-071' }), null);
});

test('getMarketPrice returns null without a resolvable id or without a USD price', async () => {
  const { fetchImpl } = stubFetch({ 'base1-4': { id: 'base1-4', name: 'Charizard', localId: '4', set: { name: 'Base Set' } } });
  const client = createTcgdexClient({ fetchImpl });
  assert.equal(await client.getMarketPrice({ name: 'Charizard' }), null);
  assert.equal(await client.getMarketPrice({ name: 'Charizard', setCode: 'base1', number: '4' }), null);
  assert.equal(await client.getMarketPrice({ name: 'Nope', productId: 'xx-1' }), null);
});

test('getMarketPrice surfaces server errors instead of caching them as no price', async () => {
  const client = createTcgdexClient({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(client.getMarketPrice({ name: 'Victreebel', productId: 'sv03.5-071' }), /503/);
});

const milotic = {
  id: 'swsh12tg-TG02', localId: 'TG02', name: 'Milotic', set: { name: 'Silver Tempest Trainer Gallery' },
  pricing: { tcgplayer: null, cardmarket: { unit: 'EUR', trend: 10, avg30: 9 } },
};

test('getMarketPrice falls back to Cardmarket EUR converted at the ECB rate when TCGplayer is missing', async () => {
  const { fetchImpl } = stubFetch({ 'swsh12tg-TG02': milotic });
  const client = createTcgdexClient({ fetchImpl, eurUsdRate: async () => 1.12 });
  const result = await client.getMarketPrice({ name: 'Milotic', productId: 'swsh12tg-TG02' });
  assert.equal(result.market, 11.2);
  assert.equal(result.basis, 'cardmarket-eur');
  assert.equal(result.eur, 10);
  assert.equal(result.currency, 'USD');
});

test('getMarketPrice gives no Cardmarket fallback without an exchange rate', async () => {
  const { fetchImpl } = stubFetch({ 'swsh12tg-TG02': milotic });
  const client = createTcgdexClient({ fetchImpl, eurUsdRate: async () => null });
  assert.equal(await client.getMarketPrice({ name: 'Milotic', productId: 'swsh12tg-TG02' }), null);
});

test('TCGplayer USD stays the basis when present', async () => {
  const { fetchImpl } = stubFetch({ 'sv03.5-071': victreebel });
  const client = createTcgdexClient({ fetchImpl, eurUsdRate: async () => 1.12 });
  const result = await client.getMarketPrice({ name: 'Victreebel', productId: 'sv03.5-071' });
  assert.equal(result.basis, 'tcgplayer');
  assert.equal(result.market, 0.2);
});

test('ecbEurUsdRate reads the frankfurter rate and caches it', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ rates: { USD: 1.1206 } }) }; };
  const rate = ecbEurUsdRate({ fetchImpl });
  assert.equal(await rate(), 1.1206);
  assert.equal(await rate(), 1.1206);
  assert.equal(calls, 1);
  const down = ecbEurUsdRate({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  assert.equal(await down(), null);
});

test('Cardmarket fallback uses the base trend; "-holo" fields are the reverse-holo variant', async () => {
  const meowstic = {
    id: 'xyp-XY48', localId: 'XY48', name: 'Meowstic', set: { name: 'XY Black Star Promos' },
    pricing: { tcgplayer: null, cardmarket: { trend: 7.03, avg30: 6.5, 'trend-holo': 2.25 } },
  };
  const { fetchImpl } = stubFetch({ 'xyp-XY48': meowstic });
  const client = createTcgdexClient({ fetchImpl, eurUsdRate: async () => 1 });
  assert.equal((await client.getMarketPrice({ name: 'Meowstic', productId: 'xyp-XY48' })).eur, 7.03);
});

test('getMarketPrice refuses a same-name card from another set or number', async () => {
  const { fetchImpl } = stubFetch({ 'sv03.5-071': victreebel });
  const client = createTcgdexClient({ fetchImpl, eurUsdRate: async () => 1 });
  assert.equal(await client.getMarketPrice({ name: 'Victreebel', setCode: 'base2', number: '14', productId: 'sv03.5-071' }), null);
  assert.equal(await client.getMarketPrice({ name: 'Victreebel', setCode: 'sv03.5', number: '72', productId: 'sv03.5-071' }), null);
  assert.ok(await client.getMarketPrice({ name: 'Victreebel', setCode: 'sv03.5', number: '071/165', productId: 'sv03.5-071' }));
});

test('Cardmarket reverse-holo fields alone do not price the card', async () => {
  const onlyHolo = { ...milotic, pricing: { tcgplayer: null, cardmarket: { trend: 0, 'trend-holo': 4 } } };
  const { fetchImpl } = stubFetch({ 'swsh12tg-TG02': onlyHolo });
  const client = createTcgdexClient({ fetchImpl, eurUsdRate: async () => 1 });
  assert.equal(await client.getMarketPrice({ name: 'Milotic', productId: 'swsh12tg-TG02' }), null);
});

test('ecbEurUsdRate keeps the last good rate and backs off after a failure', async () => {
  let now = 0;
  const replies = [{ ok: true, status: 200, json: async () => ({ rates: { USD: 1.1 } }) }];
  let calls = 0;
  const rate = ecbEurUsdRate({ fetchImpl: async () => { calls += 1; return replies.shift() || { ok: false, status: 503, json: async () => ({}) }; }, now: () => now });
  assert.equal(await rate(), 1.1);
  now += 13 * 60 * 60 * 1000;
  assert.equal(await rate(), 1.1, 'stale rate beats no rate');
  assert.equal(await rate(), 1.1);
  assert.equal(calls, 2, 'no refetch during back-off');
});
