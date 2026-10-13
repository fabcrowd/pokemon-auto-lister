import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPokemonTcgApiClient, pokemontcgIdCandidates } from '../src/pricing/pokemonTcgApi.js';

const milotic = {
  id: 'swsh12tg-TG02',
  name: 'Milotic',
  number: 'TG02',
  set: { id: 'swsh12tg', name: 'Silver Tempest Trainer Gallery' },
  tcgplayer: { prices: { holofoil: { market: 3.1 } } },
};

function stubFetch(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const id = decodeURIComponent(new URL(String(url)).pathname.split('/cards/')[1] || '');
    const next = responses[id];
    const res = Array.isArray(next) ? next.shift() : next;
    if (!res) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof res === 'number') return { ok: false, status: res, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: res }) };
  };
  return { fetchImpl, calls };
}

test('pokemontcgIdCandidates maps TCGdex catalog ids to pokemontcg.io spellings', () => {
  assert.deepEqual(pokemontcgIdCandidates('svp-078').slice(0, 2), ['svp-078', 'svp-78']);
  assert.ok(pokemontcgIdCandidates('sv03.5-071').includes('sv3pt5-71'));
  assert.ok(pokemontcgIdCandidates('swsh12.5gg-GG04').includes('swsh12pt5gg-GG04'));
  assert.ok(pokemontcgIdCandidates('sm7.5-76').includes('sm75-76'));
  assert.deepEqual(pokemontcgIdCandidates('swsh12tg-TG02'), ['swsh12tg-TG02', 'swsh12tg-TG2']);
  assert.deepEqual(pokemontcgIdCandidates('label:CLV-003'), []);
});

test('getPrices looks up the catalog card by mapped id and checks the name', async () => {
  const { fetchImpl, calls } = stubFetch({ 'swsh12tg-TG02': milotic });
  const client = createPokemonTcgApiClient({ fetchImpl, retryDelayMs: 0 });
  const result = await client.getPrices({ name: 'Milotic', set: 'Silver Tempest Trainer Gallery', number: 'TG02', productId: 'swsh12tg-TG02' });
  assert.equal(result.tcgplayer.market, 3.1);
  assert.equal(result.pokemontcgId, 'swsh12tg-TG02');
  assert.equal(calls.length, 1);
  assert.equal(await client.getPrices({ name: 'Gyarados', productId: 'swsh12tg-TG02' }), null);
});

test('getPrices retries a transient 5xx before giving up', async () => {
  const { fetchImpl, calls } = stubFetch({ 'swsh12tg-TG02': [500, milotic] });
  const client = createPokemonTcgApiClient({ fetchImpl, retryDelayMs: 0 });
  const result = await client.getPrices({ name: 'Milotic', productId: 'swsh12tg-TG02' });
  assert.equal(result?.tcgplayer?.market, 3.1);
  assert.equal(calls.length, 2);
});

test('getPrices does not fall back to a name search when the exact catalog card is missing', async () => {
  const { fetchImpl, calls } = stubFetch({});
  const client = createPokemonTcgApiClient({ fetchImpl, retryDelayMs: 0 });
  assert.equal(await client.getPrices({ name: 'Pikachu', set: '151', number: '025', productId: 'sv03.5-025' }), null);
  assert.ok(calls.every((url) => !url.includes('q=')), 'no search query');
});

test('a name search sends the collector number and escapes quotes', async () => {
  let query = '';
  const fetchImpl = async (url) => {
    query = new URL(String(url)).searchParams.get('q') || '';
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  const client = createPokemonTcgApiClient({ fetchImpl, retryDelayMs: 0 });
  await client.getPrices({ name: 'Say "Hi"', number: '001' });
  assert.match(query, /name:"Say \\"Hi\\""/);
  assert.match(query, /number:1(?!\d)/);
  assert.doesNotMatch(query, /001/);
});
