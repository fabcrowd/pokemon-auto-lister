import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIRST_EDITION_MIN_SCORE, editionAfterEreader, editionAfterPromo, editionAfterStamp, editionForSets, pricedEdition, stampAfterFirst, grayFromRgba, stampScore, hasFirstEdition,
} from '../tools/extension-wasm/lib/edition-stamp.js';
import { STAMP_WIDTH, STAMP_HEIGHT, STAMP_PIXELS } from '../tools/extension-wasm/lib/first-edition-stamp.js';

const CARD_W = 375;
const CARD_H = 525;
const stamp = Uint8Array.from(Buffer.from(STAMP_PIXELS, 'base64'));

function noisyCard(seed = 1, base = 170, width = CARD_W, height = CARD_H) {
  const card = new Float32Array(width * height);
  let s = seed;
  for (let i = 0; i < card.length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    card[i] = base + (s / 2147483648) * 30 - 15;
  }
  return card;
}

function paste(card, x0, y0, scale = 1, gain = 1, offset = 0, rowLength = CARD_W) {
  const w = Math.round(STAMP_WIDTH * scale);
  const h = Math.round(STAMP_HEIGHT * scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(STAMP_WIDTH - 1, Math.floor(x / scale));
      const sy = Math.min(STAMP_HEIGHT - 1, Math.floor(y / scale));
      card[(y0 + y) * rowLength + x0 + x] = stamp[sy * STAMP_WIDTH + sx] * gain + offset;
    }
  }
  return card;
}

test('the template is the 1st Edition stamp image', () => {
  assert.equal(stamp.length, STAMP_WIDTH * STAMP_HEIGHT);
});

test('a stamp below the lower-left corner of the art is found', () => {
  // At this card width one search size is exactly the template's 44 px.
  const width = 688;
  const height = 963;
  const card = paste(noisyCard(1, 170, width, height), 80, 440, 1, 1, 0, width);
  assert.ok(stampScore(card, width, height) >= 0.95);
});

test('a Gym trainer stamp under the text box is found when the lower area is searched', () => {
  const width = 688;
  const height = 963;
  const card = paste(noisyCard(8, 170, width, height), 40, 640, 1, 1, 0, width);
  assert.ok(stampScore(card, width, height, undefined, true) >= 0.95);
});

test('the text box is not searched for a stamp unless asked', () => {
  const width = 688;
  const height = 963;
  const card = paste(noisyCard(8, 170, width, height), 40, 640, 1, 1, 0, width);
  assert.ok(stampScore(card, width, height) < FIRST_EDITION_MIN_SCORE);
});

test('the stamp is found at another size and under dimmer light', () => {
  const card = paste(noisyCard(2), 20, 220, 0.85, 0.6, 40);
  assert.ok(stampScore(card, CARD_W, CARD_H) >= 0.85);
});

test('a card with no stamp scores well under the threshold', () => {
  assert.ok(stampScore(noisyCard(3), CARD_W, CARD_H) < FIRST_EDITION_MIN_SCORE - 0.2);
});

test('a stamp-like mark outside the stamp area is ignored', () => {
  const card = paste(noisyCard(4), 300, 40, 0.6);
  assert.ok(stampScore(card, CARD_W, CARD_H) < FIRST_EDITION_MIN_SCORE);
});

test('a flat area does not divide by zero', () => {
  const flat = new Float32Array(CARD_W * CARD_H).fill(128);
  assert.equal(stampScore(flat, CARD_W, CARD_H), 0);
});

test('canvas pixels become luma', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 10, 10, 255]);
  const gray = grayFromRgba(rgba, 4, 1);
  assert.deepEqual(Array.from(gray, (v) => Math.round(v)), [76, 150, 29, 10]);
});

test('a stamp match is 1st Edition even when the model said otherwise', () => {
  assert.equal(editionAfterStamp('standard', FIRST_EDITION_MIN_SCORE), 'first');
  assert.equal(editionAfterStamp('shadowless', 0.9), 'first');
  assert.equal(editionAfterStamp(null, 0.9), 'first');
});

test('an e-Reader id line is not a 1st Edition card', () => {
  assert.equal(editionAfterEreader('first', 'ID:Z-06-#'), 'standard');
  assert.equal(editionAfterEreader('first', 'ID:B-81-#'), 'standard');
  assert.equal(editionAfterEreader('first', 'Veight.9Ibs.1D:B-85'), 'standard');
  assert.equal(editionAfterEreader('first', 'Weight: 19 lbs.'), 'first');
  assert.equal(editionAfterEreader('first', 'llus.Mitsuhiro Arita'), 'first');
  assert.equal(editionAfterEreader('shadowless', 'ID:Z-07-#'), 'shadowless');
});

test('a set that was never printed in 1st Edition drops that call', () => {
  assert.equal(editionAfterPromo('first', true), 'standard');
  assert.equal(editionAfterPromo('first', false), 'first');
  assert.equal(editionAfterPromo('shadowless', true), 'shadowless');
  assert.equal(editionForSets('first', ['basep']), 'standard');
  assert.equal(editionForSets('first', ['base4']), 'standard');
  assert.equal(editionForSets('first', ['basep', 'base2']), 'first');
  assert.equal(editionForSets('first', ['base2']), 'first');
  assert.equal(editionForSets('first', []), 'first');
  assert.equal(editionForSets('standard', ['basep']), 'standard');
  assert.equal(editionForSets(null, ['basep']), null);
});

test('a 1st Edition stamp match is not also a set stamp', () => {
  assert.equal(stampAfterFirst('setstamp', true), 'none');
  assert.equal(stampAfterFirst('setstamp', false), 'setstamp');
  assert.equal(stampAfterFirst('prerelease', true), 'prerelease');
  assert.equal(stampAfterFirst('none', true), 'none');
  assert.equal(stampAfterFirst(null, true), 'none');
});

test('a model 1st Edition call is not priced unless the stamp matches', () => {
  assert.equal(pricedEdition('first', FIRST_EDITION_MIN_SCORE), 'first');
  assert.equal(pricedEdition('first', 0.527), 'standard');
  assert.equal(pricedEdition('standard', 0.9), 'first');
  assert.equal(pricedEdition('shadowless', 0.4), 'shadowless');
  assert.equal(pricedEdition(null, 0.4), null);
});

test('a missed stamp keeps the model edition', () => {
  assert.equal(editionAfterStamp('first', FIRST_EDITION_MIN_SCORE - 0.01), 'first');
  assert.equal(editionAfterStamp('standard', 0.6), 'standard');
  assert.equal(editionAfterStamp(null, 0.6), null);
});

test('only WotC sets that were printed in 1st Edition are checked', () => {
  for (const code of ['base1', 'base2', 'base3', 'base5', 'gym1', 'gym2', 'neo1', 'neo4']) {
    assert.equal(hasFirstEdition(code), true, code);
  }
  for (const code of ['base4', 'si1', 'basep', 'ecard1', 'sv1', '', undefined]) {
    assert.equal(hasFirstEdition(code), false, String(code));
  }
});