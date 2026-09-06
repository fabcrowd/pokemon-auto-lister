import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPokeWalletClient, extractTcgMarketUsd, scoreMatch } from '../src/pricing/pokeWallet.js';
import { decidePrice } from '../src/pricing/pricing.js';

test('extractTcgMarketUsd prefers Holofoil market_price', () => {
  const market = extractTcgMarketUsd({
    tcgplayer: {
      prices: [
        { sub_type_name: 'Normal', market_price: 12 },
        { sub_type_name: 'Holofoil', market_price: 109.47 },
      ],
    },
  });
  assert.equal(market, 109.47);
});

test('scoreMatch uses clean_name and card_number 223/197', () => {
  const score = scoreMatch(
    {
      card_info: {
        clean_name: 'Charizard ex',
        card_number: '223/197',
        set_name: 'SV03: Obsidian Flames',
      },
    },
    { name: 'Charizard ex', number: '223', set: 'Obsidian Flames' },
  );
  assert.ok(score >= 10);
});

test('createPokeWalletClient getMarketPrice uses /search', async () => {
  const client = createPokeWalletClient({
    apiKey: 'pk_live_test',
    fetchImpl: async (url) => {
      assert.match(String(url), /\/search/);
      assert.match(String(url), /q=/);
      return {
        ok: true,
        async json() {
          return {
            results: [
              {
                id: 'pk_abc',
                card_info: {
                  clean_name: 'Charizard ex',
                  name: 'Charizard ex - 223/197',
                  card_number: '223/197',
                  set_name: 'SV03: Obsidian Flames',
                },
                tcgplayer: {
                  prices: [{ sub_type_name: 'Holofoil', market_price: 109.47 }],
                },
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
  assert.equal(result.market, 109.47);
  assert.equal(result.source, 'pokewallet');
});

test('decidePrice accepts pokewallet as a comps source', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    pokewallet: { market: 104 },
  });
  assert.equal(result.action, 'auto');
  assert.equal(result.comps.pokewallet, 104);
});
