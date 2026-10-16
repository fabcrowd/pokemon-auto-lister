import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { loadTrainingHashes, trainingRoots, trainingFolders } from '../scripts/lib/training-hashes.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'training-data-'));

async function image(seed, format = 'jpeg') {
  const size = 64;
  const raw = Buffer.alloc(size * size * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * (seed + 3)) % 251;
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })[format]().toBuffer();
}

function put(root, rel, bytes) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

test('trainingRoots covers every data folder except catalog renders, profiles and the sealed set', async () => {
  const data = tmp();
  for (const rel of [
    'variant-photos/crops/a.jpg', 'detect-hibid-real/123/00.jpg', 'detect-real-eval/positive/a.png',
    'edition-crops/a.jpg', 'harvest/f.jpg', 'scans/s.jpg', 'vellum-detect/images/a.jpg',
    'sealed-test/photos/x.jpg', 'card-catalog/images/y.jpg', 'card-catalog-backup-2026/y.jpg', 'catalog-images/z.jpg',
    'hibid-chrome-profile/Cache/c.jpg', 'extension-live-profile/Default/c.jpg',
  ]) put(data, rel, 'x');
  put(data, 'extension-live-listing-1.png', 'x');
  put(data, 'extension-live-listing-2.png', 'x');
  put(data, 'unrelated.png', 'x');
  const { dirs, files } = await trainingRoots(data);
  assert.deepEqual(dirs.map((d) => d.name).sort(), [
    'detect-hibid-real', 'detect-real-eval', 'edition-crops', 'harvest', 'scans', 'variant-photos', 'vellum-detect',
  ]);
  assert.deepEqual(files.map((f) => path.basename(f)).sort(), ['extension-live-listing-1.png', 'extension-live-listing-2.png']);
});

test('loadTrainingHashes reads jpg, jpeg, png and webp, and counts images per root', async () => {
  const data = tmp();
  put(data, 'a/one.jpg', await image(1));
  put(data, 'a/two.JPEG', await image(2));
  put(data, 'b/deep/three.png', await image(3, 'png'));
  put(data, 'b/four.webp', await image(4, 'webp'));
  put(data, 'b/notes.txt', 'x');
  put(data, 'shot.png', await image(5, 'png'));
  const result = await loadTrainingHashes({
    roots: [{ name: 'a', path: path.join(data, 'a') }, { name: 'b', path: path.join(data, 'b') }],
    files: [path.join(data, 'shot.png')],
    cachePath: path.join(data, 'cache.json'),
    base: data,
  });
  assert.equal(result.hashes.length, 5);
  assert.deepEqual(result.counts, { a: 2, b: 2, 'loose files': 1 });
  assert.equal(result.hashed, 5);
  const again = await loadTrainingHashes({
    roots: [{ name: 'a', path: path.join(data, 'a') }],
    files: [],
    cachePath: path.join(data, 'cache.json'),
    base: data,
  });
  assert.equal(again.hashed, 0);
  assert.equal(again.hashes.length, 2);
});

test('trainingFolders names the listing folders of every marketplace training set', async () => {
  const data = tmp();
  put(data, 'detect-marketplace/goodwill/279630564/00.jpg', 'x');
  put(data, 'detect-marketplace/facebook/facebook_946237095188044/00.jpg', 'x');
  put(data, 'detect-marketplace/hibid/hibid_320425372/00.jpg', 'x');
  put(data, 'detect-hibid-real/318476644/00.jpg', 'x');
  const folders = await trainingFolders(data);
  assert.deepEqual(folders.goodwill, ['279630564']);
  assert.deepEqual(folders.facebook, ['facebook_946237095188044']);
  assert.deepEqual(folders.hibid.sort(), ['318476644', 'hibid_320425372']);
});
