// Turn the variant model's three heads into the price the popup should select.
// A head that is not sure stays unset, so a guess never prices a 1st Edition.

import { editDistance } from "./set-choice.js";
import { SET_TOTALS } from "./set-totals.js";

export const EDITIONS = ["first", "shadowless", "standard"];
export const FINISHES = ["holofoil", "reverse", "normal"];
export const STAMPS = ["none", "prerelease", "staff", "league", "setstamp"];

// In these sets the holo rares are the low collector numbers. The same Pokémon
// printed again later in the set is the non-holo card. Secret rares past the
// official total stay unset. Base Set 2 holos run through 20.
const HOLO_THROUGH = {
  base1: 16, base2: 16, base3: 15, base4: 20, base5: 17,
  gym1: 19, gym2: 20,
  neo1: 19, neo2: 17, neo3: 14, neo4: 16,
};
export const MIN_CONFIDENCE = 0.6;
export const VARIANT_W = 224;
export const VARIANT_FULL = 224;
export const VARIANT_ZOOM = 112;
export const VARIANT_H = VARIANT_FULL + VARIANT_ZOOM;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const FINISH_KEY = { holofoil: "Holofoil", reverse: "ReverseHolofoil", normal: "Normal" };

/** ImageNet-normalized NCHW tensor from RGBA pixels, matching the trained model. */
export function variantTensor(rgba, width, height) {
  const plane = width * height;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    tensor[i] = (rgba[i * 4] / 255 - MEAN[0]) / STD[0];
    tensor[plane + i] = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    tensor[plane * 2 + i] = (rgba[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return tensor;
}

export function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

/** The class name when this head is sure, otherwise null. */
export function confidentClass(logits, names, minimum = MIN_CONFIDENCE) {
  if (!logits || logits.length !== names.length) return null;
  const probs = softmax(logits);
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  return probs[best] >= minimum ? names[best] : null;
}

/**
 * The price-grid key the photo supports, or null when the photo does not
 * single out one priced variant. `stamp` is set even when no price key matches.
 */
export function variantChoice(prediction, variants) {
  const names = Object.keys(variants || {});
  const stamp = prediction?.stamp && prediction.stamp !== "none" ? prediction.stamp : null;
  const edition = prediction?.edition || null;
  const finish = prediction?.finish || null;
  let key = null;
  if (edition === "first") {
    const want = finish ? FINISH_KEY[finish] : null;
    const firsts = names.filter((name) => /^1stEdition/.test(name));
    key = (want && firsts.find((name) => name.endsWith(want))) || (firsts.length === 1 ? firsts[0] : null);
  } else if (edition === "shadowless") {
    key = names.find((name) => /^shadowless/i.test(name)) || null;
  } else if (!edition && finish !== "reverse" && names.some((name) => /^1stEdition|shadowless/i.test(name))) {
    // A missed stamp would quote a 1st Edition or Shadowless card at the plain price.
    key = null;
  } else if (finish === "reverse") {
    key = names.find((name) => /reverse/i.test(name)) || null;
  } else if (finish === "holofoil") {
    const holos = names.filter((name) => /holo/i.test(name) && !/reverse|1st/i.test(name));
    key = holos.length === 1 ? holos[0] : null;
  } else if (finish === "normal") {
    const plain = names.filter((name) => /^(normal|unlimited)$/i.test(name));
    key = plain.length === 1 ? plain[0] : null;
  }
  return { key, stamp, shadow: edition === "shadowless" };
}

const CORNER_PLAIN = /illus|llus|weight|lbs|wt\d/i;

/**
 * The ex-era set stamp is a logo at the bottom-right of the art, spelling a set
 * name or "PLATINUM". "Illus." or a weight line is an unstamped card. Null
 * leaves the model alone.
 */
export function stampFromCorner(text) {
  const raw = String(text || "");
  if (cornerTokens(raw).some((token) => CORNER_WORDS.some((word) => stampWordMatches(token, word)))) return "setstamp";
  if (CORNER_PLAIN.test(raw)) return "none";
  return null;
}

/** An ex-era set logo is not printed on a Wizards of the Coast card. */
export function stampAfterWizards(stamp, text) {
  if (stamp === "setstamp" && /wiz/i.test(String(text || ""))) return "none";
  return stamp;
}

/**
 * Holofoil or normal when this set prints those as different collector numbers
 * and the read total is that set's official size. Null for every other set.
 */
export function finishFromNumber(setCode, number, total) {
  const lastHolo = HOLO_THROUGH[setCode];
  const official = SET_TOTALS[setCode];
  if (!lastHolo || !official || Number(total) !== official) return null;
  const digits = String(number ?? "").match(/\d+/);
  if (!digits) return null;
  const value = Number(digits[0]);
  if (!Number.isInteger(value) || value < 1 || value > official) return null;
  return value <= lastHolo ? "holofoil" : "normal";
}

/**
 * The one finish a card is printed in, from a catalog variants flag.
 * Two flags stay unset: a reverse photo of a card that also has a normal
 * printing cannot be told apart by the catalog.
 */
export function finishFromVariants(variants) {
  if (!variants || typeof variants !== "object") return null;
  const finishes = [
    variants.holo ? "holofoil" : null,
    variants.reverse ? "reverse" : null,
    variants.normal ? "normal" : null,
  ].filter(Boolean);
  return finishes.length === 1 ? finishes[0] : null;
}

/**
 * Finish when several sets share this collector number and every one of them
 * prints that number the same way. A split, or a single set, stays unset.
 */
export function finishSharedByNumber(cards, total) {
  if (!Array.isArray(cards) || cards.length < 2) return null;
  let shared = null;
  for (const card of cards) {
    const finish = finishFromNumber(card?.setCode, card?.number, total);
    if (!finish || (shared && finish !== shared)) return null;
    shared = finish;
  }
  return shared;
}

// One set each. Short words stay exact so a weight line cannot drift into them.
const STAMP_SETS = [
  { code: "ex10", words: ["UNSEEN", "FORCES"] },
  { code: "ex11", words: ["SPECIES"] },
  { code: "ex13", words: ["HOLON", "PHANTOMS"] },
  { code: "ex14", words: ["CRYSTAL", "GUARDIANS"] },
  { code: "ex16", words: ["POWER", "KEEPERS"] },
];

// Platinum-stamped reverse holos print the word, not an expansion name.
const CORNER_WORDS = [...STAMP_SETS.flatMap((set) => set.words), "PLATINUM"];

function cornerTokens(text) {
  return String(text || "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
}

/**
 * Exact for short words. A long word may have one wrong letter, or be cut off
 * by the crop edge after six letters.
 */
function stampWordMatches(token, word) {
  if (token === word) return true;
  if (word.length < 6 || token.length < 6) return false;
  return editDistance(token, word) === 1 || word.startsWith(token);
}

/** The one expansion named by an art-corner stamp, or null when the text does not decide. */
export function stampSetCode(text) {
  const codes = new Set();
  for (const token of cornerTokens(text)) {
    for (const set of STAMP_SETS) {
      if (set.words.some((word) => stampWordMatches(token, word))) codes.add(set.code);
    }
  }
  return codes.size === 1 ? [...codes][0] : null;
}

/** The one offered card from the expansion named in the art corner. */
export function choiceForStamp(choices, text) {
  const code = stampSetCode(text);
  if (!code || !Array.isArray(choices)) return null;
  const kept = choices.filter((choice) => choice?.setCode === code);
  return kept.length === 1 ? kept[0] : null;
}
