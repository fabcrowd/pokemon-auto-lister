import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CARD_BACK, CARD_BACK_BUILT_FOR, isCardBack } from '../tools/extension-wasm/lib/card-back.js';
import { modelTags } from '../tools/extension-wasm/lib/contribution.js';

test('the reference is a unit-length 512-d embedding', () => {
  assert.equal(CARD_BACK.length, 512);
  const norm = Math.hypot(...CARD_BACK);
  assert.ok(Math.abs(norm - 1) < 1e-3);
});

test('the reference was built for the pinned model and crop', () => {
  assert.deepEqual({ ...CARD_BACK_BUILT_FOR }, { clip: modelTags().clip, crop: modelTags().crop });
  assert.equal(CARD_BACK_BUILT_FOR.clip, '0dba1302580da2a6');
});

test('a card back that looks more like the back than any card is a back', () => {
  assert.equal(isCardBack(Float32Array.from(CARD_BACK), 0.81), true);
});

test('a card front that matches a catalog card better is not a back', () => {
  assert.equal(isCardBack(Float32Array.from(CARD_BACK), 1.01), false);
});

test('something unlike a card back is not a back', () => {
  const other = new Float32Array(512);
  other[0] = 1;
  assert.equal(isCardBack(other, 0.1), false);
});
