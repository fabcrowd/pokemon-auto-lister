// A photo's id is a 64-bit difference hash of its pixels, so the same photo has the same id for every
// user at any size. Photos whose id falls in the exam split are never learned from (see docs/plans/shared-learning.md).

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
  return bits.toString(16).padStart(16, "0");
}

/**
 * Average luma of each of 9x8 equal cells. Averaging every source pixel, not sampling, keeps the
 * result the same when the same picture arrives at another size.
 */
export function grayGrid({ data, width, height }) {
  const sums = new Float64Array(COLS * ROWS);
  const counts = new Uint32Array(COLS * ROWS);
  for (let y = 0; y < height; y++) {
    const rowBase = Math.min(ROWS - 1, Math.floor((y * ROWS) / height)) * COLS;
    for (let x = 0; x < width; x++) {
      const cell = rowBase + Math.min(COLS - 1, Math.floor((x * COLS) / width));
      const at = (y * width + x) * 4;
      sums[cell] += 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
      counts[cell] += 1;
    }
  }
  return Uint8Array.from(sums, (sum, cell) => Math.round(sum / counts[cell]));
}

/** @param image { data: RGBA bytes, width, height } as ImageData */
export function photoIdFromRgba(image) {
  if (image.width < COLS || image.height < ROWS) throw new Error("photo is too small to hash");
  return dhashFromGray(grayGrid(image));
}

/** "exam" for one photo in five: the low 32 bits of the id, mod 5. The relay checks the same rule. */
export function splitOf(photoId) {
  if (!/^[0-9a-f]{16}$/.test(photoId)) throw new Error("photoId must be 16 lowercase hex digits");
  return parseInt(photoId.slice(-8), 16) % 5 === 0 ? "exam" : "teach";
}
