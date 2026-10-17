// Reading the collector number from the bottom corners of a card cut straight from the source picture.
// The rectified 750x1050 card is an upscale of a few hundred pixels on a lot photo, so the number is gone
// by then; the corners are cut at native resolution and scaled up on their own instead.

import { parseCardNumber, printingByNumber } from "./card-number.js";
import { catalogSetsForCode, isPrintedCode } from "./set-codes.js";
import { SET_TOTALS } from "./set-totals.js";

// The bottom 14%, wide enough for "SVI EN 123/198" or "088/132", with slack for a slightly turned card.
export const CORNER_WIDTH = 0.34;
// Where the number is differs by era (0.87 on a Platinum card, 0.95 on Scarlet & Violet), so the whole bottom
// 14% is read. A narrower band missed the number on older cards (measured on HiBid lot photos).
export const CORNER_BANDS = [0.86];
// Number text is about 2.2% of the card height. The text detector finds it reliably only when it is large:
// scaled to about 35 px or less it missed the number on every photo, at about 100 px it read.
export const TEXT_PX = 100;
const TEXT_FRACTION = 0.022;
const MAX_SCALE = 12;
// The detector runs in wasm; a wider strip is slow and can run out of memory.
const MAX_STRIP_WIDTH = 1400;

/** Bottom-corner rects [x, y, w, h] of a card box in the source picture, clamped to it: low band first, left then right. */
export function cornerRects(box, imageW, imageH) {
  const [x1, y1, x2, y2] = box;
  const w = x2 - x1;
  const h = y2 - y1;
  if (!(w > 0 && h > 0)) return [];
  const cut = (side, left, top) => {
    const rx = Math.max(0, Math.round(left));
    const ry = Math.max(0, Math.round(y1 + h * top));
    const width = Math.min(Math.round(w * CORNER_WIDTH), imageW - rx);
    const height = Math.min(Math.round(y2) - ry, imageH - ry);
    return width > 0 && height > 0 ? { side, rect: [rx, ry, width, height] } : null;
  };
  return CORNER_BANDS.flatMap((top) => [cut("left", x1, top), cut("right", x2 - w * CORNER_WIDTH, top)]).filter(Boolean);
}

/** Size of the scaled-up strip for a card of this height: sides a multiple of 32, as the text detector wants. */
export function stripSize(rectW, rectH, cardH) {
  const wanted = Math.max(1, TEXT_PX / (TEXT_FRACTION * cardH));
  const scale = Math.max(1, Math.min(MAX_SCALE, MAX_STRIP_WIDTH / rectW, wanted));
  const fit = (side) => Math.max(32, Math.round((side * scale) / 32) * 32);
  return { width: fit(rectW), height: fit(rectH), scale };
}

const KNOWN_TOTALS = new Set(Object.values(SET_TOTALS));

// The "/" read as a 1 and the rarity symbol as a trailing digit: "77/132 ●" comes out "771320".
function slashLost(upper) {
  for (const [run] of upper.matchAll(/\d{5,8}/g)) {
    for (let numberLength = 1; numberLength <= 3; numberLength++) {
      const rest = run.slice(numberLength);
      for (const tail of [rest, rest.startsWith("1") ? rest.slice(1) : null]) {
        if (!tail) continue;
        for (const totalLength of [3, 2]) {
          const total = Number(tail.slice(0, totalLength));
          const after = tail.slice(totalLength);
          if (tail.length >= totalLength && after.length <= 1 && KNOWN_TOTALS.has(total) && total >= 10 && Number(run.slice(0, numberLength)) <= total * 1.6) {
            return { number: run.slice(0, numberLength), total };
          }
        }
      }
    }
  }
  return null;
}

const PROMO_NUMBER = /\b(SWSH|HGSS|SM|BW|XY|DP)\s*(\d{1,3})\b/;

/**
 * What a corner says: {number, total, code}. A "123/198" pair (with the "SVI EN" before it on Scarlet & Violet),
 * a promo number such as "SWSH123", or a printed code with a bare number ("SVP EN 045"). Null when no number.
 */
export function parseCornerText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  // The reader often glues the code to the language: "SVPEN 078".
  const glued = [...upper.matchAll(/([A-Z]{3})\s*EN\s*(\d{1,3})/g)].find((m) => isPrintedCode(m[1]));
  const code = upper.split(/[^A-Z0-9]+/).find((token) => token.length === 3 && isPrintedCode(token)) ?? glued?.[1] ?? null;
  const pair = parseCardNumber([raw]);
  if (pair) return { number: pair.number, total: pair.total, code };
  const lost = slashLost(upper);
  if (lost) return { ...lost, code };
  const promo = upper.match(PROMO_NUMBER);
  if (promo) return { number: promo[1] + promo[2], total: null, code: null };
  if (glued) return { number: glued[2], total: null, code: glued[1] };
  if (code) {
    const bare = upper.match(/\b(\d{2,3})\b(?!\/)/);
    if (bare) return { number: bare[1], total: null, code };
  }
  return null;
}

const plain = (number) => String(number).toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, "$1");

/**
 * The one setChoices entry this corner read settles, as {choice, via}, or null. A printed set code naming a
 * choice is the strongest evidence. A number counts only when it is one of the choices' own numbers, and its
 * total, when read, fits that set's size. A bare number needs exactly one choice carrying it.
 */
export function choiceFromCorner(choices, read, sizes) {
  if (!read || !Array.isArray(choices) || choices.length === 0) return null;
  if (read.code) {
    const sets = catalogSetsForCode(read.code);
    const inSet = choices.filter((choice) => sets.includes(choice.setCode));
    if (inSet.length === 1) return { choice: inSet[0], via: "code" };
    // A set with several printings of the name (promos): the number tells them apart.
    const numbered = inSet.filter((choice) => plain(choice.number) === plain(read.number));
    return numbered.length === 1 ? { choice: numbered[0], via: "code" } : null;
  }
  const wanted = plain(read.number);
  const sameNumber = choices.filter((choice) => plain(choice.number) === wanted);
  if (!sameNumber.length) return null;
  if (read.total == null) return sameNumber.length === 1 ? { choice: sameNumber[0], via: "number" } : null;
  const at = printingByNumber(choices, { number: read.number, total: read.total }, sizes);
  return at == null ? null : { choice: choices[at], via: "number" };
}
