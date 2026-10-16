import sharp from 'sharp';

// Refuses decompression bombs: a small file can claim a huge picture.
export const MAX_PIXELS = 50e6;

// The hash itself lives in the extension, so the scripts and the shipped code cannot drift apart.
export { dhashFromGray } from '../../tools/extension-wasm/lib/photo-id.js';
import { dhashFromGray } from '../../tools/extension-wasm/lib/photo-id.js';

const COLS = 9;
const ROWS = 8;

export function hamming(a, b) {
  if (a.length !== b.length) throw new Error('hash length differs');
  let differing = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (differing) {
    count += Number(differing & 1n);
    differing >>= 1n;
  }
  return count;
}

/** Closest hash within `limit` bits, or null. */
export function nearestWithin(hashes, hash, limit) {
  let best = null;
  hashes.forEach((other, index) => {
    const distance = hamming(hash, other);
    if (distance <= limit && (!best || distance < best.distance)) best = { index, distance };
  });
  return best;
}

/** Hash an image buffer, or a pixel box [x1, y1, x2, y2] of it, optionally turned by 90, 180 or 270 degrees first. */
export async function dhashImage(buffer, box = null, turn = 0) {
  let image = sharp(buffer, { limitInputPixels: MAX_PIXELS });
  if (box) {
    const { width, height } = await image.metadata();
    const left = Math.max(0, Math.min(width - 1, Math.floor(box[0])));
    const top = Math.max(0, Math.min(height - 1, Math.floor(box[1])));
    image = image.extract({
      left,
      top,
      width: Math.max(1, Math.min(width - left, Math.ceil(box[2]) - left)),
      height: Math.max(1, Math.min(height - top, Math.ceil(box[3]) - top)),
    });
  }
  // Turned after the cut, in its own pass: sharp would otherwise turn first and cut a different box.
  if (turn) image = sharp(await image.toBuffer()).rotate(turn);
  const gray = await image.greyscale().resize(COLS, ROWS, { fit: 'fill' }).raw().toBuffer();
  return dhashFromGray(gray);
}
