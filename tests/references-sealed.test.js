import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { dropNearSealed, sealedHashes } from '../scripts/lib/references-sealed.mjs';
import { dhashImage } from '../scripts/lib/dhash.mjs';

const scratch = path.resolve('.tmp', 'references-sealed-test');

async function picture(seed, size = 160) {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 128 + 100 * Math.sin(x / (7 + seed * 3) + seed) * Math.cos(y / (11 + seed * 5));
      raw.set([v, v, v], (y * size + x) * 3);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

const dataUrl = (jpeg) => `data:image/jpeg;base64,${jpeg.toString('base64')}`;

function fixtureDir(name) {
  const dir = path.join(scratch, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
  return dir;
}

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('sealedHashes hashes each photo and each of its boxes', async () => {
  const dir = fixtureDir('hashes');
  fs.writeFileSync(path.join(dir, 'photos', 'one.jpg'), await picture(1));
  fs.writeFileSync(path.join(dir, 'photos', 'two.jpg'), await picture(2));
  const rows = [
    { file: 'photos/one.jpg', boxes: [[0, 0, 80, 80], [80, 80, 160, 160]] },
    { file: 'photos/two.jpg', boxes: [] },
  ];
  const hashes = await sealedHashes(dir, rows);
  assert.equal(hashes.length, 4 + 2 * 3);
  assert.ok(hashes.every((h) => /^[0-9a-f]{16}$/.test(h)));
});

test('dropNearSealed drops a correction whose crop is a sealed photo or a sealed box, and counts it', async () => {
  const dir = fixtureDir('drop');
  const sealed = await picture(1);
  fs.writeFileSync(path.join(dir, 'photos', 'one.jpg'), sealed);
  const rows = [{ file: 'photos/one.jpg', boxes: [[0, 0, 80, 160]] }];
  const hashes = await sealedHashes(dir, rows);

  const boxCrop = await sharp(sealed).extract({ left: 0, top: 0, width: 80, height: 160 }).jpeg({ quality: 70 }).toBuffer();
  const corrections = [
    { id: 'same-photo', crop: dataUrl(sealed) },
    { id: 'box-crop', crop: dataUrl(boxCrop) },
    { id: 'different', crop: dataUrl(await picture(5)) },
  ];
  const { kept, dropped } = await dropNearSealed(corrections, hashes, 6);
  assert.deepEqual(kept.map((c) => c.id), ['different']);
  assert.equal(dropped, 2);
});

test('a correction that is a sealed box crop turned 90, 180 or 270 degrees is dropped too', async () => {
  const dir = fixtureDir('rotated');
  const sealed = await picture(1);
  fs.writeFileSync(path.join(dir, 'photos', 'one.jpg'), sealed);
  const hashes = await sealedHashes(dir, [{ file: 'photos/one.jpg', boxes: [[0, 0, 80, 160]] }]);
  const crop = await sharp(sealed).extract({ left: 0, top: 0, width: 80, height: 160 }).jpeg({ quality: 90 }).toBuffer();
  const turned = await Promise.all([90, 180, 270].map((angle) => sharp(crop).rotate(angle).jpeg({ quality: 90 }).toBuffer()));
  const { kept, dropped } = await dropNearSealed(turned.map((jpeg, i) => ({ id: String(i), crop: dataUrl(jpeg) })), hashes, 6);
  assert.deepEqual(kept, []);
  assert.equal(dropped, 3);
});

const flip = (hash, bits) => (BigInt(`0x${hash}`) ^ ((1n << BigInt(bits)) - 1n)).toString(16).padStart(16, '0');

test('kept corrections are counted by how close they came to a sealed hash', async () => {
  const jpeg = await picture(7);
  const own = await dhashImage(jpeg);
  const corrections = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), crop: dataUrl(jpeg) }));
  const bucket = async (bits) => (await dropNearSealed(corrections(1), [flip(own, bits)], 6)).histogram;
  assert.deepEqual(await bucket(8), { '7-10': 1, '11-15': 0, '>15': 0 });
  assert.deepEqual(await bucket(13), { '7-10': 0, '11-15': 1, '>15': 0 });
  assert.deepEqual(await bucket(30), { '7-10': 0, '11-15': 0, '>15': 1 });
  assert.deepEqual((await dropNearSealed(corrections(2), [], 6)).histogram, { '7-10': 0, '11-15': 0, '>15': 2 });
  assert.deepEqual((await dropNearSealed(corrections(1), [flip(own, 3)], 6)).histogram, { '7-10': 0, '11-15': 0, '>15': 0 });
});

test('a correction whose crop cannot be hashed is dropped, since it cannot be shown safe', async () => {
  const { kept, dropped } = await dropNearSealed(
    [{ id: 'nocrop', crop: null }, { id: 'junk', crop: 'data:image/jpeg;base64,AAAA' }],
    ['0000000000000000'],
    6,
  );
  assert.deepEqual(kept, []);
  assert.equal(dropped, 2);
});

test('with no sealed hashes nothing is dropped', async () => {
  const { kept, dropped } = await dropNearSealed([{ id: 'a', crop: dataUrl(await picture(3)) }], [], 6);
  assert.equal(kept.length, 1);
  assert.equal(dropped, 0);
});
