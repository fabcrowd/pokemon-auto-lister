// Collector-number reader: RapidOCR PP-OCRv4 text detector + recognizer on the
// bottom strip of a rectified card. Inputs follow RapidOCR: BGR, scaled to [-1, 1].

import { textBoxes, ctcDecode, parseCardNumber } from "./card-number.js";

// The number sits in the bottom 12% of every layout; detector boxes that run
// past the card's edge push it higher, so a taller strip is the fallback.
const STRIP_TOPS = [0.88, 0.8];
const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
const MIN_LINE_ASPECT = 2;  // "88/132" is wide; single symbols are not
const MAX_LINES = 12;

let _det = null;
let _rec = null;

export async function loadNumberReader(detBuffer, recBuffer) {
  const options = { executionProviders: ["wasm"] };
  _det = await globalThis.ort.InferenceSession.create(detBuffer, options);
  _rec = await globalThis.ort.InferenceSession.create(recBuffer, options);
}

export function numberReaderReady() {
  return Boolean(_det && _rec);
}

function toTensor(ctx, width, height, tensorWidth = width) {
  const { data } = ctx.getImageData(0, 0, width, height);
  const plane = height * tensorWidth;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * tensorWidth + x;
      out[dst] = data[src + 2] / 127.5 - 1;
      out[plane + dst] = data[src + 1] / 127.5 - 1;
      out[2 * plane + dst] = data[src] / 127.5 - 1;
    }
  }
  return new globalThis.ort.Tensor("float32", out, [1, 3, height, tensorWidth]);
}

async function readLine(strip, box) {
  const width = box.x2 - box.x1;
  const height = box.y2 - box.y1;
  const lineWidth = Math.ceil((REC_HEIGHT * width) / height);
  const tensorWidth = Math.max(REC_MIN_WIDTH, lineWidth);
  const canvas = new OffscreenCanvas(lineWidth, REC_HEIGHT);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(strip, box.x1, box.y1, width, height, 0, 0, lineWidth, REC_HEIGHT);
  const output = await _rec.run({ [_rec.inputNames[0]]: toTensor(ctx, lineWidth, REC_HEIGHT, tensorWidth) });
  const probs = output[_rec.outputNames[0]];
  const [, steps, classes] = probs.dims;
  return ctcDecode(probs.data, steps, classes);
}

/** Read the bottom of a rectified card: {text, number, total}, number null when unread. */
export async function readCardNumber(cardCanvas) {
  if (!numberReaderReady()) return null;
  const texts = [];
  for (const stripTop of STRIP_TOPS) {
    const read = await readStrip(cardCanvas, stripTop);
    if (read.number) return read;
    texts.push(read.text);
  }
  return { text: texts.join(" || "), number: null, total: null };
}

async function readStrip(cardCanvas, stripTop) {
  const top = Math.round(cardCanvas.height * stripTop);
  const width = Math.max(32, Math.round(cardCanvas.width / 32) * 32);
  const height = Math.max(32, Math.round((cardCanvas.height - top) / 32) * 32);
  const strip = new OffscreenCanvas(width, height);
  const ctx = strip.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cardCanvas, 0, top, cardCanvas.width, cardCanvas.height - top, 0, 0, width, height);

  const output = await _det.run({ [_det.inputNames[0]]: toTensor(ctx, width, height) });
  const boxes = textBoxes(output[_det.outputNames[0]].data, width, height);
  const lines = boxes
    .filter((box) => (box.x2 - box.x1) >= MIN_LINE_ASPECT * (box.y2 - box.y1))
    .sort((a, b) => b.y2 - a.y2)
    .slice(0, MAX_LINES);
  const texts = [];
  for (const box of lines) {
    texts.push(await readLine(strip, box));
    const read = parseCardNumber(texts.slice(-1));
    if (read) return { ...read, text: texts.join(" | ") };
  }
  return { text: `${texts.join(" | ")} (${lines.length} of ${boxes.length} boxes)`, number: null, total: null };
}
