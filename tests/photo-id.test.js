import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dhashFromGray, grayGrid, photoIdFromRgba, splitOf } from '../tools/extension-wasm/lib/photo-id.js';
import { dhashFromGray as scriptDhash } from '../scripts/lib/dhash.mjs';

// A smooth picture with structure, drawn at any size.
function picture(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const value = 128 + 100 * Math.sin(u * 9 + 1) * Math.cos(v * 7 + 2) + 20 * Math.sin(u * 40);
      const at = (y * width + x) * 4;
      data[at] = value;
      data[at + 1] = value * 0.9;
      data[at + 2] = value * 0.8;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

test('the hash is the same dHash the scripts compute', () => {
  const gray = Uint8Array.from({ length: 72 }, (_, i) => (i * 37) % 251);
  assert.equal(dhashFromGray(gray), scriptDhash(gray));
  assert.throws(() => dhashFromGray(new Uint8Array(5)), /72/);
});

test('grayGrid reduces any size to 9 columns by 8 rows', () => {
  assert.equal(grayGrid(picture(90, 80)).length, 72);
  assert.equal(grayGrid(picture(1000, 700)).length, 72);
});

test('the same picture gets the same id at different sizes', () => {
  const small = photoIdFromRgba(picture(360, 280));
  const large = photoIdFromRgba(picture(1440, 1120));
  assert.match(small, /^[0-9a-f]{16}$/);
  assert.equal(small, large);
});

test('different pictures get different ids', () => {
  const mirrored = picture(360, 280);
  for (let y = 0; y < 280; y++) {
    for (let x = 0; x < 180; x++) {
      const a = (y * 360 + x) * 4;
      const b = (y * 360 + (359 - x)) * 4;
      for (let c = 0; c < 3; c++) [mirrored.data[a + c], mirrored.data[b + c]] = [mirrored.data[b + c], mirrored.data[a + c]];
    }
  }
  assert.notEqual(photoIdFromRgba(mirrored), photoIdFromRgba(picture(360, 280)));
});

test('a picture smaller than the grid is refused', () => {
  assert.throws(() => photoIdFromRgba(picture(4, 4)), /too small/);
});

test('split is the low 32 bits of the id mod 5: 0 is exam', () => {
  assert.equal(splitOf('0000000000000000'), 'exam');
  assert.equal(splitOf('0000000000000005'), 'exam');
  assert.equal(splitOf('0000000000000001'), 'teach');
  // The high 32 bits do not matter.
  assert.equal(splitOf('ffffffff00000000'), 'exam');
  assert.equal(splitOf('ffffffff00000001'), 'teach');
  // 0xffffffff = 4294967295 = 5 * 858993459
  assert.equal(splitOf('00000000ffffffff'), 'exam');
  assert.equal(splitOf('00000000fffffffe'), 'teach');
  assert.throws(() => splitOf('xyz'), /photoId/);
});

test('about one photo in five is exam', () => {
  let exam = 0;
  for (let i = 0; i < 2000; i++) if (splitOf((BigInt(i) * 2654435761n).toString(16).padStart(16, '0')) === 'exam') exam += 1;
  assert.ok(exam > 300 && exam < 500, String(exam));
});
