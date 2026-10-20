import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fromTcgdexPayload, normalizePpt, pptCardUrl, tcgPlayerIdFromTcgdex } from '../tools/extension-wasm/lib/condition-pricing.js';

// api.tcgdex.net/v2/en/cards/ex16-64 on 2026-10-11, trimmed.
const snorunt = {
  id: 'ex16-64',
  localId: '64',
  name: 'Snorunt',
  set: { id: 'ex16', name: 'Power Keepers' },
  pricing: {
    cardmarket: { unit: 'EUR', trend: 0.53, 'trend-holo': 10.6 },
    tcgplayer: {
      unit: 'USD',
      updated: '2026-10-11T22:54:42.298Z',
      normal: { productId: 89401, lowPrice: 0.15, midPrice: 0.46, highPrice: 19.8, marketPrice: 0.46 },
      'reverse-holofoil': { productId: 89401, lowPrice: 9.99, midPrice: 16.17, highPrice: 53.92, marketPrice: 9.99 },
    },
  },
};

const identity = { id: 'ex16-64', name: 'Snorunt', set: 'Power Keepers', setCode: 'ex16', number: '64' };

test('a TCGdex card becomes a TCGPlayer grid with one price per printing', () => {
  const grid = fromTcgdexPayload(snorunt, identity);
  assert.equal(grid.source, 'tcgdex');
  assert.equal(grid.updatedAt, '2026-10-11T22:54:42.298Z');
  assert.deepEqual(Object.keys(grid.variants), ['normal', 'reverseHolofoil']);
  assert.equal(grid.variants.normal.market, 0.46);
  assert.equal(grid.variants.normal.productId, 89401);
  assert.equal(grid.variants.reverseHolofoil.productId, 89401);
  assert.deepEqual(grid.variants.reverseHolofoil.conditions, { NM: 9.99, LP: null, MP: null, HP: null, DMG: null });
  assert.equal(grid.defaultVariant, 'normal');
});

test('a TCGdex card for a different card is not used', () => {
  assert.equal(fromTcgdexPayload(snorunt, { ...identity, name: 'Snorlax' }), null);
  assert.equal(fromTcgdexPayload(snorunt, { ...identity, setCode: 'ex5' }), null);
  assert.equal(fromTcgdexPayload(snorunt, { ...identity, number: '73' }), null);
});

test('leading zeros and accents do not block a match', () => {
  const card = { ...snorunt, localId: '064', name: 'Snorunt' };
  assert.ok(fromTcgdexPayload(card, { ...identity, number: '64' }));
  const flabebe = { ...snorunt, name: 'Flabébé' };
  assert.ok(fromTcgdexPayload(flabebe, { ...identity, name: 'Flabebe' }));
});

test('no TCGPlayer prices means no grid', () => {
  assert.equal(fromTcgdexPayload({ ...snorunt, pricing: { cardmarket: { trend: 1 } } }, identity), null);
  assert.equal(fromTcgdexPayload(null, identity), null);
});

test('the TCGPlayer product id is read from the first printing that has one', () => {
  assert.equal(tcgPlayerIdFromTcgdex(snorunt), 89401);
  assert.equal(tcgPlayerIdFromTcgdex({ pricing: {} }), null);
});

test('a Price Tracker lookup asks for one card by tcgPlayerId', () => {
  const url = new URL(pptCardUrl(42382));
  assert.equal(url.origin + url.pathname, 'https://www.pokemonpricetracker.com/api/v2/cards');
  assert.equal(url.searchParams.get('tcgPlayerId'), '42382');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(url.searchParams.has('tcgPlayerIds'), false);
});

// GET /api/v2/cards?tcgPlayerId=42382&limit=1 on 2026-10-18 (free tier), trimmed.
const charizard = {
  tcgPlayerId: '42382',
  name: 'Charizard',
  setName: 'Base Set',
  cardNumber: '004/102',
  prices: {
    market: 954.65,
    primaryPrinting: 'Holofoil',
    variants: { Holofoil: { 'Near Mint Holofoil': { price: 954.65, priceString: '$954.65' } } },
  },
  variants: { Holofoil: { printing: 'Holofoil', marketPrice: 954.65, lowPrice: 229, conditionUsed: 'Near Mint Holofoil' } },
};

test('a Price Tracker card becomes a grid keyed by printing and condition', () => {
  const grid = normalizePpt(charizard);
  assert.equal(grid.source, 'ppt');
  assert.deepEqual(grid.variants, {
    Holofoil: { conditions: { NM: 954.65, LP: null, MP: null, HP: null, DMG: null }, market: 954.65 },
  });
  assert.equal(grid.defaultVariant, 'Holofoil');
});

test('every condition the Price Tracker lists is kept', () => {
  const card = {
    ...charizard,
    prices: {
      variants: {
        Holofoil: {
          'Near Mint Holofoil': { price: 950 },
          'Lightly Played Holofoil': { price: 700 },
          'Damaged Holofoil': { price: 120 },
        },
      },
    },
  };
  assert.deepEqual(normalizePpt(card).variants.Holofoil.conditions, { NM: 950, LP: 700, MP: null, HP: null, DMG: 120 });
});

test('a printing priced only by marketPrice uses the condition it names', () => {
  const card = { prices: {}, variants: { Normal: { marketPrice: 3.5, conditionUsed: 'Lightly Played Normal' } } };
  assert.deepEqual(normalizePpt(card).variants.Normal, {
    conditions: { NM: null, LP: 3.5, MP: null, HP: null, DMG: null },
    market: 3.5,
  });
});

test('a Price Tracker card with no prices gives no grid', () => {
  assert.equal(normalizePpt({ prices: {}, variants: {} }), null);
  assert.equal(normalizePpt({ prices: { variants: { Holofoil: {} } } }), null);
});
