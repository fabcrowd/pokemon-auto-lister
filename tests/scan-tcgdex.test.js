import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decidePrice } from '../src/pricing/pricing.js';
import { scanAndPrice } from '../src/scan/scanAndPrice.js';

const identity = { name: 'Victreebel', set: '151', setCode: 'sv03.5', number: '071', productId: 'sv03.5-071' };

function resolver() {
  return {
    evaluateFrontImage: async () => ({
      mode: 'local-only',
      identity,
      pokegrade: null,
      vellum: null,
      identities: { vellum: identity },
      identityConflict: false,
      localAbstained: false,
      pokegradeSkipped: true,
      reason: null,
    }),
  };
}

test('decidePrice counts a TCGdex comp, so two keyless sources can auto-price', () => {
  const decision = decidePrice({ tcgdex: { market: 10 }, pokemontcgapi: { market: 10.5 } });
  assert.equal(decision.comps.tcgdex, 10);
  assert.equal(decision.action, 'auto');
});

test('scanAndPrice asks TCGdex for the identified catalog card and reports it as a source', async () => {
  const asked = [];
  const tcgdexClient = { getMarketPrice: async (id) => { asked.push(id); return { market: 0.2, source: 'tcgdex' }; } };
  const result = await scanAndPrice({ frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), tcgdexClient });
  assert.equal(asked[0].productId, 'sv03.5-071');
  assert.equal(result.comps.tcgdex, 0.2);
  assert.ok(result.pricingSources.includes('tcgdex'));
});

test('scanAndPrice survives a TCGdex outage', async () => {
  const tcgdexClient = { getMarketPrice: async () => { throw new Error('TCGdex /cards/x failed: 503'); } };
  const result = await scanAndPrice({ frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), tcgdexClient });
  assert.equal(result.ok, true);
  assert.equal(result.comps.tcgdex, null);
});

test('scanAndPrice keeps raw Cardmarket EUR out of the USD median', async () => {
  const pokemonTcgApiClient = { getPrices: async () => ({ name: 'Victreebel', tcgplayer: null, cardmarket: { market: 9, currency: 'EUR' } }) };
  const result = await scanAndPrice({ frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), pokemonTcgApiClient });
  assert.equal(result.comps.cardmarket, null);
});

test('a Cardmarket-converted TCGdex price yields to any TCGplayer-based comp', async () => {
  const tcgdexClient = { getMarketPrice: async () => ({ market: 15.45, source: 'tcgdex', basis: 'cardmarket-eur' }) };
  const pokemonTcgApiClient = { getPrices: async () => ({ name: 'Victreebel', tcgplayer: { market: 1.34, currency: 'USD' } }) };
  const result = await scanAndPrice({ frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), tcgdexClient, pokemonTcgApiClient });
  assert.equal(result.comps.tcgdex, null);
  assert.equal(result.comps.pokemontcgapi, 1.34);
});

test('a Cardmarket-converted TCGdex price is used when it is the only price', async () => {
  const tcgdexClient = { getMarketPrice: async () => ({ market: 9.83, source: 'tcgdex', basis: 'cardmarket-eur' }) };
  const result = await scanAndPrice({ frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), tcgdexClient });
  assert.equal(result.comps.tcgdex, 9.83);
});
