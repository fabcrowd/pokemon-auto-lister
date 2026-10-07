/**
 * Multi-card splitting: calls the /detect-multi sidecar endpoint and writes
 * each detected card crop as a JPEG file under data/split-crops/.
 *
 * Returns the expanded list of photo paths to feed into classifyShots:
 *   - If 2+ cards are detected: returns the N crop paths.
 *   - If 0 or 1 card detected, or on any error: returns [originalPath] unchanged.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * @param {{
 *   baseUrl?: string,
 *   dataDir?: string,
 *   fetchImpl?: typeof fetch,
 *   enabled?: boolean,
 * }} [options]
 */
export function createMultiCardSplitter({
  baseUrl = process.env.VELLUM_AI_URL || 'http://127.0.0.1:8787',
  dataDir = 'data',
  fetchImpl = fetch,
  enabled = String(process.env.VELLUM_AI_ENABLED || 'false').toLowerCase() === 'true',
} = {}) {
  const root = String(baseUrl).replace(/\/$/, '');
  const cropsDir = path.join(dataDir, 'split-crops');

  /**
   * @param {Buffer} imageBuffer
   * @param {string} [label]
   * @returns {Promise<string[]|null>} crop paths, or null when not multi-card / failed
   */
  async function detectMultiCrops(imageBuffer, label = 'photo.jpg') {
    if (!enabled || !imageBuffer?.length) {
      return null;
    }

    let data;
    try {
      const form = new FormData();
      form.append('photo', new File([imageBuffer], path.basename(label), { type: 'image/jpeg' }));
      const response = await fetchImpl(`${root}/detect-multi`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        return null;
      }
      data = await response.json();
    } catch {
      return null;
    }

    const cards = Array.isArray(data?.cards) ? data.cards : [];
    if (cards.length <= 1) {
      return null;
    }

    mkdirSync(cropsDir, { recursive: true });
    const sourceHash = createHash('sha256').update(imageBuffer).digest('hex').slice(0, 12);
    const cropPaths = [];

    for (const card of cards) {
      const b64 = card.crop_b64;
      if (!b64) {
        continue;
      }
      const cropBytes = Buffer.from(b64, 'base64');
      const idx = card.index ?? cropPaths.length;
      const cropName = `${sourceHash}_card${idx}.jpg`;
      const cropPath = path.join(cropsDir, cropName);
      writeFileSync(cropPath, cropBytes);
      cropPaths.push(cropPath);
    }

    return cropPaths.length >= 2 ? cropPaths : null;
  }

  /**
   * Expand a single photo path into one-or-more crop paths.
   * Always returns at least [photoPath] (the original) on any failure.
   *
   * @param {string} photoPath
   * @returns {Promise<string[]>}
   */
  async function splitPhoto(photoPath) {
    if (!enabled) {
      return [photoPath];
    }

    let imageBuffer;
    try {
      imageBuffer = readFileSync(photoPath);
    } catch {
      return [photoPath];
    }

    const crops = await detectMultiCrops(imageBuffer, path.basename(photoPath));
    return crops ?? [photoPath];
  }

  /**
   * Download a remote listing photo and split into card crops when 2+ are detected.
   * Returns crop file paths, or [imageUrl] when splitting does not apply.
   *
   * @param {string} imageUrl
   * @returns {Promise<string[]>}
   */
  async function splitRemoteUrl(imageUrl) {
    if (!enabled || typeof imageUrl !== 'string' || !imageUrl) {
      return [imageUrl];
    }

    let imageBuffer;
    try {
      const response = await fetchImpl(imageUrl);
      if (!response.ok) {
        return [imageUrl];
      }
      imageBuffer = Buffer.from(await response.arrayBuffer());
    } catch {
      return [imageUrl];
    }

    const crops = await detectMultiCrops(imageBuffer, 'marketplace.jpg');
    return crops ?? [imageUrl];
  }

  /**
   * Expand an array of photo paths, splitting any multi-card images.
   *
   * @param {string[]} photoPaths
   * @returns {Promise<string[]>}
   */
  async function splitPhotos(photoPaths) {
    const expanded = await Promise.all(photoPaths.map((p) => splitPhoto(p)));
    return expanded.flat();
  }

  /**
   * Call /detect-multi and return the raw card array from the sidecar.
   * Each element may include { crop_b64, index, box }.
   * Returns null when the sidecar is unavailable or returns <1 card.
   *
   * @param {Buffer} imageBuffer
   * @param {string} [label]
   * @returns {Promise<Array<{crop_b64?: string, index?: number, box?: number[]}> | null>}
   */
  async function detectRaw(imageBuffer, label = 'photo.jpg') {
    if (!imageBuffer?.length) return null;
    let data;
    try {
      const form = new FormData();
      form.append('photo', new File([imageBuffer], path.basename(label), { type: 'image/jpeg' }));
      const response = await fetchImpl(`${root}/detect-multi`, { method: 'POST', body: form });
      if (!response.ok) return null;
      data = await response.json();
    } catch {
      return null;
    }
    const cards = Array.isArray(data?.cards) ? data.cards : [];
    return cards.length >= 1 ? cards : null;
  }

  return { splitPhoto, splitPhotos, splitRemoteUrl, detectMultiCrops, detectRaw, enabled, baseUrl: root };
}
