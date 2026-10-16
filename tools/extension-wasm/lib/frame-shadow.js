// Measured on ShopGoodwill crops: shadowless cards score 0, the weakest
// real drop shadow scores 0.36. Only Base Set is shadowless; other WotC
// sets have this band on every copy.
export const SHADOW_MIN_DEPTH = 0.25;

/**
 * Depth of the dark band just outside the right edge of the art frame, 0..1.
 * The band is a narrow near-black valley with a bright shoulder on each side.
 * @param {Float32Array} gray
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function shadowDepth(gray, width, height) {
  const y1 = Math.round(0.22 * height);
  const y2 = Math.round(0.34 * height);
  const x1 = Math.round(0.72 * width);
  const x2 = Math.round(0.99 * width);
  if (y2 <= y1 || x2 - x1 < 48) return 0;
  const cols = new Float32Array(x2 - x1);
  for (let x = x1; x < x2; x++) {
    let sum = 0;
    for (let y = y1; y < y2; y++) sum += gray[y * width + x];
    cols[x - x1] = sum / (y2 - y1);
  }
  const smooth = new Float32Array(cols.length);
  for (let i = 0; i < cols.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= cols.length) continue;
      sum += cols[j];
      n += 1;
    }
    smooth[i] = sum / n;
  }
  let best = 0;
  for (let i = 40; i < smooth.length - 8; i++) {
    const floor = smooth[i];
    if (floor > 80 || floor > smooth[i - 1] || floor > smooth[i + 1]) continue;
    let gold = 0;
    let yellow = 0;
    for (let k = i - 40; k < i; k++) if (smooth[k] > gold) gold = smooth[k];
    for (let k = i + 1; k < Math.min(smooth.length, i + 40); k++) if (smooth[k] > yellow) yellow = smooth[k];
    if (gold < floor + 90 || yellow < floor + 90) continue;
    best = Math.max(best, (Math.min(gold, yellow) - floor) / 255);
  }
  return best;
}

function smoothColumns(gray, width, y1, y2) {
  const cols = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = y1; y < y2; y++) sum += gray[y * width + x];
    cols[x] = sum / (y2 - y1);
  }
  const smooth = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= width) continue;
      sum += cols[j];
      n += 1;
    }
    smooth[i] = sum / n;
  }
  return smooth;
}

function yellowInnerEdge(smooth, width) {
  let inner = null;
  // A rectified card fills the frame, so the yellow border is in the last
  // columns. Starting at 98% walks past that border and into the artwork.
  for (let x = width - 1; x > Math.floor(0.50 * width); x--) {
    if (smooth[x] > 170) inner = x;
    else if (inner != null && smooth[x] < 150) break;
  }
  return inner;
}

function bandHasValley(smooth, width, inner) {
  const start = Math.max(1, inner - 32);
  for (let x = start + 1; x < inner - 1; x++) {
    const floor = smooth[x];
    if (floor > smooth[x - 1] || floor > smooth[x + 1] || floor >= 124) continue;
    let left = 0;
    for (let i = start; i < x; i++) if (smooth[i] > left) left = smooth[i];
    if (left >= floor + 40 && smooth[inner] >= floor + 50) return true;
  }
  return false;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Base Set edition from the drop shadow just outside the art frame.
 * Shadowless is the yellow border with no dark gap. A tilted photo, where
 * that edge jumps, is left unset.
 * @returns {"shadowless" | "unlimited" | null}
 */
export function borderEdition(gray, width, height) {
  let valleys = 0;
  const edges = [];
  for (let step = 0; step < 7; step++) {
    const yf = 0.16 + step * 0.04;
    const y1 = Math.round(yf * height);
    const y2 = Math.round((yf + 0.08) * height);
    if (y2 <= y1) continue;
    const smooth = smoothColumns(gray, width, y1, y2);
    const inner = yellowInnerEdge(smooth, width);
    if (inner == null) continue;
    edges.push(inner);
    if (bandHasValley(smooth, width, inner)) valleys += 1;
  }
  if (edges.length < 4) return null;
  const mid = median(edges);
  const near = edges.filter((edge) => Math.abs(edge - mid) <= 28);
  if (near.length < 4 || Math.max(...near) - Math.min(...near) > 26) return null;
  if (valleys >= 2) return "unlimited";
  if (valleys === 0) return "shadowless";
  return null;
}
