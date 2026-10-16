import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

import { importSealed, readExport } from '../scripts/lib/sealed-import.mjs';
import { dhashImage } from '../scripts/lib/dhash.mjs';

async function picture(seed) {
  const size = 160;
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
const record = (jpeg, extra = {}) => ({
  id: crypto.randomUUID(),
  ts: 1,
  pageUrl: 'https://www.ebay.com/itm/111',
  host: 'www.ebay.com',
  photo: dataUrl(jpeg),
  boxes: [[10, 10, 90, 120]],
  ...extra,
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-import-'));
const rows = (dir) => fs.readFileSync(path.join(dir, 'photos.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('imports a new photo under its sha and appends a row', async () => {
  const dir = tmp();
  const jpeg = await picture(1);
  const counts = await importSealed({ photos: [record(jpeg)], dir, trainingHashes: [], trainingKeys: new Set(), now: () => 5 });
  assert.deepEqual(counts, { imported: 1, duplicateOfTraining: 0, duplicateOfSealed: 0, urlInTraining: 0, invalid: 0 });
  const sha = crypto.createHash('sha256').update(jpeg).digest('hex');
  assert.ok(fs.existsSync(path.join(dir, 'photos', `${sha}.jpg`)));
  assert.deepEqual(rows(dir), [{
    sha, file: `photos/${sha}.jpg`, pageUrl: 'https://www.ebay.com/itm/111', host: 'www.ebay.com',
    ts: 1, boxes: [[10, 10, 90, 120]], width: 160, height: 160,
  }]);
});

test('importing the same export twice adds nothing', async () => {
  const dir = tmp();
  const photos = [record(await picture(1))];
  await importSealed({ photos, dir, trainingHashes: [], trainingKeys: new Set() });
  const again = await importSealed({ photos, dir, trainingHashes: [], trainingKeys: new Set() });
  assert.equal(again.imported, 0);
  assert.equal(again.duplicateOfSealed, 1);
  assert.equal(rows(dir).length, 1);
});

test('a re-encoded copy of an imported photo is a duplicate of sealed', async () => {
  const dir = tmp();
  const jpeg = await picture(2);
  await importSealed({ photos: [record(jpeg)], dir, trainingHashes: [], trainingKeys: new Set() });
  const copy = await sharp(jpeg).resize(100, 100).jpeg({ quality: 60 }).toBuffer();
  const counts = await importSealed({ photos: [record(copy)], dir, trainingHashes: [], trainingKeys: new Set() });
  assert.equal(counts.duplicateOfSealed, 1);
  assert.equal(counts.imported, 0);
});

test('drops a photo that looks like a training image, or whose box does', async () => {
  const dir = tmp();
  const trained = await picture(3);
  const trainingHashes = [await dhashImage(trained)];
  const same = await importSealed({ photos: [record(await sharp(trained).resize(120, 120).jpeg().toBuffer())], dir, trainingHashes, trainingKeys: new Set() });
  assert.equal(same.duplicateOfTraining, 1);

  const cardHash = [await dhashImage(trained, [20, 20, 100, 140])];
  const cropped = await importSealed({
    photos: [record(await picture(4), { boxes: [[20, 20, 100, 140]] })],
    dir: tmp(),
    trainingHashes: [await dhashImage(await picture(4), [20, 20, 100, 140]), ...cardHash],
    trainingKeys: new Set(),
  });
  assert.equal(cropped.duplicateOfTraining, 1);
  assert.equal(cropped.imported, 0);
});

test('drops a listing whose id is in training before looking at pixels', async () => {
  const dir = tmp();
  const counts = await importSealed({
    photos: [record(await picture(5), { pageUrl: 'https://shopgoodwill.com/item/279630564' })],
    dir,
    trainingHashes: [],
    trainingKeys: new Set(['goodwill:279630564']),
  });
  assert.equal(counts.urlInTraining, 1);
  assert.equal(counts.imported, 0);
  assert.equal(fs.existsSync(path.join(dir, 'photos.jsonl')), false);
});

test('skips records that are not a JPEG with boxes', async () => {
  const dir = tmp();
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  const counts = await importSealed({
    photos: [
      { ...record(await picture(6)), photo: 'data:image/png;base64,AAAA' },
      { ...record(await picture(6)), photo: `data:image/jpeg;base64,${png.toString('base64')}` },
      { ...record(await picture(6)), boxes: 'nope' },
      { ...record(await picture(6)), boxes: [[1, 2, 3]] },
      null,
    ],
    dir,
    trainingHashes: [],
    trainingKeys: new Set(),
  });
  assert.equal(counts.invalid, 5);
  assert.equal(counts.imported, 0);
});

test('keeps only origin and path of the page, never its query', async () => {
  const dir = tmp();
  await importSealed({
    photos: [record(await picture(7), { pageUrl: 'https://www.ebay.com/itm/9?hash=secret' })],
    dir, trainingHashes: [], trainingKeys: new Set(),
  });
  assert.equal(rows(dir)[0].pageUrl, 'https://www.ebay.com/itm/9');
});

test('two photos of the same card are one card even when the photos differ', async () => {
  const dir = tmp();
  const patch = await sharp(await picture(11)).extract({ left: 20, top: 20, width: 100, height: 120 }).png().toBuffer();
  const first = await sharp(await picture(11)).jpeg({ quality: 92 }).toBuffer();
  const second = await sharp(await picture(14)).composite([{ input: patch, left: 30, top: 10 }]).jpeg({ quality: 92 }).toBuffer();
  const one = await importSealed({
    photos: [record(first, { boxes: [[20, 20, 120, 140]] })], dir, trainingHashes: [], trainingKeys: new Set(),
  });
  assert.equal(one.imported, 1);
  const two = await importSealed({
    photos: [record(second, { boxes: [[30, 10, 130, 130]] })], dir, trainingHashes: [], trainingKeys: new Set(),
  });
  assert.equal(two.duplicateOfSealed, 1);
  assert.equal(two.imported, 0);
});

test('refuses oversized records before decoding them', async () => {
  const dir = tmp();
  const huge = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#888' } }).jpeg().toBuffer();
  const counts = await importSealed({
    photos: [
      { ...record(await picture(15)), photo: 'data:image/jpeg;base64,' + 'A'.repeat(16 * 1024 * 1024) },
      record(await picture(15), { boxes: Array.from({ length: 61 }, () => [0, 0, 5, 5]) }),
      record(huge),
    ],
    dir, trainingHashes: [], trainingKeys: new Set(),
  });
  assert.equal(counts.invalid, 3);
  assert.equal(counts.imported, 0);
});

test('an index row whose file is not photos/<sha>.jpg stops the import', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'photos.jsonl'), JSON.stringify({
    sha: 'a'.repeat(64), file: '../../secret.jpg', boxes: [], width: 5, height: 5,
  }) + '\n');
  await assert.rejects(
    importSealed({ photos: [record(await picture(16))], dir, trainingHashes: [], trainingKeys: new Set() }),
    /photos\.jsonl/,
  );
});

test('readExport refuses a file over the size limit and one without photos', async () => {
  const dir = tmp();
  const file = path.join(dir, 'export.json');
  fs.writeFileSync(file, JSON.stringify({ photos: [] }));
  assert.deepEqual(await readExport(file), { photos: [] });
  await assert.rejects(readExport(file, { maxBytes: 5 }), /too large/);
  fs.writeFileSync(file, '{"nope":1}');
  await assert.rejects(readExport(file), /photos/);
});
