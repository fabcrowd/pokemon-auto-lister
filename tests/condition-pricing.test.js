import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fromTcgdexPayload, tcgPlayerIdFromTcgdex } from '../tools/extension-wasm/lib/condition-pricing.js';

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
