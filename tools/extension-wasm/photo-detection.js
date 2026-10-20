const CARD_RATIO_MIN = 0.55;
const CARD_RATIO_MAX = 0.95;
const BOX_RATIO_MAX = 1.82;
const MAX_PHOTO_AREA_FRACTION = 0.65;

/**
 * One window: an upright card, or one tilted up to 45 degrees or lying sideways, whose box is up to
 * 1/0.55 wide. Boxes near 1.0 are tilted cards, so there is no gap there.
 */
export function isCardShaped(ratio) {
  return ratio >= CARD_RATIO_MIN && ratio <= BOX_RATIO_MAX;
}

export function imageToViewportTransform(rect, imageWidth, imageHeight, render = {}) {
  if (!rect || imageWidth <= 0 || imageHeight <= 0) return null;
  const fit = render.fit || "fill";
  const containScale = Math.min(rect.w / imageWidth, rect.h / imageHeight);
  const coverScale = Math.max(rect.w / imageWidth, rect.h / imageHeight);

  let scaleX;
  let scaleY;
  if (fit === "background") {
    const scale = backgroundScale(render.size, imageWidth, imageHeight, rect, containScale, coverScale);
    if (!scale) return null;
    [scaleX, scaleY] = scale;
  } else if (fit === "contain" || fit === "cover" || fit === "scale-down") {
    const scale = fit === "cover" ? coverScale : fit === "scale-down" ? Math.min(1, containScale) : containScale;
    scaleX = scale;
    scaleY = scale;
  } else if (fit === "none") {
    scaleX = 1;
    scaleY = 1;
  } else {
    scaleX = rect.w / imageWidth;
    scaleY = rect.h / imageHeight;
  }

  const position = parsePosition(render.position);
  if (!position) return null;
  const [positionX, positionY] = position;
  const displayWidth = imageWidth * scaleX;
  const displayHeight = imageHeight * scaleY;
  return {
    left: rect.x + (rect.w - displayWidth) * positionX,
    top: rect.y + (rect.h - displayHeight) * positionY,
    scaleX,
    scaleY,
  };
}

/**
 * The same placement for a picture of other pixel dimensions: pass natural/actual for each axis, so a box in
 * the larger image's pixels still lands where the displayed image's pixels put it.
 */
export function rescaleTransform(transform, factorX, factorY) {
  if (!transform || !(factorX > 0) || !(factorY > 0)) return null;
  return { ...transform, scaleX: transform.scaleX * factorX, scaleY: transform.scaleY * factorY };
}

export function mapPhotoBoxToViewport(box, transform, clipRect = null) {
  if (!Array.isArray(box) || box.length !== 4 || !transform) return null;
  let [x1, y1, x2, y2] = box;
  x1 = transform.left + x1 * transform.scaleX;
  x2 = transform.left + x2 * transform.scaleX;
  y1 = transform.top + y1 * transform.scaleY;
  y2 = transform.top + y2 * transform.scaleY;
  if (clipRect) {
    x1 = Math.max(clipRect.x, x1);
    y1 = Math.max(clipRect.y, y1);
    x2 = Math.min(clipRect.x + clipRect.w, x2);
    y2 = Math.min(clipRect.y + clipRect.h, y2);
  }
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function backgroundScale(size, imageWidth, imageHeight, rect, containScale, coverScale) {
  const value = String(size || "auto").trim().toLowerCase();
  if (value === "cover") return [coverScale, coverScale];
  if (value === "contain") return [containScale, containScale];
  const tokens = value.split(/\s+/);
  if (tokens.length > 2) return null;
  if (tokens.some((token) => token !== "auto" && !/^-?\d+(?:\.\d+)?(?:%|px)$/.test(token))) return null;
  const parseLength = (token, axis) => {
    if (!token || token === "auto") return null;
    const percent = token.match(/^(-?\d+(?:\.\d+)?)%$/);
    if (percent) return (axis === "x" ? rect.w : rect.h) * Number(percent[1]) / 100;
    const pixels = token.match(/^(\d+(?:\.\d+)?)px$/);
    if (pixels) return Number(pixels[1]);
    return null;
  };
  const width = parseLength(tokens[0], "x");
  const height = parseLength(tokens[1], "y");
  if (width !== null && height !== null) return [width / imageWidth, height / imageHeight];
  if (width !== null) return [width / imageWidth, width / imageWidth];
  if (height !== null) return [height / imageHeight, height / imageHeight];
  if (tokens.every((token) => token === "auto")) return [1, 1];
  return null;
}

function parsePosition(position = "50% 50%") {
  const words = String(position).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [0.5, 0.5];
  if (words.length > 2) return null;
  if (words.length === 1) {
    if (words[0] === "top" || words[0] === "bottom") words.unshift("center");
    else words.push("center");
  }
  const fraction = (token) => {
    if (token === "center") return 0.5;
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return 1;
    const percent = token.match(/^(-?\d+(?:\.\d+)?)%$/);
    return percent ? Number(percent[1]) / 100 : null;
  };
  let [x, y] = words;
  if ((x === "top" || x === "bottom") && (y === "left" || y === "right")) [x, y] = [y, x];
  const fx = fraction(x);
  const fy = fraction(y);
  return fx === null || fy === null ? null : [fx, fy];
}

function rowKind(pixels, width, x1, x2, y) {
  const left = Math.max(0, Math.round(x1 + (x2 - x1) * 0.3));
  const right = Math.min(width - 1, Math.round(x1 + (x2 - x1) * 0.7));
  let yellow = 0;
  let white = 0;
  let count = 0;
  for (let x = left; x <= right; x++) {
    const i = (y * width + x) * 4;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    count++;
    if (r > 170 && g > 150 && b < 150 && r > b + 40) yellow++;
    else if (r > 200 && g > 200 && b > 200) white++;
  }
  if (!count) return "other";
  if (yellow / count >= 0.6) return "yellow";
  if (white / count >= 0.6) return "white";
  return "other";
}

/**
 * A box that stops inside the yellow border clips the collector number and
 * stretches the stamp. Follow that border, and only a thin white edge after it.
 */
export function extendClippedBottom(pixels, width, height, box) {
  if (!pixels || width <= 0 || height <= 0 || !Array.isArray(box) || box.length !== 4) return box;
  const [x1, y1, x2, y2] = box;
  const bottom = Math.min(height - 1, Math.round(y2) - 1);
  if (!(y2 > y1) || bottom < 1 || rowKind(pixels, width, x1, x2, bottom) !== "yellow") return box;
  const limit = Math.min(height - 1, bottom + Math.round((y2 - y1) * 0.08));
  const maxWhite = Math.max(1, Math.round((y2 - y1) * 0.025));
  let edge = bottom;
  let whiteRun = 0;
  let blend = 0;
  for (let y = bottom + 1; y <= limit; y++) {
    const kind = rowKind(pixels, width, x1, x2, y);
    if (kind === "yellow") {
      whiteRun = 0;
      blend = 0;
      edge = y;
      continue;
    }
    if (kind === "white" && whiteRun < maxWhite) {
      whiteRun += 1;
      blend = 0;
      edge = y;
      continue;
    }
    // The yellow border fades into the white edge across a couple of rows.
    if (kind === "other" && whiteRun === 0 && blend < 3) {
      blend += 1;
      continue;
    }
    break;
  }
  return edge === bottom ? box : [x1, y1, x2, edge + 1];
}

export function filterPhotoDetections(detections, imageWidth, imageHeight) {
  if (!Array.isArray(detections) || imageWidth <= 0 || imageHeight <= 0) return [];

  const imageArea = imageWidth * imageHeight;
  return detections.filter(({ box }) => {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return false;

    const [x1, y1, x2, y2] = box;
    const width = x2 - x1;
    const height = y2 - y1;
    if (width <= 0 || height <= 0) return false;

    const ratio = width / height;
    const areaFraction = (width * height) / imageArea;
    return isCardShaped(ratio) && areaFraction <= MAX_PHOTO_AREA_FRACTION;
  });
}

// A box this close to the photo edge (fraction of the photo side, at least 2 px) is cut by that edge.
const EDGE_TOUCH_FRACTION = 0.004;
// A cut box whose side across the edge is under this share of the same side of the photo's whole cards
// is a piece of a card. Measured on 11 Facebook Marketplace photos (2026-10-19): of 27 card-shaped boxes at
// an edge, the 15 whole cards had a cut side 0.83 or more of the median; the 12 pieces (half cards cut at
// the top or bottom, corners) had 0.09 to 0.63.
export const EDGE_FRAGMENT_SHARE = 0.7;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Drop boxes that are pieces of cards cut off by the photo edge. A box is a piece when it touches an
 * edge and its side across that edge is well short of the cards wholly inside the photo. With fewer than
 * two whole cards to compare against, nothing is dropped: a lone card may fill the frame.
 */
export function dropEdgeFragments(boxes, imageWidth, imageHeight) {
  if (!Array.isArray(boxes) || !(imageWidth > 0) || !(imageHeight > 0)) return boxes;
  const marginX = Math.max(2, imageWidth * EDGE_TOUCH_FRACTION);
  const marginY = Math.max(2, imageHeight * EDGE_TOUCH_FRACTION);
  const edges = ({ box: [x1, y1, x2, y2] }) => ({
    across: x1 <= marginX || x2 >= imageWidth - marginX,
    down: y1 <= marginY || y2 >= imageHeight - marginY,
  });
  const inside = boxes.filter((b) => { const e = edges(b); return !e.across && !e.down; });
  if (inside.length < 2) return boxes;
  const medianW = median(inside.map(({ box }) => box[2] - box[0]));
  const medianH = median(inside.map(({ box }) => box[3] - box[1]));
  return boxes.filter((b) => {
    const { across, down } = edges(b);
    const [x1, y1, x2, y2] = b.box;
    if (across && x2 - x1 < medianW * EDGE_FRAGMENT_SHARE) return false;
    if (down && y2 - y1 < medianH * EDGE_FRAGMENT_SHARE) return false;
    return true;
  });
}

// Zoomed centre crops tried when the detector sees nothing in a card-shaped hero photo.
const HERO_ZOOMS = [1, 0.8, 0.65];
// A whole-photo read that abstained is kept (as a guess for the picker) only when the catalog at
// least resembles it; below this the photo is a lot, a binder or a product shot, not one card.
export const WHOLE_PHOTO_MIN_SIMILARITY = 0.6;

/**
 * What to do with the listing's main photo, given the raw detector output. The size filter
 * above exists to stop a binder or lot photo from becoming one "card"; for the photo the
 * listing is built around, a card-shaped box that fills the frame is the card.
 *
 * @returns {{kind: 'detected'} | {kind: 'large-box', box: number[], score: number}
 *   | {kind: 'whole-photo', crops: number[][]} | {kind: 'none'}}
 */
export function planHeroCard({ imageW, imageH, detections }) {
  if (!(imageW > 0) || !(imageH > 0)) return { kind: 'none' };
  const found = Array.isArray(detections) ? detections : [];
  if (filterPhotoDetections(found, imageW, imageH).length) return { kind: 'detected' };

  let best = null;
  for (const detection of found) {
    const { box, score } = detection || {};
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) continue;
    const width = box[2] - box[0];
    const height = box[3] - box[1];
    if (width <= 0 || height <= 0) continue;
    const ratio = width / height;
    if (!isCardShaped(ratio)) continue;
    if (!best || score > best.score) best = { box, score };
  }
  if (best) return { kind: 'large-box', box: best.box, score: best.score };

  // Boxes that were not card-shaped mean the detector saw something else (a lot, a binder).
  const ratio = imageW / imageH;
  if (found.length) return { kind: 'none' };
  if (ratio >= CARD_RATIO_MIN && ratio <= CARD_RATIO_MAX) {
    return { kind: 'whole-photo', strict: false, crops: HERO_ZOOMS.map((zoom) => centredCrop(imageW, imageH, zoom)) };
  }
  // A square slot (or a cover-cropped view) around one card: the card is in the middle, so look there.
  if (ratio > CARD_RATIO_MAX && ratio <= SQUARISH_MAX) {
    return { kind: 'whole-photo', strict: true, crops: HERO_ZOOMS.map((zoom) => cardShapedCrop(imageW, imageH, zoom)) };
  }
  return { kind: 'none' };
}

const SQUARISH_MAX = 1.25;
const CARD_RATIO = 5 / 7;

function cardShapedCrop(width, height, zoom) {
  const h = Math.round(Math.min(height, width / CARD_RATIO) * zoom);
  const w = Math.round(h * CARD_RATIO);
  const x = Math.round((width - w) / 2);
  const y = Math.round((height - h) / 2);
  return [x, y, x + w, y + h];
}

function centredCrop(width, height, zoom) {
  const w = Math.round(width * zoom);
  const h = Math.round(height * zoom);
  const x = Math.round((width - w) / 2);
  const y = Math.round((height - h) / 2);
  return [x, y, x + w, y + h];
}

/** Keep a whole-photo read only if it named a card or the catalog saw something card-like in it. */
export function acceptWholePhoto(read, { strict = false, croppedView = false } = {}) {
  if (!read || read.cardBack) return false;
  if (!read.abstain && read.identity) return true;
  // A view cropped by its slot (object-fit: cover, screenshot) cuts card edges, so a look-alike
  // without a name is still a fair suggestion for the picker.
  if (strict && !croppedView) return false;
  return Number(read.catalogTop) >= WHOLE_PHOTO_MIN_SIMILARITY;
}

/**
 * Where the picture itself sits inside a screenshot crop of its slot, in device pixels relative to the
 * crop. A square slot around a portrait card is mostly bars; the detector and the card-shape check
 * should see the picture only. Null when the crop already is the picture or the layout is unknown.
 */
export function displayedRegion(rect, naturalWidth, naturalHeight, render, dpr) {
  if (!rect || !(naturalWidth > 0) || !(naturalHeight > 0) || !(dpr > 0)) return null;
  if (Math.abs(rect.vw - rect.w) > 1 || Math.abs(rect.vh - rect.h) > 1) return null;
  const transform = imageToViewportTransform(rect, naturalWidth, naturalHeight, render || {});
  if (!transform) return null;
  const x1 = Math.max(0, (transform.left - rect.vx) * dpr);
  const y1 = Math.max(0, (transform.top - rect.vy) * dpr);
  const x2 = Math.min(rect.vw * dpr, (transform.left - rect.vx + naturalWidth * transform.scaleX) * dpr);
  const y2 = Math.min(rect.vh * dpr, (transform.top - rect.vy + naturalHeight * transform.scaleY) * dpr);
  const region = { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
  if (region.w < 20 || region.h < 20) return null;
  const whole = (rect.vw * dpr * rect.vh * dpr);
  if (region.w * region.h >= whole * 0.97) return null;
  return region;
}

const TILE_OVERLAP = 0.3;
const NMS_IOU = 0.45;
// A tile that cuts a card in half still lights the detector a little; real cards score well above this.
const TILE_MIN_SCORE = 0.5;

/** n x n overlapping tiles [x1, y1, x2, y2] that cover a width x height photo. */
export function tileRects(width, height, n, overlap = TILE_OVERLAP) {
  const span = n - (n - 1) * overlap;
  const tileW = width / span;
  const tileH = height / span;
  const rects = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x1 = Math.round(col * tileW * (1 - overlap));
      const y1 = Math.round(row * tileH * (1 - overlap));
      rects.push([x1, y1, Math.min(width, Math.round(x1 + tileW)), Math.min(height, Math.round(y1 + tileH))]);
    }
  }
  return rects;
}

function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

/**
 * Card boxes found by running the detector on tiles of a photo, in photo coordinates. Each tile's boxes
 * go through the same card-shape filter as a whole photo; a card seen in two overlapping tiles is one box.
 *
 * @param {{rect: number[], detections: {box: number[], score: number}[]}[]} tiles
 */
export function mergeTileDetections(tiles, { minScore = TILE_MIN_SCORE } = {}) {
  const all = [];
  for (const { rect, detections } of tiles) {
    const kept = filterPhotoDetections(detections, rect[2] - rect[0], rect[3] - rect[1]);
    for (const { box, score } of kept) {
      if (score < minScore) continue;
      all.push({ box: [box[0] + rect[0], box[1] + rect[1], box[2] + rect[0], box[3] + rect[1]], score });
    }
  }
  all.sort((a, b) => b.score - a.score);
  const out = [];
  for (const item of all) {
    if (out.every((other) => iou(other.box, item.box) <= NMS_IOU)) out.push(item);
  }
  return out;
}
