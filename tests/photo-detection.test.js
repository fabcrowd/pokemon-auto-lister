import assert from 'node:assert/strict';
import test from 'node:test';
import { filterPhotoDetections } from '../tools/extension-wasm/photo-detection.js';

test('does not invent card boxes when photo detection returns none', () => {
  assert.deepEqual(filterPhotoDetections([], 1260, 675), []);
});

test('rejects a high-confidence full-image box around a binder photo', () => {
  const detections = [{ box: [1, 0, 541, 720], score: 0.932 }];
  assert.deepEqual(filterPhotoDetections(detections, 540, 720), []);
});

test('keeps plausible card-sized detections from a multi-card photo', () => {
  const boxes = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const left = 18 + col * 174;
      const top = 24 + row * 230;
      boxes.push({ box: [left, top, left + 160, top + 220], score: 0.72 });
    }
  }
  assert.equal(filterPhotoDetections(boxes, 540, 720).length, 9);
});

test('keeps one credible card detection without splitting the whole photo', () => {
  const detections = [{ box: [120, 40, 420, 460], score: 0.7 }];
  assert.deepEqual(filterPhotoDetections(detections, 540, 720), detections);
});
