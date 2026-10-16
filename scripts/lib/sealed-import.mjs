import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { MAX_PIXELS, dhashImage, nearestWithin } from './dhash.mjs';
import { validPhotoRow } from './sealed-labels.mjs';
import { listingKey } from './training-match.mjs';
import { pageUrlForStorage } from '../../tools/extension-wasm/lib/card-picker.js';

const MAX_DISTANCE = 6;
const MAX_PHOTO_CHARS = 15 * 1024 * 1024;
const MAX_BOXES = 60;
const MAX_EXPORT_BYTES = 500 * 1024 * 1024;
const JPEG_URL = /^data:image\/jpeg;base64,/;

const validBox = (box) => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite);

async function readRows(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function decode(record) {
  if (!record || typeof record.photo !== 'string' || record.photo.length > MAX_PHOTO_CHARS || !JPEG_URL.test(record.photo)) return null;
  if (!Array.isArray(record.boxes) || record.boxes.length > MAX_BOXES || !record.boxes.every(validBox)) return null;
  const buffer = Buffer.from(record.photo.replace(JPEG_URL, ''), 'base64');
  try {
    const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
    return meta.format === 'jpeg' && meta.width && meta.height ? { buffer, width: meta.width, height: meta.height } : null;
  } catch {
    return null;
  }
}

/** The export file, refused when it is bigger than any real export should be. */
export async function readExport(file, { maxBytes = MAX_EXPORT_BYTES } = {}) {
  if ((await fs.stat(file)).size > maxBytes) throw new Error('That export file is too large.');
  const exported = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(exported?.photos)) throw new Error('That file has no "photos" list. Export it from the extension settings page, under Test photos.');
  return exported;
}

/**
 * Add exported test photos to the sealed set, skipping any the scanner may have trained on.
 * @param photos records from the extension's "Test photos" export
 * @param trainingHashes dHashes of training images
 * @param trainingKeys listing keys of training photos (see training-match.mjs)
 */
export async function importSealed({ photos, dir, trainingHashes, trainingKeys, now = Date.now }) {
  const counts = { imported: 0, duplicateOfTraining: 0, duplicateOfSealed: 0, urlInTraining: 0, invalid: 0 };
  const photosDir = path.join(dir, 'photos');
  const indexFile = path.join(dir, 'photos.jsonl');
  await fs.mkdir(photosDir, { recursive: true });

  const sealed = await readRows(indexFile);
  const knownShas = new Set(sealed.map((row) => row.sha));
  const sealedHashes = [];
  const sealedBoxHashes = [];
  for (const row of sealed) {
    if (!validPhotoRow(row)) throw new Error('photos.jsonl has a row that is not photos/<sha>.jpg. Fix or remove it before importing.');
    const bytes = await fs.readFile(path.join(dir, row.file));
    sealedHashes.push(await dhashImage(bytes));
    for (const box of row.boxes) sealedBoxHashes.push(await dhashImage(bytes, box));
  }

  for (const record of photos) {
    const key = listingKey(record?.pageUrl);
    if (key && trainingKeys.has(key)) {
      counts.urlInTraining += 1;
      continue;
    }
    const image = await decode(record);
    if (!image) {
      counts.invalid += 1;
      continue;
    }
    const sha = crypto.createHash('sha256').update(image.buffer).digest('hex');
    if (knownShas.has(sha)) {
      counts.duplicateOfSealed += 1;
      continue;
    }
    // A training crop is one card cut from a photo, so each box is hashed as well as the whole picture.
    const hashes = [await dhashImage(image.buffer)];
    for (const box of record.boxes) hashes.push(await dhashImage(image.buffer, box));
    if (hashes.some((hash) => nearestWithin(trainingHashes, hash, MAX_DISTANCE))) {
      counts.duplicateOfTraining += 1;
      continue;
    }
    // Another photo of the same physical card shares a box crop even when the photos differ.
    if (nearestWithin(sealedHashes, hashes[0], MAX_DISTANCE) || hashes.slice(1).some((hash) => nearestWithin(sealedBoxHashes, hash, MAX_DISTANCE))) {
      counts.duplicateOfSealed += 1;
      continue;
    }
    const file = `photos/${sha}.jpg`;
    await fs.writeFile(path.join(dir, file), image.buffer);
    await fs.appendFile(indexFile, JSON.stringify({
      sha,
      file,
      pageUrl: pageUrlForStorage(record.pageUrl),
      host: typeof record.host === 'string' ? record.host : null,
      ts: Number.isFinite(record.ts) ? record.ts : now(),
      boxes: record.boxes,
      width: image.width,
      height: image.height,
    }) + '\n');
    knownShas.add(sha);
    sealedHashes.push(hashes[0]);
    sealedBoxHashes.push(...hashes.slice(1));
    counts.imported += 1;
  }
  return counts;
}
