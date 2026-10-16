import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { dhashFromGray, dhashImage, hamming, nearestWithin } from '../scripts/lib/dhash.mjs';

const gradient = (flip) => Uint8Array.from({ length: 72 }, (_, i) => {
  const col = i % 9;
  return flip ? 255 - col * 28 : col * 28;
});

test('dhashFromGray sets a bit where a pixel is brighter than its right neighbour', () => {
  assert.equal(dhashFromGray(gradient(false)), '0000000000000000');
  assert.equal(dhashFromGray(gradient(true)), 'ffffffffffffffff');
});

test('dhashFromGray rejects anything but a 9x8 grid', () => {
  assert.throws(() => dhashFromGray(new Uint8Array(10)), /72/);
});

test('hamming counts differing bits across the whole hash', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0);
  assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hamming('00000000000000f0', '000000000000000f'), 8);
  assert.throws(() => hamming('00', '0000'), /length/);
});

test('nearestWithin finds the closest hash inside the limit and reports its index', () => {
  const hashes = ['ffffffffffffffff', '0000000000000007', '0000000000000000'];
  assert.deepEqual(nearestWithin(hashes, '0000000000000001', 6), { index: 2, distance: 1 });
  assert.equal(nearestWithin(hashes, '0f0f0f0f0f0f0f0f', 6), null);
  assert.equal(nearestWithin([], '0000000000000000', 6), null);
});

async function jpeg(draw, size = 200) {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = draw(x, y);
      raw.set([v, v, v], (y * size + x) * 3);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

test('dhashImage survives rescaling and recompression but not a different picture', async () => {
  const stripes = await jpeg((x, y) => 128 + 100 * Math.sin(x / 17) * Math.cos(y / 23));
  const same = await sharp(stripes).resize(90, 90).jpeg({ quality: 50 }).toBuffer();
  const other = await jpeg((x, y) => 128 + 100 * Math.sin(y / 11 + x / 31));
  const a = await dhashImage(stripes);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(hamming(a, await dhashImage(same)) <= 6);
  assert.ok(hamming(a, await dhashImage(other)) > 6);
});

test('dhashImage can hash just a box of the picture', async () => {
  const half = await jpeg((x, y) => (x < 100 ? 128 + 100 * Math.sin(x / 9) * Math.cos(y / 13) : 128));
  const whole = await dhashImage(half);
  const left = await dhashImage(half, [0, 0, 100, 200]);
  assert.notEqual(whole, left);
  const leftOnly = await sharp(half).extract({ left: 0, top: 0, width: 100, height: 200 }).png().toBuffer();
  assert.equal(left, await dhashImage(leftOnly));
});

test('dhashImage can hash a turned copy of the picture', async () => {
  const raw = Buffer.alloc(20 * 30 * 3);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 20; x++) raw.set([x * 12, y * 8, (x * y) % 255], (y * 20 + x) * 3);
  const jpeg = await sharp(raw, { raw: { width: 20, height: 30, channels: 3 } }).png().toBuffer();
  const turned = await sharp(jpeg).rotate(90).png().toBuffer();
  assert.equal(await dhashImage(jpeg, null, 90), await dhashImage(turned));
  assert.notEqual(await dhashImage(jpeg, null, 90), await dhashImage(jpeg));
  assert.equal(await dhashImage(jpeg, [0, 0, 10, 30], 180), await dhashImage(await sharp(jpeg).extract({ left: 0, top: 0, width: 10, height: 30 }).rotate(180).png().toBuffer()));
});
