import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SHADOW_MIN_DEPTH, borderEdition, shadowDepth } from '../tools/extension-wasm/lib/frame-shadow.js';

const W = 375;
const H = 525;

function card() {
  return new Float32Array(W * H).fill(150);
}

function band(gray, x1, x2, y1, y2, value) {
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) gray[y * W + x] = value;
  }
}

test('a dark band between the gold frame and the yellow border is a drop shadow', () => {
  const gray = card();
  band(gray, 280, 310, 100, 200, 210);
  band(gray, 310, 328, 100, 200, 30);
  band(gray, 328, 365, 100, 200, 180);
  assert.ok(shadowDepth(gray, W, H) >= SHADOW_MIN_DEPTH);
});

test('gold straight against yellow is not a drop shadow', () => {
  const gray = card();
  band(gray, 280, 328, 100, 200, 210);
  band(gray, 328, 365, 100, 200, 180);
  assert.ok(shadowDepth(gray, W, H) < SHADOW_MIN_DEPTH);
});

test('a stable frame with no dark gap is Shadowless', () => {
  const gray = card();
  band(gray, 250, 320, 80, 220, 200);
  band(gray, 320, 370, 80, 220, 190);
  assert.equal(borderEdition(gray, W, H), 'shadowless');
});

test('a stable dark gap outside the frame is Unlimited', () => {
  const gray = card();
  band(gray, 250, 300, 80, 220, 200);
  band(gray, 300, 310, 80, 220, 40);
  band(gray, 310, 370, 80, 220, 190);
  assert.equal(borderEdition(gray, W, H), 'unlimited');
});

test('a frame edge that jumps between rows is left unset', () => {
  const gray = card();
  band(gray, 200, 250, 90, 125, 165);
  band(gray, 250, 370, 90, 125, 190);
  band(gray, 200, 340, 170, 210, 165);
  band(gray, 340, 370, 170, 210, 190);
  assert.equal(borderEdition(gray, W, H), null);
});

test('dark artwork does not count as the frame shadow', () => {
  const gray = card();
  band(gray, 0, 310, 100, 200, 25);
  band(gray, 310, 328, 100, 200, 210);
  band(gray, 328, 365, 100, 200, 180);
  assert.ok(shadowDepth(gray, W, H) < SHADOW_MIN_DEPTH);
});
