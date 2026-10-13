import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ageLabel,
  detectedVariant,
  isPrintingConfirmed,
  lotTotal,
  printingNote,
  quotedPrice,
  sourceFooter,
  sourceName,
  modelFileLabel,
  explainScanError,
  isSetConfirmed,
} from '../tools/extension-wasm/lib/card-display.js';

const charizard = {
  market_price: 928,
  price_grid: {
    source: 'pokemontcg',
    updatedAt: '2026-09-01T00:00:00.000Z',
    defaultVariant: 'holofoil',
    spreadRatio: 40,
    variants: {
      holofoil: { market: 928, conditions: { NM: 928, LP: null, MP: null, HP: null, DMG: null } },
      unlimitedHolofoil: { market: 4500, conditions: { NM: 4500, LP: null, MP: null, HP: null, DMG: null } },
      '1stEditionHolofoil': { market: 38000, conditions: { NM: 38000, LP: null, MP: null, HP: null, DMG: null } },
    },
  },
};

test('one printing is quoted and counted', () => {
  const card = {
    market_price: 4.5,
    price_grid: {
      source: 'pokemontcg',
      variants: { normal: { market: 4.5, conditions: { NM: 4.5, LP: null, MP: null, HP: null, DMG: null } } },
    },
  };
  assert.equal(isPrintingConfirmed(card.price_grid, null), true);
  assert.equal(printingNote(card.price_grid), null);
  assert.equal(quotedPrice(card, null).price, 4.5);
  assert.equal(lotTotal([card], () => null).total, 4.5);
  assert.equal(lotTotal([card], () => null).unconfirmed, 0);
});

test('several printings are not quoted until the user picks one', () => {
  assert.equal(isPrintingConfirmed(charizard.price_grid, null), false);
  assert.equal(quotedPrice(charizard, null), null);
  assert.match(printingNote(charizard.price_grid), /3 variants/);
  assert.match(printingNote(charizard.price_grid), /\$928\.00/);
  assert.match(printingNote(charizard.price_grid), /\$38,?000\.00|\$38000\.00/);
  const lot = lotTotal([charizard], () => null);
  assert.equal(lot.total, 0);
  assert.equal(lot.unconfirmed, 1);
});

test('a chosen printing is the only price that counts', () => {
  const quote = quotedPrice(charizard, '1stEditionHolofoil');
  assert.equal(quote.price, 38000);
  assert.equal(quote.printing, '1stEditionHolofoil');
  assert.equal(lotTotal([charizard], () => '1stEditionHolofoil').total, 38000);
  assert.equal(lotTotal([charizard], () => '1stEditionHolofoil').unconfirmed, 0);
});

test('a card with the 1st Edition stamp starts on its 1st Edition price', () => {
  assert.equal(detectedVariant({ ...charizard, firstEdition: true }), '1stEditionHolofoil');
  const jungle = { firstEdition: true, price_grid: { variants: { unlimited: {}, '1stEditionNormal': {} } } };
  assert.equal(detectedVariant(jungle), '1stEditionNormal');
});

test('no stamp, or no 1st Edition price, leaves the variant to the user', () => {
  assert.equal(detectedVariant({ ...charizard, firstEdition: false }), null);
  assert.equal(detectedVariant(charizard), null);
  assert.equal(detectedVariant({ firstEdition: true, price_grid: { variants: { holofoil: {} } } }), null);
  assert.equal(detectedVariant({ firstEdition: true, price_grid: null }), null);
});

test('a legacy price with no printing map still counts', () => {
  const card = { market_price: 12, price_grid: null };
  assert.equal(quotedPrice(card, null).price, 12);
  assert.equal(lotTotal([card], () => null).total, 12);
});

test('a card whose set is not chosen is not quoted or counted', () => {
  const unsure = {
    market_price: null,
    price_grid: null,
    identity: { name: 'Boost Energy' },
    setChoices: [{ id: 'ex8-93' }, { id: 'ex15-87' }],
  };
  assert.equal(isSetConfirmed(unsure), false);
  assert.equal(quotedPrice(unsure, null), null);
  const lot = lotTotal([unsure], () => null);
  assert.equal(lot.total, 0);
  assert.equal(lot.unconfirmed, 1);

  const picked = { ...unsure, setConfirmed: true, market_price: 8.85 };
  assert.equal(isSetConfirmed(picked), true);
  assert.equal(lotTotal([picked], () => null).total, 8.85);
});

test('the lot total follows the enabled condition', () => {
  const card = {
    market_price: 400,
    price_grid: {
      variants: { normal: { conditions: { NM: 400, LP: 250, MP: null, HP: null, DMG: null } } },
    },
  };
  assert.equal(lotTotal([card], () => null, ['LP']).total, 250);
  assert.equal(lotTotal([card], () => null, ['HP']).total, 0);
});

test('a card with one possible set needs no set choice', () => {
  assert.equal(isSetConfirmed({ setChoices: [{ id: 'ex13-54' }] }), true);
  assert.equal(isSetConfirmed({}), true);
});

test('source footer names the source and flags a price older than 7 days', () => {
  const now = Date.parse('2026-10-11T00:00:00.000Z');
  assert.equal(sourceFooter(charizard.price_grid, now), 'TCGPlayer · updated 40d ago');
  assert.equal(ageLabel(charizard.price_grid.updatedAt, now).stale, true);
  assert.equal(sourceFooter({ source: 'backend' }, now), 'JustTCG');
  assert.equal(sourceName({ source: 'ppt' }), 'Price Tracker');
  assert.equal(sourceName(charizard.price_grid), 'TCGPlayer');
  assert.equal(ageLabel('not-a-date', now), null);
});

test('model download rows use plain names', () => {
  assert.equal(modelFileLabel('clip_visual_int8.onnx'), 'card recognition');
  assert.equal(modelFileLabel('card_detect.onnx'), 'card finder');
  assert.equal(modelFileLabel('catalog.bin.gz'), 'card catalog');
  assert.equal(modelFileLabel('something-else.bin'), 'model file');
});

test('scan failures are explained without service-worker jargon', () => {
  assert.match(explainScanError('Could not establish connection. Receiving end does not exist.'), /Reload the Card Scanner extension/);
  assert.match(explainScanError('Models not loaded'), /downloading/);
  assert.equal(explainScanError('No scannable tab — open a webpage first'), 'No scannable tab — open a webpage first');
});
