import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJustTcgClient, extractNearMintUsd, scoreMatch } from '../src/pricing/justTcg.js';
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
