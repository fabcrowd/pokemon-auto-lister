import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJustTcgClient, extractNearMintUsd, justTcgSetName, sameSetName, scoreMatch } from '../src/pricing/justTcg.js';
import { decidePrice } from '../src/pricing/pricing.js';

test('extractNearMintUsd prefers Holofoil Near Mint USD', () => {
  const price = extractNearMintUsd({
    variants: [
      {
        type: 'raw',
        condition: 'Near Mint',
        printing: 'Normal',
        language: 'English',
        markets: [{ currency: 'USD', price: 12 }],
      },
      {
        type: 'raw',
        condition: 'Near Mint',
        printing: 'Holofoil',
        language: 'English',
        markets: [{ currency: 'USD', region: 'US', price: 109.94 }],
      },
    ],
  });
  assert.equal(price, 109.94);
});

test('scoreMatch matches number across 223 vs 223/197', () => {
  const score = scoreMatch(
    { name: 'Charizard ex - 223/197', number: '223/197', set: { name: 'SV03: Obsidian Flames' } },
    { name: 'Charizard ex', number: '223', set: 'Obsidian Flames' },
  );
  assert.ok(score >= 10);
});

test('createJustTcgClient getMarketPrice uses v2 search', async () => {
  const client = createJustTcgClient({
    apiKey: 'tcg_test',
    fetchImpl: async (url) => {
      if (/\/sets/.test(String(url))) return { ok: true, async json() { return { data: [] }; } };
      assert.match(String(url), /\/v2\/cards/);
      assert.match(String(url), /game=Pokemon/);
      return {
        ok: true,
        async json() {
          return {
            data: [
              {
                id: 'abc',
                name: 'Charizard ex - 223/197',
                number: '223/197',
                set: { name: 'SV03: Obsidian Flames' },
                variants: [
                  {
                    type: 'raw',
                    condition: 'Near Mint',
                    printing: 'Holofoil',
                    language: 'English',
                    markets: [{ currency: 'USD', price: 109.94 }],
                  },
                ],
              },
            ],
          };
        },
      };
    },
  });

  const result = await client.getMarketPrice({
    name: 'Charizard ex',
    number: '223',
    set: 'Obsidian Flames',
  });
  assert.equal(result.market, 109.94);
  assert.equal(result.source, 'justtcg');
});

test('decidePrice accepts justtcg as a comps source', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    justtcg: { market: 105 },
  });
  assert.equal(result.action, 'auto');
  assert.equal(result.comps.justtcg, 105);
});

function stubClient(cards) {
  return createJustTcgClient({
    apiKey: 'tcg_test',
    fetchImpl: async () => ({ ok: true, async json() { return { data: cards }; } }),
  });
}

const nm = (price) => [
  { type: 'raw', condition: 'Near Mint', printing: 'Holofoil', language: 'English', markets: [{ currency: 'USD', price }] },
];

test('getMarketPrice refuses a same-name card from another set and number', async () => {
  const client = stubClient([{ id: 'x', name: 'Tropius', number: '27/107', set: { name: 'EX Deoxys' }, variants: nm(1.61) }]);
  assert.equal(await client.getMarketPrice({ name: 'Tropius', number: '6', set: 'Evolving Skies' }), null);
});

test('getMarketPrice refuses same name and number from a different set', async () => {
  const client = stubClient([{ id: 'x', name: 'Venusaur', number: '3/108', set: { name: 'Dark Explorers' }, variants: nm(9) }]);
  assert.equal(await client.getMarketPrice({ name: 'Venusaur', number: '003', set: 'Trading Card Game Classic' }), null);
});

test('getMarketPrice matches set names across accents and series prefixes', async () => {
  const client = stubClient([
    { id: 'a', name: 'Venusaur', number: '3/108', set: { name: 'Dark Explorers' }, variants: nm(9) },
    { id: 'b', name: 'Venusaur', number: '003/078', set_name: 'Pokemon GO', variants: nm(4.5) },
  ]);
  const result = await client.getMarketPrice({ name: 'Venusaur', number: '3', set: 'Pokémon GO' });
  assert.equal(result.justtcgId, 'b');
  assert.equal(result.market, 4.5);
});

test('searchCards filters by the JustTCG set id resolved from the identity set name', async () => {
  const urls = [];
  const client = createJustTcgClient({
    apiKey: 'tcg_test',
    fetchImpl: async (url) => {
      urls.push(String(url));
      const sets = [
        { id: 'base-set-pokemon', name: 'Base Set' },
        { id: 'base-set-2-pokemon', name: 'Base Set 2' },
        { id: 'swsh07-evolving-skies-pokemon', name: 'SWSH07: Evolving Skies' },
      ];
      const cards = [{ id: 't', name: 'Tropius', number: '006/203', set_name: 'SWSH07: Evolving Skies', variants: nm(0.3) }];
      return { ok: true, async json() { return { data: /\/sets/.test(String(url)) ? sets : cards }; } };
    },
  });
  const first = await client.getMarketPrice({ name: 'Tropius', number: '6', set: 'Evolving Skies' });
  assert.equal(first.market, 0.3);
  await client.getMarketPrice({ name: 'Charizard', number: '4', set: 'Base Set' });
  const cardUrls = urls.filter((u) => /\/cards/.test(u));
  assert.match(cardUrls[0], /set=swsh07-evolving-skies-pokemon/);
  assert.match(cardUrls[1], /set=base-set-pokemon(&|$)/);
  assert.equal(urls.filter((u) => /\/sets/.test(u)).length, 1);
});

test('searchCards falls back to free-text search when the set is unknown', async () => {
  const urls = [];
  const client = createJustTcgClient({
    apiKey: 'tcg_test',
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, async json() { return { data: [] }; } };
    },
  });
  await client.searchCards({ name: 'Venusaur', number: '003', set: 'Nonexistent Set' });
  const cardUrl = urls.find((u) => /\/cards/.test(u));
  assert.doesNotMatch(cardUrl, /[?&]set=/);
  assert.match(cardUrl, /q=Venusaur/);
});

test('series first sets resolve to the "Base Set" entry, not a shorter sibling like 151', async () => {
  const urls = [];
  const client = createJustTcgClient({
    apiKey: 'tcg_test',
    fetchImpl: async (url) => {
      urls.push(String(url));
      const sets = [
        { id: 'sv-scarlet-violet-151-pokemon', name: 'SV: Scarlet & Violet 151' },
        { id: 'sv01-scarlet-violet-base-set-pokemon', name: 'SV01: Scarlet & Violet Base Set' },
        { id: 'base-set-pokemon', name: 'Base Set' },
      ];
      return { ok: true, async json() { return { data: /\/sets/.test(String(url)) ? sets : [] }; } };
    },
  });
  await client.searchCards({ name: 'Wugtrio', number: '057', set: 'Scarlet & Violet' });
  await client.searchCards({ name: 'Charizard', number: '4', set: 'Base Set' });
  const cardUrls = urls.filter((u) => /\/cards/.test(u));
  assert.match(cardUrls[0], /set=sv01-scarlet-violet-base-set-pokemon/);
  assert.match(cardUrls[1], /set=base-set-pokemon(&|$)/);
});

test('justTcgSetName maps catalog promo, base-set and Radiant Collection names to JustTCG sets', () => {
  assert.equal(justTcgSetName({ set: 'SVP Black Star Promos', number: '078' }), 'SV: Scarlet & Violet Promo Cards');
  assert.equal(justTcgSetName({ set: 'Sun & Moon', number: '101' }), 'SM Base Set');
  assert.equal(justTcgSetName({ set: 'Generations', number: 'RC15' }), 'Generations: Radiant Collection');
  assert.equal(justTcgSetName({ set: 'Legendary Treasures', number: 'RC10' }), 'Legendary Treasures: Radiant Collection');
  assert.equal(justTcgSetName({ set: 'Generations', number: '40' }), 'Generations');
});

test('sameSetName keeps long set-name prefixes so the two Radiant Collections differ', () => {
  assert.equal(sameSetName('Generations: Radiant Collection', 'Legendary Treasures: Radiant Collection'), false);
  assert.equal(sameSetName('Perfect Order', 'ME03: Perfect Order'), true);
});

test('getMarketPrice prices a Radiant Collection card from the RC set', async () => {
  const client = stubClient([
    { id: 'g', name: 'Meowstic', number: '60/83', set: { name: 'Generations' }, variants: nm(1) },
    { id: 'rc', name: 'Meowstic', number: 'RC15/RC32', set: { name: 'Generations: Radiant Collection' }, variants: nm(2.5) },
  ]);
  const result = await client.getMarketPrice({ name: 'Meowstic', number: 'RC15', set: 'Generations' });
  assert.equal(result.justtcgId, 'rc');
});

test('sameSetName requires the same set, not a prefix-sharing sibling', () => {
  assert.equal(sameSetName('Base Set', 'Base Set 2'), false);
  assert.equal(sameSetName('Generations', 'Generations: Radiant Collection'), false);
  assert.equal(sameSetName('Celebrations', 'Celebrations: Classic Collection'), false);
  assert.equal(sameSetName('XY', 'XY Promos'), false);
  assert.equal(sameSetName('Scarlet & Violet', 'SV01: Scarlet & Violet Base Set'), true);
  assert.equal(sameSetName('Perfect Order', 'ME03: Perfect Order'), true);
  assert.equal(sameSetName('Pokémon GO', 'Pokemon GO'), true);
});

test('getMarketPrice without a number refuses a longer name (Mew is not Mewtwo)', async () => {
  const client = stubClient([{ id: 'm2', name: 'Mewtwo', number: '10/102', set: { name: 'Base Set' }, variants: nm(5) }]);
  assert.equal(await client.getMarketPrice({ name: 'Mew', set: 'Base Set' }), null);
});

test('sameSetName handles JustTCG era prefixes and "and" spellings', () => {
  assert.equal(sameSetName('Fates Collide', 'XY - Fates Collide'), true);
  assert.equal(sameSetName('Guardians Rising', 'SM - Guardians Rising'), true);
  assert.equal(sameSetName('Unseen Forces', 'EX Unseen Forces'), true);
  assert.equal(sameSetName('Black & White', 'Black and White'), true);
  assert.equal(sameSetName('Evolutions', 'SV: Prismatic Evolutions'), false);
  assert.equal(sameSetName('Dragon', 'Dragon Majesty'), false);
  assert.equal(sameSetName('SM Base Set', 'Base Set'), false);
  assert.equal(sameSetName('XY Promos', 'Promos'), false);
  assert.equal(justTcgSetName({ set: '151', number: '071' }), 'SV: Scarlet & Violet 151');
});
