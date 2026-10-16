import { test } from 'node:test';
import assert from 'node:assert/strict';

import { artSourceRect, EMBEDDING_VERSION } from '../tools/extension-wasm/lib/embed.js';

// tools/vellum-ai/catalog/embed_all.py crops the top int(h*0.45) rows, then open_clip
// resizes the short side to 224 and center-crops. That is a centred square of the strip.

test('a portrait card gives a square as tall as the art strip, centred across the width', () => {
  // 600x838 card: strip is 600x377, short side is the height.
  const r = artSourceRect(600, 838);
  assert.deepEqual(r, { sx: (600 - 377) / 2, sy: 0, side: 377 });
});

test('the strip height is floored like int(h * 0.45) in embed_all.py', () => {
  assert.equal(artSourceRect(300, 419).side, Math.floor(419 * 0.45));
});

test('a strip narrower than tall is cropped to a centred square of the full width', () => {
  // 100x400: strip is 100x180, short side is the width.
  assert.deepEqual(artSourceRect(100, 400), { sx: 0, sy: 40, side: 100 });
});

test('the square never leaves the card', () => {
  for (const [w, h] of [[1, 1], [16, 16], [223, 311], [1000, 10], [733, 1024]]) {
    const { sx, sy, side } = artSourceRect(w, h);
    assert.ok(side >= 1 && sx >= 0 && sy >= 0 && sx + side <= w && sy + side <= Math.max(1, Math.floor(h * 0.45)));
  }
});

test('the embedding version is a positive integer that older rows can be compared to', () => {
  assert.ok(Number.isInteger(EMBEDDING_VERSION) && EMBEDDING_VERSION >= 2);
});
