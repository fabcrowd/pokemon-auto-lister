// What a saved correction may do to a new scan, by the read height of the NEW crop. Pure numbers, no imports, so the
// popup (stakes rule) and the background share one table.
//
// Measured, not guessed: data/reports/g12/thresholds.json and measurements.md in card-scanner-data (model E, art crop,
// pinned catalog; refit when any of the three changes, the same rule as lib/fusion.js).
//   boost   B: the corrected card moves first and is preselected. Per band, just above the 0.5% false-match bar.
//   confirm C: the corrected card is CONFIRMED ("your correction"). Per band, just above the largest false match seen.
//   high    H: a card worth HIGH_STAKES_MIN_USD or more is only confirmed at or above this; otherwise it stays CHOOSE.
// Leave-one-out over 666 labelled crops (2082 queries) at the C bars: 541 fires, 0 wrong, 0 right answers broken.
// Real photos only: 34 fires, 34 right (a small sample). The 0.02 margin over the raw catalog top is REFERENCE_MARGIN.
export const REFERENCE_BARS = Object.freeze([
  Object.freeze({ minHeight: 300, boost: 0.83, confirm: 0.84, high: 0.86 }),
  Object.freeze({ minHeight: 200, boost: 0.83, confirm: 0.86, high: 0.86 }),
  Object.freeze({ minHeight: 150, boost: 0.81, confirm: 0.83, high: 0.86 }),
  Object.freeze({ minHeight: 100, boost: 0.84, confirm: 0.86, high: 0.86 }),
]);

// Under this a read is too small to have been measured: memory neither boosts nor confirms.
export const REFERENCE_MIN_HEIGHT = 100;
export const HIGH_PRICE_BAR = 0.86;
// Two different cards whose references are this close are a conflict: the best one only boosts.
export const CONFLICT_GAP = 0.03;
// Float slack so a cosine exactly at a bar passes.
export const BAR_EPSILON = 1e-6;
// An unknown height (grid tiles, the legacy path) uses the 200-299 px row, as lib/fusion.js does.
const UNKNOWN_HEIGHT_BAR = REFERENCE_BARS.find((row) => row.minHeight === 200);

/** The bars for a read height, or null under REFERENCE_MIN_HEIGHT. 0, missing or non-finite means unknown. */
export function referenceBar(height) {
  if (!(Number.isFinite(height) && height > 0)) return UNKNOWN_HEIGHT_BAR;
  if (height < REFERENCE_MIN_HEIGHT) return null;
  return REFERENCE_BARS.find((row) => height >= row.minHeight);
}
