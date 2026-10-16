// A test photo is the picture the detector ran on plus the boxes it drew, saved so a person can
// label the cards later. It holds no identity, price or confidence, so the scanner's guesses
// cannot leak into the labels.

import { pageUrlForStorage } from "./card-picker.js";

export const MAX_SIDE = 2000;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,/;

export function fitWithin(width, height, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

function webPage(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) ? hostname : null;
  } catch {
    return null;
  }
}

/** `boxes` are in the detector's pixels; `scale` is stored size over detector size. */
export function photoRecord({ id, ts, pageUrl, photo, boxes, scale }) {
  if (typeof id !== "string" || !id) throw new Error("test photo needs an id");
  if (typeof photo !== "string" || !JPEG_DATA_URL.test(photo)) throw new Error("test photo must be a JPEG data URL");
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("test photo needs a positive scale");
  if (!Array.isArray(boxes) || !boxes.every((box) => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite))) {
    throw new Error("test photo boxes must each be [x1, y1, x2, y2]");
  }
  const host = webPage(pageUrl);
  return {
    id,
    ts: Number(ts),
    pageUrl: host ? pageUrlForStorage(pageUrl) : null,
    host,
    photo,
    boxes: boxes.map((box) => box.map((value) => Math.round(value * scale))),
  };
}

export const LIMITS = { photos: 500, bytes: 400 * 1024 * 1024 };

// The size rides in the id, so the total is known from the keys without reading a single photo.
export const idWithSize = (hash, bytes) => `${hash}.${bytes}`;

export function statsFromIds(ids) {
  let bytes = 0;
  for (const id of ids) {
    const size = Number(String(id).match(/\.(\d+)$/)?.[1]);
    if (Number.isFinite(size)) bytes += size;
  }
  return { count: ids.length, bytes };
}

export const limitReached = ({ count, bytes }) => count >= LIMITS.photos || bytes >= LIMITS.bytes;

export function describeSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${Number(mb.toFixed(mb < 10 ? 1 : 0))} MB`;
}
