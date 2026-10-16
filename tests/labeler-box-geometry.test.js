import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_BOX_PX, boxFromCorners, defaultBox, keyStep, moveBox, resizeBox } from '../tools/labeler/box-geometry.js';

const W = 1000;
const H = 800;

test('defaultBox is centered and inside the photo', () => {
  const [x1, y1, x2, y2] = defaultBox(W, H);
  assert.ok(x1 > 0 && y1 > 0 && x2 < W && y2 < H);
  assert.ok(Math.abs((x1 + x2) / 2 - W / 2) <= 1);
  assert.ok(Math.abs((y1 + y2) / 2 - H / 2) <= 1);
  assert.ok(x2 - x1 >= MIN_BOX_PX && y2 - y1 >= MIN_BOX_PX);
});

test('moveBox translates and keeps the size', () => {
  assert.deepEqual(moveBox([100, 100, 300, 400], 10, -20, W, H), [110, 80, 310, 380]);
});

test('moveBox stops at every edge without shrinking the box', () => {
  assert.deepEqual(moveBox([5, 5, 105, 205], -50, -50, W, H), [0, 0, 100, 200]);
  assert.deepEqual(moveBox([900, 600, 995, 795], 50, 50, W, H), [905, 605, 1000, 800]);
});

test('resizeBox changes width and height from the top-left anchor', () => {
  assert.deepEqual(resizeBox([100, 100, 300, 400], 20, -30, W, H), [100, 100, 320, 370]);
});

test('resizeBox cannot grow past the photo or shrink below the minimum', () => {
  assert.deepEqual(resizeBox([100, 100, 990, 790], 50, 50, W, H), [100, 100, 1000, 800]);
  const [x1, y1, x2, y2] = resizeBox([100, 100, 120, 120], -50, -50, W, H);
  assert.equal(x2 - x1, MIN_BOX_PX);
  assert.equal(y2 - y1, MIN_BOX_PX);
  assert.equal(x1, 100);
  assert.equal(y1, 100);
});

test('boxFromCorners orders the corners in either click order', () => {
  assert.deepEqual(boxFromCorners({ x: 400, y: 500 }, { x: 100, y: 200 }, W, H), [100, 200, 400, 500]);
  assert.deepEqual(boxFromCorners({ x: 100, y: 500 }, { x: 400, y: 200 }, W, H), [100, 200, 400, 500]);
});

test('boxFromCorners clamps corners that fall outside the photo', () => {
  assert.deepEqual(boxFromCorners({ x: -20, y: 10 }, { x: 1200, y: 900 }, W, H), [0, 10, 1000, 800]);
});

test('boxFromCorners rounds to whole photo pixels', () => {
  assert.deepEqual(boxFromCorners({ x: 10.4, y: 10.6 }, { x: 99.5, y: 99.4 }, W, H), [10, 11, 100, 99]);
});

test('keyStep scales with the photo and is at least one pixel', () => {
  assert.equal(keyStep(1000, 800), 10);
  assert.equal(keyStep(50, 40), 1);
});
