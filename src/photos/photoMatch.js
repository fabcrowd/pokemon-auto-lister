import sharp from 'sharp';

import { extractImgNumber } from './shotKind.js';

const FP_SIZE = 24;
const BINS = 8;

/**
 * @param {Buffer|Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @returns {Float32Array} length BINS^3, L1-normalized
 */
export function rgbHistogram(data, width, height, channels = 3) {
  const hist = new Float32Array(BINS * BINS * BINS);
  let total = 0;
  for (let i = 0; i < data.length; i += channels) {
    const r = Math.min(BINS - 1, Math.floor((data[i] / 256) * BINS));
    const g = Math.min(BINS - 1, Math.floor((data[i + 1] / 256) * BINS));
    const b = Math.min(BINS - 1, Math.floor((data[i + 2] / 256) * BINS));
    hist[r * BINS * BINS + g * BINS + b] += 1;
    total += 1;
  }
  if (total > 0) {
    for (let i = 0; i < hist.length; i += 1) {
      hist[i] /= total;
    }
  }
  return hist;
}

/**
 * Histogram intersection similarity in [0, 1].
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 */
export function histogramIntersection(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += Math.min(a[i], b[i]);
  }
  return sum;
}

/**
 * Mean RGB vector (3 floats 0–1) for a quick secondary cue.
 * @param {Buffer|Uint8Array} data
 * @param {number} channels
 */
export function meanRgb(data, channels = 3) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  if (!n) {
    return [0, 0, 0];
  }
  return [r / n / 255, g / n / 255, b / n / 255];
}

function meanDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * @typedef {{ hist: Float32Array, mean: number[], label: string }} Fingerprint
 */

/**
 * Build fingerprints for a front: full frame + four corner crops.
 * @param {string} imagePath
 * @param {{ sharpImpl?: typeof sharp }} [opts]
 * @returns {Promise<Fingerprint[]>}
 */
export async function buildFrontFingerprints(imagePath, { sharpImpl = sharp } = {}) {
  const base = sharpImpl(imagePath).rotate();
  const { data: fullBuf, info } = await base
    .clone()
    .resize(FP_SIZE * 4, FP_SIZE * 4, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const cropW = Math.max(8, Math.floor(w * 0.42));
  const cropH = Math.max(8, Math.floor(h * 0.42));

  const regions = [
    { label: 'full', left: 0, top: 0, width: w, height: h },
    { label: 'tl', left: 0, top: 0, width: cropW, height: cropH },
    { label: 'tr', left: w - cropW, top: 0, width: cropW, height: cropH },
    { label: 'bl', left: 0, top: h - cropH, width: cropW, height: cropH },
    { label: 'br', left: w - cropW, top: h - cropH, width: cropW, height: cropH },
  ];

  /** @type {Fingerprint[]} */
  const out = [];
  for (const region of regions) {
    const { data, info: cropInfo } = await sharpImpl(fullBuf, {
      raw: { width: w, height: h, channels: info.channels },
    })
      .extract({
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
      })
      .resize(FP_SIZE, FP_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    out.push({
      label: region.label,
      hist: rgbHistogram(data, cropInfo.width, cropInfo.height, cropInfo.channels),
      mean: meanRgb(data, cropInfo.channels),
    });
  }
  return out;
}

/**
 * @param {string} imagePath
 * @param {{ sharpImpl?: typeof sharp }} [opts]
 * @returns {Promise<Fingerprint>}
 */
export async function buildShotFingerprint(imagePath, { sharpImpl = sharp } = {}) {
  const { data, info } = await sharpImpl(imagePath)
    .rotate()
    .resize(FP_SIZE, FP_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    label: 'shot',
    hist: rgbHistogram(data, info.width, info.height, info.channels),
    mean: meanRgb(data, info.channels),
  };
}

/**
 * Best similarity of a close-up to any front fingerprint (full or corner crop).
 * @param {Fingerprint} closeupFp
 * @param {Fingerprint[]} frontFps
 */
export function bestSimilarity(closeupFp, frontFps) {
  let best = 0;
  let bestLabel = null;
  for (const fp of frontFps) {
    const histScore = histogramIntersection(closeupFp.hist, fp.hist);
    const meanPenalty = Math.min(1, meanDistance(closeupFp.mean, fp.mean) / 0.55);
    const score = histScore * (1 - 0.35 * meanPenalty);
    if (score > best) {
      best = score;
      bestLabel = fp.label;
    }
  }
  return { score: best, label: bestLabel };
}

/** Minimum similarity to attach a close-up to a front. */
export const CLOSEUP_MATCH_THRESHOLD = 0.32;
/** Best score must beat the runner-up by this margin (ambiguous otherwise). */
export const CLOSEUP_MATCH_MARGIN = 0.035;

/**
 * Soft camera-roll proximity in [0, 1] — same-card corners are usually near the front in IMG_#### order.
 * @param {string} closeupPath
 * @param {string} frontPath
 */
export function proximityBonus(closeupPath, frontPath) {
  const a = extractImgNumber(closeupPath);
  const b = extractImgNumber(frontPath);
  if (a == null || b == null) {
    return 0;
  }
  const dist = Math.abs(a - b);
  return Math.exp(-dist / 25);
}

/**
 * Pick the best front path for a close-up.
 * @param {string} closeupPath
 * @param {string[]} frontPaths
 * @param {{
 *   sharpImpl?: typeof sharp,
 *   frontFpCache?: Map<string, import('./photoMatch.js').Fingerprint[]>,
 *   threshold?: number,
 *   margin?: number,
 * }} [opts]
 * @returns {Promise<{ frontPath: string|null, score: number, label: string|null }>}
 */
export async function matchCloseupToFront(
  closeupPath,
  frontPaths,
  {
    sharpImpl = sharp,
    frontFpCache = new Map(),
    threshold = CLOSEUP_MATCH_THRESHOLD,
    margin = CLOSEUP_MATCH_MARGIN,
  } = {},
) {
  if (!frontPaths.length) {
    return { frontPath: null, score: 0, label: null };
  }

  const closeupFp = await buildShotFingerprint(closeupPath, { sharpImpl });
  /** @type {{ frontPath: string, score: number, label: string|null }[]} */
  const ranked = [];

  for (const frontPath of frontPaths) {
    let fps = frontFpCache.get(frontPath);
    if (!fps) {
      fps = await buildFrontFingerprints(frontPath, { sharpImpl });
      frontFpCache.set(frontPath, fps);
    }
    const { score: histScore, label } = bestSimilarity(closeupFp, fps);
    const prox = proximityBonus(closeupPath, frontPath);
    const score = histScore * 0.82 + prox * 0.18;
    ranked.push({ frontPath, score, label });
  }

  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < threshold) {
    return { frontPath: null, score: best?.score ?? 0, label: best?.label ?? null };
  }
  if (second && best.score - second.score < margin) {
    return { frontPath: null, score: best.score, label: best.label };
  }
  return best;
}
