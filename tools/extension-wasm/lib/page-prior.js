// Best guesses for rows whose printing is still open after the number, symbol and stamp reads.
// A photo of a binder page or a lot is usually a few sets, so the sets of the cards those reads settled are
// the best guide for the ones they did not; failing that, the picture decides.

import { BELOW_HIGH_CONFIDENCE } from "./fusion.js";

// A guess is never shown as sure.
export const BEST_GUESS_CAP = BELOW_HIGH_CONFIDENCE;

const isOpen = (read) => !read?.abstain && !read?.bestGuess && (read?.setChoices?.length || 0) > 1;
const isEvidence = (read) => !read?.abstain && read?.setEvidence && read?.identity?.setCode && !read?.setUnconfirmed;

// Printings of one card the picture cannot tell apart score a few thousandths apart and swap places between
// scans of the same photo, so near-equal scores go by a fixed order (release order when the caller has one).
const SCORE_TIE = 0.005;

function bestByScore(choices, rank) {
  const score = (choice) => choice.score ?? -Infinity;
  const top = Math.max(...choices.map(score));
  const tied = choices.filter((choice) => top - score(choice) <= SCORE_TIE);
  if (!tied.length) return choices[0];
  return tied.reduce((best, choice) => {
    // Unranked ids rank Infinity, and Infinity - Infinity is NaN, so compare instead of subtracting.
    const a = rank(choice);
    const b = rank(best);
    if (a !== b) return a < b ? choice : best;
    return String(choice.id) < String(best.id) ? choice : best;
  });
}

/**
 * For each read of one photo, null (leave it) or {choice, source, reason}. A set the page's own text names
 * (`hint`, a setCode) comes first, then the printing in the set most settled cards share, when that set is among
 * the row's choices; otherwise the choice the picture scored highest, or the first choice when none carries a
 * score. Each applies only where the set is among the row's choices.
 */
export function decideGuesses(reads, { hint = null, rank = () => 0 } = {}) {
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
    const named = hint ? read.setChoices.find((choice) => choice.setCode === hint) : null;
    if (named) return { choice: named, source: "hint", reason: `Page says ${named.set || hint}` };
    // A 1st Edition stamp rules out sets that never had one; it is picture evidence, so it only preselects.
    const stamped = read.suggestedSetId ? read.setChoices.find((choice) => choice.id === read.suggestedSetId) : null;
    if (stamped) return { choice: stamped, source: "image", reason: "1st Edition stamp seen on the card" };
    const onPage = pageSet ? read.setChoices.find((choice) => choice.setCode === pageSet) : null;
    if (onPage) {
      const n = counts.get(pageSet);
      return { choice: onPage, source: "page", reason: `likely ${names.get(pageSet)}: ${n} other ${n === 1 ? "card" : "cards"} on this page ${n === 1 ? "is" : "are"} from it` };
    }
    return { choice: bestByScore(read.setChoices, rank), source: "image", reason: "best guess from the picture" };
  });
}

/**
 * The read shown as the guessed printing; the choices stay for the Set? menu. A guess from a page heading
 * that names the set is quoted at its own single price. Any other guess (the picture, a stamp, a set borrowed from
 * the page's other cards) keeps the range over the choices: it preselects the menu and prices once the user confirms it.
 */
export function withGuess(read, decision, card, priced) {
  const next = {
    ...read,
    identity: card,
    ...priced,
    setConfirmed: false,
    bestGuess: { source: decision.source, reason: decision.reason },
    confidence: Math.min(read.confidence ?? 0, BEST_GUESS_CAP),
  };
  if (decision.source === "hint") delete next.setRange;
  return next;
}
