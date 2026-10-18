// A soft prior from the page itself: a page of cards usually shows a few sets, so the sets most of its settled cards
// come from are the likelier home of the cards that were not settled. It only re-orders the closest cards of an
// unsure best guess (lib/card-picker.js asLowCertaintyGuess); it never touches a read that passed fusion, never filters a
// set out, and a card of any other set still wins when the picture says so by more than the bonus.

// Bonus in cosine units, about the spread between the true card and its look-alikes at grid-tile size (fit on the
// Base Set page and a Base Set + Jungle + Fossil page; see /tasks notes in the commit message).
export const PRIOR_BETA = 0.03;
const MIN_SHARE = 0.03;   // below this a set is noise, not a prior
const FULL_SHARE = 0.30;  // at or above this a set earns the whole bonus
const SETTLED_CONFIDENCE = 0.5;

const settled = (read) => read && !read.abstain && !read.unsure && !read.lowCertainty && !read.cardBack
  && (read.confidence ?? 0) >= SETTLED_CONFIDENCE;

/**
 * Share (0..1) of the page's settled cards in each set. A card whose printing is still open spreads its one vote over
 * its choices. A set the page's own text names counts at least as much as a full-share set.
 * @returns Map setCode => share
 */
export function pageSetShares(reads, { hint = null } = {}) {
  const weight = new Map();
  let total = 0;
  for (const read of reads || []) {
    if (!settled(read)) continue;
    const choices = read.setChoices?.length > 1 ? read.setChoices.map((c) => c.setCode).filter(Boolean) : [];
    const codes = choices.length ? choices : [read.identity?.setCode].filter(Boolean);
    if (!codes.length) continue;
    total += 1;
    for (const code of codes) weight.set(code, (weight.get(code) || 0) + 1 / codes.length);
  }
  const shares = new Map();
  if (total) for (const [code, w] of weight) shares.set(code, w / total);
  if (hint) shares.set(hint, Math.max(shares.get(hint) || 0, FULL_SHARE));
  return shares;
}

/** Bonus for a card of `setCode`: 0 below MIN_SHARE, the full `beta` from FULL_SHARE up, linear between. */
export function setBonus(setCode, shares, beta = PRIOR_BETA) {
  const share = shares?.get(setCode) || 0;
  if (share <= MIN_SHARE) return 0;
  return beta * Math.min(1, (share - MIN_SHARE) / (FULL_SHARE - MIN_SHARE));
}

/**
 * The read with its closest cards re-ordered by picture rank plus the set bonus, and the best of them named. Only
 * low-certainty guesses carrying `ranked` ([{ id, rank }], best first) are touched; ties keep the picture's order.
 */
export function applySetPrior(read, shares, lookup, beta = PRIOR_BETA) {
  if (!read?.lowCertainty || !read.ranked?.length || !shares?.size) return read;
  const scored = read.ranked
    .map((hit, order) => ({ id: hit.id, order, value: hit.rank + setBonus(lookup(hit.id)?.setCode, shares, beta) }))
    .sort((a, b) => b.value - a.value || a.order - b.order);
  const best = lookup(scored[0].id);
  if (!best || scored.every((s, i) => s.order === i)) return read;
  return { ...read, identity: best, nearest: scored.map((s) => s.id), setPriorMoved: true };
}
