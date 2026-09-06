import { test } from 'node:test';
import assert from 'node:assert/strict';

import { comparePhotoPaths, extractImgNumber, scoreRawRgb } from '../src/photos/shotKind.js';

test('extractImgNumber reads IMG_#### and ignores (1) suffix', () => {
  assert.equal(extractImgNumber('C:/x/IMG_3287.JPG'), 3287);
  assert.equal(extractImgNumber('IMG_3292(1).JPG'), 3292);
  assert.equal(extractImgNumber('front.jpg'), null);
});

test('comparePhotoPaths sorts by IMG number before name/mtime', () => {
  const paths = ['z.jpg', 'IMG_2.jpg', 'IMG_10.jpg', 'IMG_3.jpg'];
  const sorted = [...paths].sort((a, b) => comparePhotoPaths(a, b, { mtimeA: 9, mtimeB: 1 }));
  assert.deepEqual(sorted, ['IMG_2.jpg', 'IMG_3.jpg', 'IMG_10.jpg', 'z.jpg']);
});

test('scoreRawRgb labels a blue-heavy inset card as full_back', () => {
  const w = 40;
  const h = 56;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      const border = x < 4 || y < 4 || x >= w - 4 || y >= h - 4;
      if (border) {
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      } else {
        data[i] = 40;
        data[i + 1] = 70;
        data[i + 2] = 160;
      }
    }
  }
  const scores = scoreRawRgb(data, w, h, 3);
  assert.equal(scores.kind, 'full_back');
  assert.ok(scores.blueFrac > 0.12);
});

test('scoreRawRgb labels a corner-like fill as closeup with low score', () => {
  const w = 40;
  const h = 56;
  const data = Buffer.alloc(w * h * 3, 180);
  // Only paint a bright corner blotch with weak vertical edges.
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 18; x += 1) {
      const i = (y * w + x) * 3;
      data[i] = 200;
      data[i + 1] = 160;
      data[i + 2] = 120;
    }
  }
  const scores = scoreRawRgb(data, w, h, 3);
  assert.equal(scores.kind, 'closeup');
  assert.ok(scores.score < 0.55);
});
