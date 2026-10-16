// Collector-number reader: RapidOCR PP-OCRv4 text detector + recognizer on the
// bottom strip of a rectified card. Inputs follow RapidOCR: BGR, scaled to [-1, 1].

import { textBoxes, ctcDecode, parseCardNumber } from "./card-number.js";

// The number sits in the bottom 12% of a centered card. A taller strip is the
// fallback when the box runs past the card edge. Small photos need the 3× band.
export const NUMBER_STRIPS = [
  { top: 0.88, scale: 1 },
  { top: 0.8, scale: 1 },
  { top: 0.84, scale: 3 },
];
// Right end of the bottom border, read only after the full-width strips miss.
// A faint number there is lost when the whole width is shrunk to one line.
export const NUMBER_CORNER = { x1: 0.7, y1: 0.855, x2: 0.94, y2: 0.93, scale: 4 };
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
  for (const strip of NUMBER_STRIPS) {
    const read = await readStrip(cardCanvas, strip.top, strip.scale);
    if (read.number) return read;
    texts.push(read.text);
  }
  const corner = NUMBER_CORNER;
  const cornerText = await readRegion(cardCanvas, corner.x1, corner.y1, corner.x2, corner.y2, corner.scale);
  const cornerRead = parseCardNumber(cornerText ? [cornerText] : []);
  if (cornerRead) return { ...cornerRead, text: cornerText };
  return { text: texts.join(" || "), number: null, total: null };
}

// The name is in the top fifth of every layout.
export const NAME_BOX = { x1: 0, y1: 0, x2: 1, y2: 0.2, scale: 2 };
// Between the name and the collector number. Gym ties that lose the name still show this box.
export const RULES_BOX = { x1: 0.04, y1: 0.4, x2: 0.96, y2: 0.82, scale: 2 };

/** The bottom-right corner, where a Wizards promo prints its collector number. */
export async function readCollectorCorner(cardCanvas) {
  if (!numberReaderReady()) return "";
  const box = NUMBER_CORNER;
  return readRegion(cardCanvas, box.x1, box.y1, box.x2, box.y2, box.scale);
}

/** Text across the top of the card, where the name is printed. */
export async function readCardName(cardCanvas) {
  if (!numberReaderReady()) return "";
  const box = NAME_BOX;
  return readRegion(cardCanvas, box.x1, box.y1, box.x2, box.y2, box.scale);
}

/** The attack or trainer box. */
export async function readCardRules(cardCanvas) {
  if (!numberReaderReady()) return "";
  const box = RULES_BOX;
  return readRegion(cardCanvas, box.x1, box.y1, box.x2, box.y2, box.scale);
}

/** Bottom-right of the art. The right edge has to clear the Platinum box. */
export const ART_STAMP_BOX = { x1: 0.62, y1: 0.36, x2: 0.97, y2: 0.54, scale: 4 };

/** Text in the bottom-right of the art, where an ex-era set stamp is printed. */
export async function readArtStamp(cardCanvas) {
  if (!numberReaderReady()) return "";
  const box = ART_STAMP_BOX;
  return readRegion(cardCanvas, box.x1, box.y1, box.x2, box.y2, box.scale);
}

async function readStrip(cardCanvas, stripTop, scale = 1) {
  const top = Math.round(cardCanvas.height * stripTop);
  const srcW = cardCanvas.width;
  const srcH = cardCanvas.height - top;
  const width = Math.max(32, Math.round((srcW * scale) / 32) * 32);
  const height = Math.max(32, Math.round((srcH * scale) / 32) * 32);
  const strip = new OffscreenCanvas(width, height);
  const ctx = strip.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cardCanvas, 0, top, srcW, srcH, 0, 0, width, height);

  const output = await _det.run({ [_det.inputNames[0]]: toTensor(ctx, width, height) });
  const boxes = textBoxes(output[_det.outputNames[0]].data, width, height);
  const lines = boxes
    .filter((box) => (box.x2 - box.x1) >= MIN_LINE_ASPECT * (box.y2 - box.y1))
    .sort((a, b) => b.y2 - a.y2)
    .slice(0, MAX_LINES);
  const texts = [];
  let found = null;
  for (const box of lines) {
    texts.push(await readLine(strip, box));
    if (!found) found = parseCardNumber(texts.slice(-1));
  }
  const text = texts.join(" | ");
  if (found) return { ...found, text };
  return { text: `${text} (${lines.length} of ${boxes.length} boxes)`, number: null, total: null };
}

async function readRegion(cardCanvas, x1, y1, x2, y2, scale) {
  const srcX = Math.round(cardCanvas.width * x1);
  const srcY = Math.round(cardCanvas.height * y1);
  const srcW = Math.max(1, Math.round(cardCanvas.width * x2) - srcX);
  const srcH = Math.max(1, Math.round(cardCanvas.height * y2) - srcY);
  const width = Math.max(32, Math.round((srcW * scale) / 32) * 32);
  const height = Math.max(32, Math.round((srcH * scale) / 32) * 32);
  const strip = new OffscreenCanvas(width, height);
  const ctx = strip.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cardCanvas, srcX, srcY, srcW, srcH, 0, 0, width, height);
  const output = await _det.run({ [_det.inputNames[0]]: toTensor(ctx, width, height) });
  const boxes = textBoxes(output[_det.outputNames[0]].data, width, height);
  const lines = boxes
    .filter((box) => (box.x2 - box.x1) >= (box.y2 - box.y1))
    .sort((a, b) => a.y1 - b.y1)
    .slice(0, MAX_LINES);
  const texts = [];
  for (const box of lines) texts.push(await readLine(strip, box));
  return texts.join(" ");
}
