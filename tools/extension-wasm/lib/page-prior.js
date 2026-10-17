// Best guesses for rows whose printing is still open after the number, symbol and stamp reads.
// A photo of a binder page or a lot is usually a few sets, so the sets of the cards those reads settled are
// the best guide for the ones they did not; failing that, the picture decides.

import { BELOW_HIGH_CONFIDENCE } from "./fusion.js";

// A guess is never shown as sure.
export const BEST_GUESS_CAP = BELOW_HIGH_CONFIDENCE;

const isOpen = (read) => !read?.abstain && !read?.bestGuess && (read?.setChoices?.length || 0) > 1;
const isEvidence = (read) => !read?.abstain && read?.setEvidence && read?.identity?.setCode && !read?.setUnconfirmed;

function bestByScore(choices) {
  let best = choices[0];
  for (const choice of choices) {
    if ((choice.score ?? -Infinity) > (best.score ?? -Infinity)) best = choice;
  }
  return best;
}

/**
 * For each read of one photo, null (leave it) or {choice, source, reason}. The page prior picks the printing
 * in the set most settled cards share, when that set is among the row's choices; otherwise the choice the
 * picture scored highest, or the first choice when none carries a score.
 */
export function decideGuesses(reads) {
  const counts = new Map();
  const names = new Map();
  for (const read of reads) {
    if (!isEvidence(read)) continue;
    const code = read.identity.setCode;
    counts.set(code, (counts.get(code) || 0) + 1);
    if (!names.has(code)) names.set(code, read.identity.set || code);
  }
  let pageSet = null;
  for (const [code, count] of counts) {
    if (!pageSet || count > counts.get(pageSet)) pageSet = code;
  }
  return reads.map((read) => {
    if (!isOpen(read)) return null;
    const onPage = pageSet ? read.setChoices.find((choice) => choice.setCode === pageSet) : null;
    if (onPage) {
      const n = counts.get(pageSet);
      return { choice: onPage, source: "page", reason: `likely ${names.get(pageSet)}: ${n} other ${n === 1 ? "card" : "cards"} on this page ${n === 1 ? "is" : "are"} from it` };
    }
    return { choice: bestByScore(read.setChoices), source: "image", reason: "best guess from the picture" };
  });
}

/** The read shown as the guessed printing with its own single price; the choices stay for the Set? menu. */
export function withGuess(read, decision, card, priced) {
  const next = {
    ...read,
    identity: card,
    ...priced,
    setConfirmed: false,
    bestGuess: { source: decision.source, reason: decision.reason },
    confidence: Math.min(read.confidence ?? 0, BEST_GUESS_CAP),
  };
  delete next.setRange;
  return next;
}
