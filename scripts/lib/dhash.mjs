import sharp from 'sharp';

// Refuses decompression bombs: a small file can claim a huge picture.
export const MAX_PIXELS = 50e6;

const COLS = 9;
const ROWS = 8;

/** 64-bit difference hash as 16 hex digits: one bit per pixel brighter than its right neighbour. */
export function dhashFromGray(gray) {
  if (gray.length !== COLS * ROWS) throw new Error(`dHash needs ${COLS * ROWS} gray pixels`);
  let bits = 0n;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS - 1; col++) {
      bits = (bits << 1n) | (gray[row * COLS + col] > gray[row * COLS + col + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

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
