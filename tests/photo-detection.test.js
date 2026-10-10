import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterPhotoDetections,
  imageToViewportTransform,
  mapPhotoBoxToViewport,
} from '../tools/extension-wasm/photo-detection.js';

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

test('maps boxes from a portrait source image displayed with contain letterboxing', () => {
  const transform = imageToViewportTransform(
    { x: 100, y: 80, w: 840, h: 450 },
    540,
    720,
    { fit: 'contain', position: '50% 50%' },
  );

  assert.deepEqual(transform, { left: 351.25, top: 80, scaleX: 0.625, scaleY: 0.625 });
  assert.deepEqual(mapPhotoBoxToViewport([0, 0, 540, 720], transform), [351.25, 80, 688.75, 530]);
});

test('maps boxes from a source image cropped with cover and right-bottom positioning', () => {
  const transform = imageToViewportTransform(
    { x: 20, y: 40, w: 400, h: 300 },
    800,
    400,
    { fit: 'cover', position: 'right bottom' },
  );

  assert.deepEqual(transform, { left: -180, top: 40, scaleX: 0.75, scaleY: 0.75 });
});

test('maps CSS background cover and one-value vertical positioning', () => {
  const transform = imageToViewportTransform(
    { x: 10, y: 20, w: 400, h: 300 },
    800,
    400,
    { fit: 'background', size: 'cover', position: 'top' },
  );

  assert.deepEqual(transform, { left: -90, top: 20, scaleX: 0.75, scaleY: 0.75 });
});

test('declines source mapping for unsupported CSS background sizes', () => {
  assert.equal(imageToViewportTransform(
    { x: 0, y: 0, w: 400, h: 300 }, 800, 400,
    { fit: 'background', size: 'calc(100% - 10px)', position: 'center' },
  ), null);
});
