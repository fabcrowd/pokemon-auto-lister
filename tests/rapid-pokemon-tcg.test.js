import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRapidPokemonTcgClient,
  extractRawMarketUsd,
  scoreMatch,
  toUsd,
} from '../src/pricing/rapidPokemonTcg.js';
import { decidePrice } from '../src/pricing/pricing.js';

test('toUsd converts EUR with configured rate', () => {
  assert.ok(Math.abs(toUsd(100, 'EUR', 1.1) - 110) < 1e-9);
  assert.equal(toUsd(100, 'USD', 1.1), 100);
});

test('extractRawMarketUsd prefers tcg_player market_price', () => {
  const market = extractRawMarketUsd(
    {
      prices: {
        tcg_player: { currency: 'EUR', market_price: 50 },
        cardmarket: { currency: 'EUR', lowest_near_mint: 40 },
      },
    },
    1.0,
  );
  assert.equal(market, 50);
});

test('scoreMatch rewards name + number + set', () => {
  const card = {
    name: 'Charizard ex',
    card_number: 223,
    episode: { name: 'Obsidian Flames' },
    tcgid: 'sv3-223',
  };
  assert.ok(
    scoreMatch(card, { name: 'Charizard ex', number: '223', set: 'Obsidian Flames' }) >= 10,
  );
});

test('createRapidPokemonTcgClient getMarketPrice picks best match and hydrates by id', async () => {
  const calls = [];
  const client = createRapidPokemonTcgClient({
    apiKey: 'test-key',
    eurUsd: 1.0,
    fetchImpl: async (url) => {
      const href = String(url);
      calls.push(href);
      if (/\/cards\/2914$/.test(href)) {
        return {
          ok: true,
          async json() {
            return {
              id: 2914,
              name: 'Charizard ex',
              card_number: 223,
              tcgid: 'sv3-223',
              episode: { name: 'Obsidian Flames' },
              prices: {
                tcg_player: { currency: 'EUR', market_price: 93.56 },
              },
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            data: [
              {
                id: 2914,
                name: 'Charizard ex',
                card_number: 223,
                tcgid: 'sv3-223',
                episode: { name: 'Obsidian Flames' },
                prices: {
                  tcg_player: { currency: 'EUR', market_price: 90 },
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

  assert.equal(result.market, 93.56);
  assert.equal(result.rapidapiId, 2914);
  assert.equal(result.source, 'rapidapi-pokemon-tcg');
  assert.ok(calls.some((u) => u.includes('card_number=223')));
  assert.ok(calls.some((u) => /\/cards\/2914$/.test(u)));
});

test('getCardById loads GET /cards/{id}', async () => {
  const client = createRapidPokemonTcgClient({
    apiKey: 'test-key',
    eurUsd: 1.0,
    fetchImpl: async (url) => {
      assert.match(String(url), /\/cards\/3852$/);
      return {
        ok: true,
        async json() {
          return {
            id: 3852,
            name: 'Giratina VSTAR',
            card_number: 'GG69',
            prices: { tcg_player: { currency: 'EUR', market_price: 194.31 } },
          };
        },
      };
    },
  });
  const card = await client.getCardById(3852);
  assert.equal(card.name, 'Giratina VSTAR');
});

test('decidePrice accepts rapidapi as a second comps source with pokegrade', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    rapidapi: { market: 104 },
  });
  assert.equal(result.action, 'auto');
  assert.equal(result.comps.rapidapi, 104);
  assert.equal(result.suggested.mercari, 102);
});
