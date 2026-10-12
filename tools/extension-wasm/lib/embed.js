// CLIP ViT-B-32 visual embedding via onnxruntime-web.
// Uses globalThis.ort set by background.js before any of these functions run.

// IMAGENET normalisation constants
const MEAN = [0.48145466, 0.4578275,  0.40821073];
const STD  = [0.26862954, 0.26130258, 0.27577711];

const CLIP_SIZE = 224;
// Upper fraction of the card to use as the art crop
const ART_CROP_FRAC = 0.45;

let _session = null;

export async function loadEmbedder(modelBuffer) {
  _session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ["wasm"],
  });
}

/**
 * Compute a L2-normalised CLIP embedding for a card OffscreenCanvas.
 * Returns Float32Array of length 512.
 */
export async function embedCard(cardCanvas) {
  if (!_session) throw new Error("Embedder not loaded");

  const artCanvas = cropArt(cardCanvas);
  const tensor    = canvasToTensor(artCanvas);

  const feeds   = { pixel_values: tensor };
  const results = await _session.run(feeds);
  const key     = Object.keys(results)[0];
  const raw     = results[key].data; // Float32Array [512]

  return l2Normalize(raw);
}

// --- helpers ---

function cropArt(src) {
  const cropH = Math.round(src.height * ART_CROP_FRAC);
  const out   = new OffscreenCanvas(CLIP_SIZE, CLIP_SIZE);
  const ctx   = out.getContext("2d", { willReadFrequently: true });
  // Draw only the upper ART_CROP_FRAC of the card, scaled to 224×224
  ctx.drawImage(src, 0, 0, src.width, cropH, 0, 0, CLIP_SIZE, CLIP_SIZE);
  return out;
}

function canvasToTensor(canvas) {
  const ctx       = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, CLIP_SIZE, CLIP_SIZE);
  const data      = imageData.data; // RGBA uint8
  const planeSize = CLIP_SIZE * CLIP_SIZE;
  const tensor    = new Float32Array(3 * planeSize);

  for (let i = 0; i < planeSize; i++) {
    tensor[i]                 = (data[i * 4]     / 255 - MEAN[0]) / STD[0]; // R
    tensor[planeSize + i]     = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1]; // G
    tensor[planeSize * 2 + i] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2]; // B
  }

  return new ort.Tensor("float32", tensor, [1, 3, CLIP_SIZE, CLIP_SIZE]);
}

function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}
