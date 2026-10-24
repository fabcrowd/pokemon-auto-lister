import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chosenPrintingHasNoPrice, lotEstimate } from '../tools/extension-wasm/lib/card-display.js';
import { LOT_COLUMNS, lotExportRows } from '../tools/extension-wasm/lib/lot-export.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const col = (name) => LOT_COLUMNS.indexOf(name);

// Two printings: normal has an NM price only, holofoil has NM and LP.
const card = () => ({
  identity: { id: 'a-1', name: 'Pikachu', set: 'Base', number: '58' },
  confidence: 0.9,
  setChoices: [],
  price_grid: {
    source: 'ppt',
    variants: {
      normal: { conditions: { NM: 1, LP: null }, market: 1 },
      holofoil: { conditions: { NM: 50, LP: 40 }, market: 50 },
    },
  },
});

test('a chosen printing with no price at the active condition is not priced from another printing', () => {
  const c = card();
  const lot = lotEstimate([c], () => 'normal', ['LP'], NOW);
  assert.equal(lot.low, 0);
  assert.equal(lot.high, 0);
  assert.equal(lot.noPrice, 1);
  assert.equal(chosenPrintingHasNoPrice(c, 'normal', ['LP']), true);
});

test('the export carries no price for that card either', () => {
  const out = lotExportRows([card()], () => 'normal', ['LP'], NOW);
  const row = out.rows[0];
  assert.equal(row[col('Price')], '');
  assert.equal(row[col('Low')], '');
  assert.equal(row[col('High')], '');
  assert.equal(row[col('Printing')], 'Normal');
});

test('an open printing is still a range, and a priced chosen printing is still a quote', () => {
  const c = card();
  const open = lotEstimate([c], () => null, ['NM'], NOW);
  assert.equal(open.low, 1);
  assert.equal(open.high, 50);
  assert.equal(chosenPrintingHasNoPrice(c, null, ['NM']), false);
  const chosen = lotEstimate([c], () => 'holofoil', ['LP'], NOW);
  assert.equal(chosen.high, 40);
  assert.equal(chosen.noPrice, 0);
  assert.equal(chosenPrintingHasNoPrice(c, 'holofoil', ['LP']), false);
});

import { quotedPrice } from '../tools/extension-wasm/lib/card-display.js';

test('a $0, negative or NaN quote is no price', () => {
  const one = (nm) => ({ identity: { id: 'z', name: 'Z' }, confidence: 0.9, setChoices: [], price_grid: { variants: { normal: { conditions: { NM: nm }, market: nm } } } });
  assert.equal(quotedPrice(one(0), null, ['NM']), null);
  assert.equal(quotedPrice(one(-3), null, ['NM']), null);
  assert.equal(quotedPrice(one(NaN), null, ['NM']), null);
  assert.equal(quotedPrice(one(2.5), null, ['NM']).price, 2.5);
  const lot = lotEstimate([one(0)], () => null, ['NM'], NOW);
  assert.equal(lot.high, 0);
  assert.equal(lot.noPrice, 1);
  const legacy = { identity: { id: 'z', name: 'Z' }, confidence: 0.9, setChoices: [], market_price: 0 };
  assert.equal(quotedPrice(legacy, null, ['NM']), null);
});

test('a zero condition falls through to the next enabled condition', () => {
  const c = { identity: { id: 'z', name: 'Z' }, confidence: 0.9, setChoices: [], price_grid: { variants: { normal: { conditions: { NM: 0, LP: 1.5 }, market: 1.5 } } } };
  assert.deepEqual(quotedPrice(c, null, ['NM', 'LP']), { price: 1.5, condition: 'LP', printing: 'normal' });
});
