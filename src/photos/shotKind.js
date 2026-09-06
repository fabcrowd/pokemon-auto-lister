/**
 * Classify inbox shots as full front, full back, or close-up (corner macro).
 * Uses a small resize + edge/blue heuristic (no ML).
 */
import path from 'node:path';
import sharp from 'sharp';

/** @typedef {'full_front' | 'full_back' | 'closeup'} ShotKind */

const WIDTH = 120;
const HEIGHT = 160;

/**
 * Extract camera roll index from IMG_1234 / IMG_1234(1).JPG style names.
 * @param {string} photoPath
 * @returns {number|null}
 */
export function extractImgNumber(photoPath) {
  const base = path.basename(photoPath);
  const match = base.match(/^IMG_(\d+)/i);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * Sort key: IMG_#### first, then basename, then mtime.
 * @param {string} a
 * @param {string} b
 * @param {{ mtimeA?: number, mtimeB?: number }} [meta]
 */
export function comparePhotoPaths(a, b, { mtimeA = 0, mtimeB = 0 } = {}) {
  const numA = extractImgNumber(a);
  const numB = extractImgNumber(b);
  if (numA != null && numB != null && numA !== numB) {
    return numA - numB;
  }
  if (numA != null && numB == null) {
    return -1;
  }
  if (numA == null && numB != null) {
    return 1;
  }
  const byName = path.basename(a).localeCompare(path.basename(b));
  if (byName !== 0) {
    return byName;
  }
  return mtimeA - mtimeB;
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function smooth1d(arr, radius = 2) {
  return arr.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = i - radius; k <= i + radius; k += 1) {
      if (k >= 0 && k < arr.length) {
        sum += arr[k];
        n += 1;
      }
    }
    return sum / n;
  });
}

/**
 * Score a downscaled RGB buffer for shot kind.
 * @param {Buffer|Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} [channels]
 */
export function scoreRawRgb(data, width, height, channels = 3) {
  const gray = new Float32Array(width * height);
  let blue = 0;
  for (let i = 0, px = 0; i < data.length; i += channels, px += 1) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    gray[px] = luma(r, g, b);
    if (b > r + 15 && b > g + 10 && b > 60) {
      blue += 1;
    }
  }

  const blueFrac = blue / (width * height);
  const x0 = Math.floor(width * 0.15);
  const x1 = Math.floor(width * 0.85);
  const y0 = Math.floor(height * 0.15);
  const y1 = Math.floor(height * 0.85);

  const col = new Array(width).fill(0);
  const row = new Array(height).fill(0);
  for (let x = 1; x < width - 1; x += 1) {
    let e = 0;
    for (let y = y0; y < y1; y += 1) {
      const i = y * width + x;
      e += Math.abs(gray[i] - gray[i - 1]);
    }
    col[x] = e / Math.max(1, y1 - y0);
  }
  for (let y = 1; y < height - 1; y += 1) {
    let e = 0;
    for (let x = x0; x < x1; x += 1) {
      const i = y * width + x;
      e += Math.abs(gray[i] - gray[i - width]);
    }
    row[y] = e / Math.max(1, x1 - x0);
  }

  const colS = smooth1d(col);
  const rowS = smooth1d(row);
  const left = colS.slice(3, Math.floor(width * 0.45));
  const right = colS.slice(Math.floor(width * 0.55), width - 3);
  const top = rowS.slice(3, Math.floor(height * 0.45));
  const bot = rowS.slice(Math.floor(height * 0.55), height - 3);

  const maxL = Math.max(...left);
  const maxR = Math.max(...right);
  const maxT = Math.max(...top);
  const maxB = Math.max(...bot);
  const iL = left.indexOf(maxL) + 3;
  const iR = right.indexOf(maxR) + Math.floor(width * 0.55);
  const iT = top.indexOf(maxT) + 3;
  const iB = bot.indexOf(maxB) + Math.floor(height * 0.55);

  const widthFrac = (iR - iL) / width;
  const heightFrac = (iB - iT) / height;
  const cardAspect = widthFrac / Math.max(0.01, heightFrac);

  const sorted = Array.from(gray).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const darkThresh = Math.min(70, Math.max(40, p10 + 18));
  let nondark = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x] >= darkThresh) {
        nondark += 1;
        sumX += x;
        sumY += y;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const coverage = nondark / (width * height);
  const cx = nondark ? sumX / nondark / width : 0.5;
  const cy = nondark ? sumY / nondark / height : 0.5;
  const offset = Math.hypot(cx - 0.5, cy - 0.5);
  const inset = minX > 4 && minY > 4 && maxX < width - 5 && maxY < height - 5;

  const edgePx = 6;
  let edgeN = 0;
  let edgeCard = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < edgePx || y < edgePx || x >= width - edgePx || y >= height - edgePx) {
        edgeN += 1;
        if (gray[y * width + x] >= darkThresh) {
          edgeCard += 1;
        }
      }
    }
  }
  const edgeCardRatio = edgeN ? edgeCard / edgeN : 1;

  // Prefer wide left/right card edges and a visible mat margin (low edgeCardRatio).
  // Corner macros often either have a narrow edge span or fill the frame edge with card.
  const score = Math.max(
    0,
    Math.min(
      1,
      widthFrac * 0.55 +
        Math.min(heightFrac, 0.9) * 0.15 +
        (1 - edgeCardRatio) * 0.3 -
        Math.min(offset, 0.35) * 0.2,
    ),
  );

  const looksBlueBack = blueFrac > 0.12 && widthFrac >= 0.4;
  const looksMatFront =
    inset &&
    coverage >= 0.35 &&
    coverage <= 0.82 &&
    offset < 0.12 &&
    widthFrac >= 0.55 &&
    blueFrac < 0.12;

  // Full-card rectangle on a mat / plain bg: both axes span with card-like aspect.
  const cardAspectOk = cardAspect >= 0.55 && cardAspect <= 1.05;
  const looksRectFront =
    !looksBlueBack &&
    widthFrac >= 0.55 &&
    heightFrac >= 0.55 &&
    cardAspectOk &&
    offset < 0.14;

  // Stand / busy-bg full fronts often have strong left-right edges but weak
  // top-bottom peaks (keyboard, stand). Corner macros usually pick up both axes
  // (heightFrac >= ~0.5) or sit off-center.
  const looksStandFront =
    !looksBlueBack &&
    widthFrac >= 0.58 &&
    widthFrac <= 0.88 &&
    heightFrac > 0 &&
    heightFrac < 0.52 &&
    offset < 0.1;

  /** @type {ShotKind} */
  let kind = 'closeup';
  if (looksBlueBack) {
    kind = 'full_back';
  } else if (looksMatFront || looksRectFront || looksStandFront) {
    kind = 'full_front';
  }

  return {
    kind,
    score,
    widthFrac,
    heightFrac,
    cardAspect,
    blueFrac,
    coverage,
    offset,
    inset,
    edgeCardRatio,
  };
}

/**
 * @param {string} imagePath
 * @param {{ sharpImpl?: typeof sharp }} [opts]
 * @returns {Promise<{ path: string, kind: ShotKind, score: number, scores: object }>}
 */
export async function classifyShot(imagePath, { sharpImpl = sharp } = {}) {
  try {
    const { data, info } = await sharpImpl(imagePath)
      .rotate()
      .resize(WIDTH, HEIGHT, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const scores = scoreRawRgb(data, info.width, info.height, info.channels);
    return {
      path: imagePath,
      kind: scores.kind,
      score: scores.score,
      scores,
    };
  } catch (err) {
    console.warn(`shotKind: classify failed for ${path.basename(imagePath)}:`, err.message);
    return {
      path: imagePath,
      kind: 'closeup',
      score: 0,
      scores: { error: err.message },
    };
  }
}

/**
 * @param {string[]} photoPaths
 * @param {{ classifyShotFn?: typeof classifyShot }} [opts]
 */
export async function classifyShots(photoPaths, { classifyShotFn = classifyShot } = {}) {
  const out = [];
  for (const photoPath of photoPaths) {
    out.push(await classifyShotFn(photoPath));
  }
  return out;
}
