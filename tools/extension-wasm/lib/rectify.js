// Crop a detected card box from the source bitmap → 750×1050 OffscreenCanvas.

const OUT_W = 750;
const OUT_H = 1050;

/**
 * Crop the detected card region from sourceCanvas (or ImageBitmap) and
 * return a 750×1050 OffscreenCanvas normalised for downstream embedding.
 */
export function rectifyCard(source, box) {
  const [x1, y1, x2, y2] = box;
  const srcX = Math.max(0, Math.round(x1));
  const srcY = Math.max(0, Math.round(y1));
  const srcW = Math.round(x2) - srcX;
  const srcH = Math.round(y2) - srcY;

  const out = new OffscreenCanvas(OUT_W, OUT_H);
  if (srcW <= 0 || srcH <= 0) return out; // degenerate box — return blank canvas
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, OUT_W, OUT_H);
  return out;
}
