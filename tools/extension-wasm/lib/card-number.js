// Read the collector number ("88/132") off the bottom of a large card and use it
// to pick the printing. Post-processing for RapidOCR's PP-OCRv4 det/rec models.

import { SET_TOTALS } from "./set-totals.js";

const TEXT_THRESH = 0.3;   // text pixel in the detector map
const BOX_THRESH = 0.5;    // mean score for a box to count as text
const UNCLIP_RATIO = 1.6;
const MIN_SIDE = 3;

// PP-OCRv4 rec classes that are plain ASCII (class 0 is the CTC blank, 6624 a space).
const ASCII_AT = {
  1: "'", 25: "2", 26: "0", 27: "8", 28: "-", 29: "7", 31: ">", 32: ":", 33: "]", 34: ",",
  93: "1", 94: "3", 166: "!", 401: "|", 402: ";", 425: "H", 466: ".", 487: "/", 488: "*",
  631: "5", 632: "4", 721: "(", 933: "6", 965: ")", 1033: "s", 1034: "u", 1105: "[", 1109: "9",
  1217: "S", 1218: "Y", 1219: "F", 1220: "D", 1221: "A", 1310: "P", 1381: "T", 1529: "@",
  1811: "%", 1822: '"', 1958: "r", 1989: "=", 2156: "q", 2456: "?", 2697: "J", 2710: "l",
  2854: "&", 2993: "x", 3316: "z", 3332: "e", 3333: "t", 3463: "b", 3490: "<", 3506: "L",
  3537: "w", 3538: "i", 3539: "h", 3573: "+", 3587: "I", 3588: "B", 3589: "N", 3626: "^",
  3627: "_", 3639: "M", 4078: "}", 4128: "~", 4136: "Z", 4244: "C", 4245: "o", 4381: "E",
  4389: "f", 4428: "\\", 4497: "U", 4544: "a", 4545: "p", 4546: "y", 4547: "n", 4548: "g",
  4731: "Q", 4741: "O", 4849: "k", 4885: "$", 4902: "c", 4922: "v", 5033: "W", 5127: "R",
  5128: "G", 5171: "d", 5193: "K", 5200: "X", 5233: "m", 5335: "`", 5405: "V", 5461: "#",
  5489: "{", 5493: "j", 6624: " ",
};

const NUMBER = /([A-Z]{0,4})(\d{1,3})\/([A-Z]{0,4})(\d{2,3})/;
const MAX_SET_TOTAL = 400;       // a larger printed total is a misread
const SIZE_MIN = 0.95;           // catalog count vs printed total; secret rares push it up
const SIZE_MAX = 1.5;

function dilate(map, width, height) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = (dx, dy) => x - dx >= 0 && y - dy >= 0 && map[(y - dy) * width + x - dx] > TEXT_THRESH;
      if (on(0, 0) || on(1, 0) || on(0, 1) || on(1, 1)) out[y * width + x] = 1;
    }
  }
  return out;
}

function components(mask, width, height) {
  const seen = new Uint8Array(width * height);
  const found = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const box = { x1: width, y1: height, x2: 0, y2: 0 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const at = stack.pop();
      const x = at % width;
      const y = (at - x) / width;
      box.x1 = Math.min(box.x1, x); box.x2 = Math.max(box.x2, x);
      box.y1 = Math.min(box.y1, y); box.y2 = Math.max(box.y2, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
        }
      }
    }
    found.push(box);
  }
  return found;
}

function meanScore(map, width, box) {
  let sum = 0;
  for (let y = box.y1; y <= box.y2; y++) {
    for (let x = box.x1; x <= box.x2; x++) sum += map[y * width + x];
  }
  return sum / ((box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1));
}

/** Text boxes {x1, y1, x2, y2, score} in detector-map pixels, axis-aligned. */
export function textBoxes(map, width, height) {
  const boxes = [];
  for (const box of components(dilate(map, width, height), width, height)) {
    const w = box.x2 - box.x1;
    const h = box.y2 - box.y1;
    if (Math.min(w, h) < MIN_SIDE) continue;
    const score = meanScore(map, width, box);
    if (score < BOX_THRESH) continue;
    const grow = (w * h * UNCLIP_RATIO) / (2 * (w + h));
    if (Math.min(w, h) + 2 * grow < MIN_SIDE + 2) continue;
    boxes.push({
      x1: Math.max(0, Math.round(box.x1 - grow)),
      y1: Math.max(0, Math.round(box.y1 - grow)),
      x2: Math.min(width, Math.round(box.x2 + grow)),
      y2: Math.min(height, Math.round(box.y2 + grow)),
      score,
    });
  }
  return boxes;
}

/** Greedy CTC decode of rec output [steps, classes]; non-ASCII characters are dropped. */
export function ctcDecode(probs, steps, classes) {
  let text = "";
  let previous = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    for (let c = 1; c < classes; c++) {
      if (probs[t * classes + c] > probs[t * classes + best]) best = c;
    }
    if (best !== 0 && best !== previous) text += ASCII_AT[best] ?? "";
    previous = best;
  }
  return text;
}

function readNumberToken(token) {
  const match = token.match(NUMBER);
  if (!match) return null;
  const [, numPrefix, numDigits, totalPrefix, totalDigits] = match;
  if (numPrefix !== totalPrefix) return null;
  return { number: `${numPrefix}${numDigits}`, total: Number(totalDigits) };
}

/** First "number/total" in the read lines, as {number, total}, or null. */
export function parseCardNumber(lines) {
  for (const line of lines) {
    const fixed = line.replace(/[Oo](?=[\d/])|(?<=[\d/])[Oo]/g, "0");
    const tokens = fixed.split(/\s+/).filter(Boolean);
    for (const token of [...tokens, fixed.replace(/\s+/g, "")]) {
      const read = readNumberToken(token);
      if (read) return read;
    }
  }
  return null;
}

/** Catalog card count per set code. */
export function setSizes(meta) {
  const sizes = new Map();
  for (const card of meta) sizes.set(card.setCode, (sizes.get(card.setCode) || 0) + 1);
  return sizes;
}

const plainNumber = (number) => String(number).toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, "$1");

/**
 * Index into rows of the printing with this collector number in a set of about
 * the printed total, or null when none or several fit.
 */
export function printingByNumber(rows, read, sizes) {
  const asRead = printingByExactNumber(rows, read, sizes);
  if (asRead != null) return asRead;
  const digits = read.number.replace(/[A-Z]/g, (letter) => DIGIT_LOOKALIKES[letter] ?? letter);
  return digits === read.number ? null : printingByExactNumber(rows, { ...read, number: digits }, sizes);
}

const DIGIT_LOOKALIKES = { B: "8", O: "0", D: "0", S: "5", I: "1", Z: "2", G: "6" };

function printedTotal(setCode, sizes) {
  return SET_TOTALS[setCode] || sizes.get(setCode) || 0;
}

function subsetCount(rows, setCode, prefix) {
  let count = 0;
  for (const row of rows) {
    if (row.setCode === setCode && plainNumber(row.number).startsWith(prefix)) count += 1;
  }
  return count;
}

function sizeFits(size, total) {
  return size >= total * SIZE_MIN && size <= total * SIZE_MAX;
}

function printingByExactNumber(rows, read, sizes) {
  const wanted = plainNumber(read.number);
  const prefix = wanted.match(/^[A-Z]+/)?.[0] || "";
  const sameNumber = rows.flatMap((row, index) => (plainNumber(row.number) === wanted ? [index] : []));
  if (read.total > MAX_SET_TOTAL) return sameNumber.length === 1 ? sameNumber[0] : null;
  const fits = sameNumber
    .map((index) => {
      const setCode = rows[index].setCode;
      const setSize = printedTotal(setCode, sizes);
      const size = prefix && !sizeFits(setSize, read.total) ? subsetCount(rows, setCode, prefix) : setSize;
      return { index, size };
    })
    .filter(({ size }) => sizeFits(size, read.total))
    .sort((a, b) => Math.abs(a.size - read.total) - Math.abs(b.size - read.total));
  if (!fits.length) return null;
  if (fits.length > 1 && Math.abs(fits[0].size - read.total) === Math.abs(fits[1].size - read.total)) return null;
  return fits[0].index;
}
