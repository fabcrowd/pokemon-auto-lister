import { SYMBOL_PIXELS, SYMBOL_SIZE } from "./set-symbol-templates.js";

// Scale 1 on real train photos. A wider window still left a gap: jungle at 0.70,
// the claw at 0.65, rocket at 0.75. Holdout calls were 18/18.
export const SYMBOL_MIN = { jungle: 0.7, fossil: 0.65, rocket: 0.75 };

// Card fronts of Black Star promos score at least 0.742. The held-out Marill
// photo, cropped by the scanner, lands just under 0.73. A league Pikachu
// reached 0.703, and every other front stayed at or below 0.591.
export const PROMO_STAR_MIN = 0.72;

export const SYMBOL_SET = { jungle: "base2", fossil: "base3", rocket: "base5" };

const AREA = { x1: 0.52, x2: 0.99, y1: 0.4, y2: 0.64 };

const TEMPLATES = {
  jungle: prepared("jungle"),
  fossil: prepared("fossil"),
  rocket: prepared("rocket"),
};

const PROMO_STAR = prepared("promo");

function prepared(name) {
  const [width, height] = SYMBOL_SIZE[name];
  const pixels = Uint8Array.from(atob(SYMBOL_PIXELS[name]), (c) => c.charCodeAt(0));
  const n = width * height;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += pixels[i];
  const mean = sum / n;
  const weights = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = pixels[i] - mean;
    energy += weights[i] * weights[i];
  }
  return { width, height, weights, energy };
}

/** Keep the choices in the symbol's set. An empty overlap leaves the list as it was. */
export function choicesForSymbol(choices, symbol) {
  const code = SYMBOL_SET[symbol];
  if (!code || !Array.isArray(choices) || choices.length < 2) return choices || [];
  const kept = choices.filter((choice) => choice.setCode === code);
  return kept.length ? kept : choices;
}

/** The set symbol, or null when the best template is under its own bar. */
export function symbolFromScores(scores) {
  let best = null;
  let bestScore = -Infinity;
  for (const name of Object.keys(SYMBOL_MIN)) {
    const score = Number(scores?.[name]);
    if (Number.isFinite(score) && score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  if (!best || bestScore < SYMBOL_MIN[best]) return null;
  return best;
}

/** The WotC black-star promo mark in the same window as the set symbol. */
export function promoStarScore(gray, width, height) {
  const region = symbolRegion(gray, width, height);
  if (!region) return 0;
  return matchMax(region.pixels, region.width, region.height, PROMO_STAR);
}

/** Best normalized match of each set symbol in the species-line window. */
function symbolRegion(gray, width, height) {
  const x1 = Math.round(AREA.x1 * width);
  const x2 = Math.round(AREA.x2 * width);
  const y1 = Math.round(AREA.y1 * height);
  const y2 = Math.round(AREA.y2 * height);
  const rw = Math.max(0, x2 - x1);
  const rh = Math.max(0, y2 - y1);
  if (!rw || !rh) return null;
  const pixels = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const src = (y1 + y) * width + x1;
    for (let x = 0; x < rw; x++) pixels[y * rw + x] = gray[src + x];
  }
  return { pixels, width: rw, height: rh };
}

export function symbolScores(gray, width, height) {
  const region = symbolRegion(gray, width, height);
  if (!region) return {};
  const { pixels: regionPixels, width: rw, height: rh } = region;
  const scores = {};
  for (const name of Object.keys(TEMPLATES)) {
    scores[name] = matchMax(regionPixels, rw, rh, TEMPLATES[name]);
  }
  return scores;
}

function matchMax(region, rw, rh, template) {
  const { width: tw, height: th, weights, energy } = template;
  if (tw > rw || th > rh || energy <= 1e-6) return 0;
  const stride = rw + 1;
  const sum = new Float64Array((rw + 1) * (rh + 1));
  const sumSq = new Float64Array((rw + 1) * (rh + 1));
  for (let y = 1; y <= rh; y++) {
    let row = 0;
    let rowSq = 0;
    for (let x = 1; x <= rw; x++) {
      const v = region[(y - 1) * rw + (x - 1)];
      row += v;
      rowSq += v * v;
      sum[y * stride + x] = sum[(y - 1) * stride + x] + row;
      sumSq[y * stride + x] = sumSq[(y - 1) * stride + x] + rowSq;
    }
  }
  const n = tw * th;
  let best = 0;
  let bestX = 0;
  let bestY = 0;
  const scan = (x0, x1, y0, y1, step) => {
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const score = correlation(region, rw, sum, sumSq, stride, x, y, tw, th, weights, energy, n);
        if (score > best) {
          best = score;
          bestX = x;
          bestY = y;
        }
      }
    }
  };
  const xMax = rw - tw;
  const yMax = rh - th;
  scan(0, xMax, 0, yMax, 2);
  scan(Math.max(0, bestX - 2), Math.min(xMax, bestX + 2), Math.max(0, bestY - 2), Math.min(yMax, bestY + 2), 1);
  return best;
}

function correlation(region, rw, sum, sumSq, stride, x, y, tw, th, weights, energy, n) {
  const x2 = x + tw;
  const y2 = y + th;
  const iSum = sum[y2 * stride + x2] - sum[y * stride + x2] - sum[y2 * stride + x] + sum[y * stride + x];
  const iSq = sumSq[y2 * stride + x2] - sumSq[y * stride + x2] - sumSq[y2 * stride + x] + sumSq[y * stride + x];
  const spread = iSq - (iSum * iSum) / n;
  if (spread <= 1e-6) return 0;
  let cross = 0;
  for (let ty = 0; ty < th; ty++) {
    const row = (y + ty) * rw + x;
    const wrow = ty * tw;
    for (let tx = 0; tx < tw; tx++) cross += region[row + tx] * weights[wrow + tx];
  }
  return cross / Math.sqrt(energy * spread);
}
