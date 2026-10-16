// Limits for reading a page's photo from the network: how many bytes, how long, how big once decoded,
// and where a redirect may end. Pure so the background can stay a thin caller.

import { publicHttpsUrl } from "./net.js";

export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const MAX_PHOTO_SIDE = 10000;
const HEAD_BYTES = 256 * 1024;

/** Time left for everything one photo may spend on the network. */
export function createBudget(totalMs, now = () => Date.now()) {
  const start = now();
  return { remaining: () => Math.max(0, totalMs - (now() - start)) };
}

/** The URL a fetch really ended on, if it is public https and (when a list is given) on a host the page loaded images from. */
export function finalUrlAllowed(responseUrl, allowedHosts = null) {
  const url = publicHttpsUrl(responseUrl);
  if (!url) return null;
  if (allowedHosts && !allowedHosts.has(url.hostname.toLowerCase())) return null;
  return url;
}

/**
 * The body as a Blob, read in pieces so a response that lies about (or omits) its length is cut off at
 * maxBytes. `head` is the first bytes, enough to read the picture's size from. null when over the cap.
 */
export async function readCapped(response, maxBytes = MAX_PHOTO_BYTES, headBytes = HEAD_BYTES) {
  const type = response.headers.get("content-type") || "";
  const reader = response.body?.getReader?.();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > maxBytes) return null;
    return { blob, head: new Uint8Array(await blob.slice(0, headBytes).arrayBuffer()) };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const head = new Uint8Array(Math.min(total, headBytes));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= head.length) break;
    const part = chunk.subarray(0, head.length - at);
    head.set(part, at);
    at += part.length;
  }
  return { blob: new Blob(chunks, { type }), head };
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

function jpegSize(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return null;
    const length = u16be(b, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const kind = ascii(b, 12, 4);
  if (kind === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  if (kind === "VP8L") {
    return {
      width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
      height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
    };
  }
  if (kind === "VP8X") {
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

/** Pixel size declared in the file header of a PNG, JPEG, GIF or WebP; null for anything else or a header that is cut short. */
export function imageSize(bytes) {
  const b = bytes;
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { width: u32be(b, 16), height: u32be(b, 20) };
  if (ascii(b, 0, 3) === "GIF") return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webpSize(b);
  return null;
}

/**
 * What to ask the decoder for. `reject` when the declared size is beyond MAX_PHOTO_SIDE, otherwise the one axis
 * to shrink to maxSide so the full picture is never decoded. One axis only: the other follows the aspect ratio,
 * and a rotated JPEG's width and height are not what the header says.
 */
export function decodePlan(size, maxSide = 0) {
  if (!size || !(size.width > 0 && size.height > 0)) return { known: false };
  if (size.width > MAX_PHOTO_SIDE || size.height > MAX_PHOTO_SIDE) return { known: true, reject: true };
  const long = Math.max(size.width, size.height);
  if (!(maxSide > 0 && long > maxSide)) return { known: true };
  const factor = maxSide / long;
  return size.width >= size.height
    ? { known: true, resize: { resizeWidth: Math.max(1, Math.round(size.width * factor)), resizeQuality: "high" } }
    : { known: true, resize: { resizeHeight: Math.max(1, Math.round(size.height * factor)), resizeQuality: "high" } };
}
