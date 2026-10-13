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

test('a Cardmarket-converted TCGdex price yields to eBay and Collectr USD comps', async () => {
  const tcgdexClient = { getMarketPrice: async () => ({ market: 3.3, source: 'tcgdex', basis: 'cardmarket-eur' }) };
  const ebaySoldsClient = { getRecentSolds: async () => ({ prices: [3.5], median: 3.5 }) };
  const collectrClient = { getMarketPrice: async () => ({ market: 3.4 }) };
  const result = await scanAndPrice({
    frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), tcgdexClient, ebaySoldsClient, collectrClient,
  });
  assert.equal(result.comps.tcgdex, null);
  assert.equal(result.comps.ebay, 3.5);
});

test('scanAndPrice reports the unrounded median as market', async () => {
  const tcgdexClient = { getMarketPrice: async () => ({ market: 0.46, source: 'tcgdex' }) };
  const pokemonTcgApiClient = { getPrices: async () => ({ name: 'Victreebel', tcgplayer: { market: 0.44, currency: 'USD' } }) };
  const result = await scanAndPrice({ frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), tcgdexClient, pokemonTcgApiClient });
  assert.equal(result.market, 0.45);
});

test('Base Set Charizard with 1st Edition and Unlimited prices waits for a printing choice', async () => {
  const tcgdexClient = {
    getMarketPrice: async () => ({
      market: 450, source: 'tcgdex', printing: 'unlimited-holofoil',
      variants: { '1st-edition-holofoil': 9000, 'unlimited-holofoil': 450 },
    }),
  };
  const pokemonTcgApiClient = {
    getPrices: async () => ({ name: 'Charizard', tcgplayer: { market: 460, printing: 'unlimitedHolofoil', variants: { unlimitedHolofoil: 460 } } }),
  };
  const opts = { frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), tcgdexClient, pokemonTcgApiClient };

  const unchosen = await scanAndPrice(opts);
  assert.equal(unchosen.action, 'needs_review');
  assert.equal(unchosen.reason, 'printing ambiguous');
  assert.ok(unchosen.printings.includes('1steditionholofoil'));

  const chosen = await scanAndPrice({ ...opts, printing: 'Unlimited Holofoil' });
  assert.equal(chosen.action, 'auto');
  assert.equal(chosen.suggested.ebay, 455);
});

test('low PokeGrade confidence still forces review after the printing filter drops its untagged value', async () => {
  const pokegrade = { value: 100, confidence: 'low', identity };
  const identityResolver = {
    evaluateFrontImage: async () => ({ ...await resolver().evaluateFrontImage(), mode: 'dual', pokegrade }),
  };
  const tcgdexClient = { getMarketPrice: async () => ({ market: 100, source: 'tcgdex', printing: 'unlimited-holofoil' }) };
  const pokemonTcgApiClient = { getPrices: async () => ({ name: 'Victreebel', tcgplayer: { market: 101, printing: 'unlimitedHolofoil' } }) };
  const justTcgClient = { getMarketPrice: async () => ({ market: 900, source: 'justtcg', printing: '1st Edition Holofoil' }) };
  const result = await scanAndPrice({
    frontImagePath: '/tmp/front.jpg', identityResolver, tcgdexClient, pokemonTcgApiClient, justTcgClient, printing: 'Unlimited Holofoil',
  });
  assert.equal(result.comps.pokegrade, null);
  assert.equal(result.action, 'needs_review');
  assert.equal(result.reason, 'low PokeGrade confidence');
});

test('a Cardmarket-converted TCGdex price is used when it is the only price', async () => {
  const tcgdexClient = { getMarketPrice: async () => ({ market: 9.83, source: 'tcgdex', basis: 'cardmarket-eur' }) };
  const result = await scanAndPrice({ frontImagePath: '/tmp/front.jpg', identityResolver: resolver(), tcgdexClient });
  assert.equal(result.comps.tcgdex, 9.83);
});
