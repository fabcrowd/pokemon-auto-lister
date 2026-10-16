// Runs the trained variant classifier. The service worker loads ort first.

import {
  EDITIONS, STAMPS, VARIANT_W, VARIANT_H, VARIANT_FULL, VARIANT_ZOOM,
  FINISHES, confidentClass, variantTensor,
} from "./variant.js";

let _session = null;

export function variantModelReady() {
  return _session != null;
}

export async function loadVariantModel(buffer) {
  _session = await globalThis.ort.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
}

/** Edition, finish, and promo stamp the photo supports. An unsure head is null. */
export async function readVariant(cardCanvas) {
  if (!_session) return null;
  const small = new OffscreenCanvas(VARIANT_W, VARIANT_H);
  const ctx = small.getContext("2d", { willReadFrequently: true });
  const width = cardCanvas.width;
  const height = cardCanvas.height;
  ctx.drawImage(cardCanvas, 0, 0, VARIANT_W, VARIANT_FULL);
  const stampTop = Math.floor(0.30 * height);
  const borderTop = Math.floor(0.15 * height);
  ctx.drawImage(
    cardCanvas,
    0, stampTop, Math.floor(0.38 * width), Math.floor(0.70 * height) - stampTop,
    0, VARIANT_FULL, VARIANT_ZOOM, VARIANT_ZOOM,
  );
  ctx.drawImage(
    cardCanvas,
    Math.floor(0.68 * width), borderTop, width - Math.floor(0.68 * width), Math.floor(0.45 * height) - borderTop,
    VARIANT_ZOOM, VARIANT_FULL, VARIANT_ZOOM, VARIANT_ZOOM,
  );
  const { data } = ctx.getImageData(0, 0, VARIANT_W, VARIANT_H);
  const image = new globalThis.ort.Tensor(
    "float32",
    variantTensor(data, VARIANT_W, VARIANT_H),
    [1, 3, VARIANT_H, VARIANT_W],
  );
  const out = await _session.run({ image });
  return {
    edition: confidentClass(Array.from(out.edition.data), EDITIONS),
    finish: confidentClass(Array.from(out.finish.data), FINISHES),
    stamp: confidentClass(Array.from(out.stamp.data), STAMPS),
  };
}
