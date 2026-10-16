import fs from 'node:fs/promises';
import path from 'node:path';

import { dhashImage, nearestWithin } from './dhash.mjs';

const JPEG_URL = /^data:image\/jpeg;base64,/;
const TURNS = [90, 180, 270];
const FAR = 64;

/**
 * dHashes of every sealed photo and every box cut from one, boxes also turned a quarter, half and
 * three quarters. Only the hashes leave this function.
 */
export async function sealedHashes(dir, rows) {
  const hashes = [];
  for (const row of rows) {
    const bytes = await fs.readFile(path.join(dir, row.file));
    hashes.push(await dhashImage(bytes));
    for (const box of row.boxes || []) {
      hashes.push(await dhashImage(bytes, box));
      for (const turn of TURNS) hashes.push(await dhashImage(bytes, box, turn));
    }
  }
  return hashes;
}

const bucketOf = (distance) => (distance <= 10 ? '7-10' : distance <= 15 ? '11-15' : '>15');

/**
 * Corrections whose crop is not within `limit` bits of any sealed hash. A crop that cannot be
 * hashed cannot be shown safe, so it is dropped too. Returns the survivors, how many were dropped,
 * and how many survivors came within 7-10, 11-15 or more than 15 bits of the nearest sealed hash.
 * This cannot catch a different photo of the same physical card.
 */
export async function dropNearSealed(corrections, hashes, limit) {
  const kept = [];
  const histogram = { '7-10': 0, '11-15': 0, '>15': 0 };
  let dropped = 0;
  for (const correction of corrections) {
    let hash = null;
    if (typeof correction.crop === 'string' && JPEG_URL.test(correction.crop)) {
      try {
        hash = await dhashImage(Buffer.from(correction.crop.replace(JPEG_URL, ''), 'base64'));
      } catch {
        hash = null;
      }
    }
    const nearest = hash ? nearestWithin(hashes, hash, FAR) : null;
    if (!hash || (nearest && nearest.distance <= limit)) {
      dropped += 1;
      continue;
    }
    kept.push(correction);
    histogram[bucketOf(nearest ? nearest.distance : FAR)] += 1;
  }
  return { kept, dropped, histogram };
}
