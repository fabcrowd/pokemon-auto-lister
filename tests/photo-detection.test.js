import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extendClippedBottom,
  filterPhotoDetections,
  imageToViewportTransform,
  isCardShaped,
  mapPhotoBoxToViewport,
  planHeroCard,
} from '../tools/extension-wasm/photo-detection.js';

function painted(width, height, paint) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(180);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  paint(pixels, width);
  return pixels;
}

function fillRow(pixels, width, y, r, g, b) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
  }
}

test('a box that stops in the yellow border grows through that border only', () => {
  const width = 40;
  const height = 250;
  const pixels = painted(width, height, (data) => {
    for (let y = 199; y <= 206; y++) fillRow(data, width, y, 224, 194, 64);
    for (let y = 207; y <= 209; y++) fillRow(data, width, y, 230, 232, 236);
  });
  const grown = extendClippedBottom(pixels, width, height, [4, 20, 36, 200]);
  assert.deepEqual(grown, [4, 20, 36, 210]);
  assert.deepEqual(extendClippedBottom(pixels, width, height, [4, 20, 36, 230]), [4, 20, 36, 230]);
});

test('a white table past the card edge does not keep the box growing', () => {
  const width = 40;
  const height = 120;
  const pixels = painted(width, height, (data) => {
    fillRow(data, width, 49, 224, 194, 64);
    for (let y = 50; y < height; y++) fillRow(data, width, y, 240, 240, 240);
  });
  const grown = extendClippedBottom(pixels, width, height, [4, 10, 36, 50]);
  assert.ok(grown[3] < 60);
  assert.ok(grown[3] > 50);
});

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

test('isCardShaped is one window from upright through tilted to sideways', () => {
  for (const ratio of [0.55, 0.72, 0.95, 1.0, 1.4, 1.82]) assert.equal(isCardShaped(ratio), true, String(ratio));
  for (const ratio of [0.5, 1.83, 2, 3]) assert.equal(isCardShaped(ratio), false, String(ratio));
});

test('keeps a tilted (1.0) and a sideways (1.4) card, rejects a 2:1 strip', () => {
  const sideways = { box: [100, 100, 380, 300], score: 0.8 }; // 1.4
  const tilted = { box: [500, 100, 700, 300], score: 0.8 }; // 1.0
  const strip = { box: [10, 10, 410, 210], score: 0.8 }; // 2.0
  assert.deepEqual(filterPhotoDetections([sideways, tilted, strip], 1000, 800), [sideways, tilted]);
});

test('the area rule still drops a wide box that fills the photo', () => {
  assert.deepEqual(filterPhotoDetections([{ box: [0, 0, 700, 500], score: 0.9 }], 800, 600), []);
});

test('a sideways large box is a hero card; whole-image ratio branches are unchanged', () => {
  const plan = planHeroCard({ imageW: 800, imageH: 600, detections: [{ box: [0, 0, 700, 500], score: 0.9 }] });
  assert.equal(plan.kind, 'large-box');
  assert.equal(planHeroCard({ imageW: 800, imageH: 600, detections: [] }).kind, 'none');
});
