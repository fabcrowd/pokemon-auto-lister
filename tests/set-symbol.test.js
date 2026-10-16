import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SYMBOL_PIXELS, SYMBOL_SIZE } from '../tools/extension-wasm/lib/set-symbol-templates.js';
import { PROMO_STAR_MIN, SYMBOL_MIN, SYMBOL_SET, choicesForSymbol, promoStarScore, symbolFromScores, symbolScores } from '../tools/extension-wasm/lib/set-symbol.js';

test('the templates are the train-photo symbols', () => {
  for (const name of Object.keys(SYMBOL_SIZE)) {
    const [width, height] = SYMBOL_SIZE[name];
    const pixels = Uint8Array.from(Buffer.from(SYMBOL_PIXELS[name], 'base64'));
    assert.equal(pixels.length, width * height);
  }
});

test('the winning template has to clear its own bar', () => {
  assert.equal(symbolFromScores({ jungle: 0.71, fossil: 0.2, rocket: 0.1 }), 'jungle');
  assert.equal(symbolFromScores({ jungle: 0.6, fossil: 0.64, rocket: 0.1 }), null);
  assert.equal(symbolFromScores({ jungle: 0.2, fossil: 0.65, rocket: 0.1 }), 'fossil');
  assert.equal(symbolFromScores({ jungle: 0.2, fossil: 0.64, rocket: 0.1 }), null);
  assert.equal(symbolFromScores({ jungle: 0.6, fossil: 0.4, rocket: 0.9 }), 'rocket');
  assert.equal(symbolFromScores({ jungle: SYMBOL_MIN.jungle - 0.01, fossil: 0, rocket: 0 }), null);
});

test('a pasted Jungle flower is Jungle and a blank card is not', () => {
  const width = 750;
  const height = 1050;
  const gray = new Float32Array(width * height);
  gray.fill(180);
  const [tw, th] = SYMBOL_SIZE.jungle;
  const pixels = Uint8Array.from(Buffer.from(SYMBOL_PIXELS.jungle, 'base64'));
  const x0 = Math.round(0.7 * width) + 20;
  const y0 = Math.round(0.44 * height) + 20;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) gray[(y0 + y) * width + x0 + x] = pixels[y * tw + x];
  }
  const found = symbolScores(gray, width, height);
  assert.equal(symbolFromScores(found), 'jungle');
  assert.ok(found.jungle >= SYMBOL_MIN.jungle);

  const blank = symbolScores(new Float32Array(width * height).fill(180), width, height);
  assert.equal(symbolFromScores(blank), null);
});

test('a pasted promo star clears the bar and a blank card does not', () => {
  const width = 750;
  const height = 1050;
  const gray = new Float32Array(width * height);
  gray.fill(180);
  const [tw, th] = SYMBOL_SIZE.promo;
  const pixels = Uint8Array.from(Buffer.from(SYMBOL_PIXELS.promo, 'base64'));
  assert.equal(pixels.length, tw * th);
  const x0 = Math.round(0.7 * width);
  const y0 = Math.round(0.45 * height);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) gray[(y0 + y) * width + x0 + x] = pixels[y * tw + x];
  }
  assert.ok(promoStarScore(gray, width, height) >= PROMO_STAR_MIN);
  assert.ok(promoStarScore(new Float32Array(width * height).fill(180), width, height) < PROMO_STAR_MIN);
});

test('each symbol names its expansion', () => {
  assert.deepEqual(SYMBOL_SET, { jungle: 'base2', fossil: 'base3', rocket: 'base5' });
});

test('a symbol keeps only the choices from that set', () => {
  const choices = [
    { id: 'base1-4', setCode: 'base1' },
    { id: 'base2-11', setCode: 'base2' },
    { id: 'base3-15', setCode: 'base3' },
  ];
  assert.deepEqual(choicesForSymbol(choices, 'jungle'), [{ id: 'base2-11', setCode: 'base2' }]);
  assert.deepEqual(choicesForSymbol(choices, 'fossil'), [{ id: 'base3-15', setCode: 'base3' }]);
  assert.equal(choicesForSymbol(choices, null), choices);
  assert.equal(choicesForSymbol(choices, 'rocket'), choices);
});
