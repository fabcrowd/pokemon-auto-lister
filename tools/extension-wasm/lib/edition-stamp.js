import { STAMP_WIDTH, STAMP_HEIGHT, STAMP_PIXELS } from './first-edition-stamp.js';

// Measured on 154 ShopGoodwill card crops at 375x525: stamps 0.68-0.94, everything else <= 0.61.
export const FIRST_EDITION_MIN_SCORE = 0.7;

const FIRST_EDITION_SETS = new Set(['base1', 'base2', 'base3', 'base5', 'gym1', 'gym2', 'neo1', 'neo2', 'neo3', 'neo4']);

// The stamp sits left of the stat bar, under the art. Crops from the card finder are loose,
// so the window and sizes are wide. Fractions of the card's width and height.
const AREA = { x1: 0, x2: 0.35, y1: 0.36, y2: 0.62 };
const STAMP_SIZES = [30, 36, 42, 48, 56, 64, 72, 80].map((px) => px / 750);

export function hasFirstEdition(setCode) {
  return FIRST_EDITION_SETS.has(setCode);
}

export function grayFromRgba(rgba, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return gray;
}

/** Best match of the 1st Edition stamp in the stamp area of a grayscale card, 0..1. */
export function stampScore(gray, width, height) {
  const x1 = Math.round(AREA.x1 * width);
  const x2 = Math.round(AREA.x2 * width);
  const y1 = Math.round(AREA.y1 * height);
  const y2 = Math.round(AREA.y2 * height);
  let best = 0;
  for (const size of STAMP_SIZES) {
    const t = templateAt(Math.round(size * width), width);
    if (!t) continue;
    const xMax = x2 - t.width;
    const yMax = y2 - t.height;
    // Every other pixel first, then every pixel around the best spot.
    let coarse = { score: -1, x: x1, y: y1 };
    for (let y = y1; y <= yMax; y += 2) {
      for (let x = x1; x <= xMax; x += 2) {
        const score = maskedCorrelation(gray, y * width + x, t);
        if (score > coarse.score) coarse = { score, x, y };
      }
    }
    for (let y = Math.max(y1, coarse.y - 2); y <= Math.min(yMax, coarse.y + 2); y++) {
      for (let x = Math.max(x1, coarse.x - 2); x <= Math.min(xMax, coarse.x + 2); x++) {
        const score = maskedCorrelation(gray, y * width + x, t);
        if (score > best) best = score;
      }
    }
  }
  return best;
}

function maskedCorrelation(gray, origin, t) {
  let sum = 0;
  let sumSq = 0;
  let cross = 0;
  const { offsets, weights } = t;
  for (let k = 0; k < offsets.length; k++) {
    const v = gray[origin + offsets[k]];
    sum += v;
    sumSq += v * v;
    cross += v * weights[k];
  }
  const spread = sumSq - (sum * sum) / offsets.length;
  if (spread <= 1e-6) return 0;
  return cross / Math.sqrt(t.energy * spread);
}

const _templates = new Map();
let _stamp = null;

function templateAt(size, rowLength) {
  const key = `${size}:${rowLength}`;
  if (_templates.has(key)) return _templates.get(key);
  _stamp ??= Float32Array.from(atob(STAMP_PIXELS), (c) => c.charCodeAt(0));
  const width = size;
  const height = Math.round((size * STAMP_HEIGHT) / STAMP_WIDTH);
  if (width < 8 || height < 8) return null;
  const pixels = resizeArea(_stamp, STAMP_WIDTH, STAMP_HEIGHT, width, height);
  const cx = width >> 1;
  const cy = height >> 1;
  const r = Math.min(width, height) >> 1;
  const inside = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) inside.push([x, y]);
    }
  }
  const mean = inside.reduce((s, [x, y]) => s + pixels[y * width + x], 0) / inside.length;
  const weights = Float32Array.from(inside, ([x, y]) => pixels[y * width + x] - mean);
  const t = {
    width,
    height,
    offsets: Int32Array.from(inside, ([x, y]) => y * rowLength + x),
    weights,
    energy: weights.reduce((s, w) => s + w * w, 0),
  };
  _templates.set(key, t);
  return t;
}

function resizeArea(src, sw, sh, dw, dh) {
  const rows = resample(src, sw, sh, dw, true);
  return resample(rows, dw, sh, dh, false);
}

function resample(src, sw, sh, size, horizontal) {
  const from = horizontal ? sw : sh;
  const out = new Float32Array(horizontal ? size * sh : sw * size);
  const scale = from / size;
  for (let i = 0; i < size; i++) {
    const a = i * scale;
    const b = a + scale;
    for (let j = Math.floor(a); j < Math.ceil(b) && j < from; j++) {
      const w = (Math.min(b, j + 1) - Math.max(a, j)) / scale;
      if (horizontal) {
        for (let y = 0; y < sh; y++) out[y * size + i] += src[y * sw + j] * w;
      } else {
        for (let x = 0; x < sw; x++) out[i * sw + x] += src[j * sw + x] * w;
      }
    }
  }
  return out;
}
