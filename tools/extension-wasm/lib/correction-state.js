// How saved corrections age: a re-correction keeps its history, a repeat counts, and the store has a cap.

export const MAX_CORRECTIONS = 400;
export const MAX_HISTORY = 3;
export const PROTECT_DAYS = 30;
const DAY_MS = 86400000;

const entryOf = (row) => ({
  ts: row.ts, pickedId: row.pickedId, via: row.via, ...(row.why ? { why: row.why } : {}),
});

/**
 * The count and history for a correction about to be saved over `previous` (the row with the same id, or null).
 * The same answer again counts up; a different answer starts again at 1; either way the earlier answer, with the
 * why-record it had, stays in `history` (newest MAX_HISTORY).
 */
export function nextCorrectionState(previous, record) {
  if (!previous) return { count: 1, history: [] };
  const history = [...(Array.isArray(previous.history) ? previous.history : []), entryOf(previous)].slice(-MAX_HISTORY);
  const count = previous.pickedId === record.pickedId ? (previous.count || 1) + 1 : 1;
  return { count, history };
}

/** Protected from eviction: corrected the same way twice, or confirmed (saved or agreed with) in the last PROTECT_DAYS. */
export function isProtected(head, now = Date.now()) {
  if ((head.count || 1) >= 2) return true;
  return Math.max(head.ts || 0, head.lastAgreed || 0) >= now - PROTECT_DAYS * DAY_MS;
}

/**
 * The ids to delete so the store holds at most `max` corrections: the oldest unprotected first; only when none are
 * left the oldest recent ones, then the oldest repeated ones, so the cap always holds.
 */
export function pickEvictions(heads, { max = MAX_CORRECTIONS, now = Date.now() } = {}) {
  const over = heads.length - max;
  if (over <= 0) return [];
  const rank = (head) => ((head.count || 1) >= 2 ? 2 : isProtected(head, now) ? 1 : 0);
  return [...heads].sort((a, b) => rank(a) - rank(b) || (a.ts || 0) - (b.ts || 0)).slice(0, over).map((head) => head.id);
}
