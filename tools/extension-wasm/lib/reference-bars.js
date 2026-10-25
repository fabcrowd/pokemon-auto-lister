// What a saved correction may do to a new scan, by the read height of the NEW crop. Pure numbers, no imports, so the
// popup and the background share one table.
//
// Measured, not guessed: data/reports/g12/thresholds.json and measurements.md in card-scanner-data (model E, art crop,
// pinned catalog; refit when any of the three changes, the same rule as lib/fusion.js).
//   boost   B: the corrected card moves first and is preselected. Per band, just above the 0.5% false-match bar.
//   confirm C: the corrected card is CONFIRMED ("your correction"). Per band, just above the largest false match seen.
// Price never changes these bars: a $50+ card confirms at C like any other (it carries a "High value, double-check" chip).
// Leave-one-out over 666 labelled crops (2082 queries) at the C bars: 541 fires, 0 wrong, 0 right answers broken.
// Real photos only: 34 fires, 34 right (a small sample). The 0.02 margin over the raw catalog top is REFERENCE_MARGIN.
export const REFERENCE_BARS = Object.freeze([
  Object.freeze({ minHeight: 300, boost: 0.83, confirm: 0.84 }),
  Object.freeze({ minHeight: 200, boost: 0.83, confirm: 0.86 }),
  Object.freeze({ minHeight: 150, boost: 0.81, confirm: 0.83 }),
  Object.freeze({ minHeight: 100, boost: 0.84, confirm: 0.86 }),
]);

// Under this a read is too small to have been measured: memory neither boosts nor confirms.
export const REFERENCE_MIN_HEIGHT = 100;
// PRINT_C: a new crop this close to the corrected crop is a NEAR-DUPLICATE (the same picture again), so the exact
// printing the user picked is confirmed too. Below it the printing stays open with their printing preselected.
// Evidence (geometry boxes, id level; data/reports/g12/print/print_bar.md in card-scanner-data), best same-name
// other-printing pair vs best same-printing pair per query, reaching cosine t:
//   band      n(diff/same)   t=.93 diff / same     t=.95 diff / same     t=.97 diff / same
//   150-199   78/103         0/78 / 0/103          0/78 / 0/103          0/78 / 0/103   (max diff .907)
//   200-299   156/206        1/156 / 38/206        0/156 / 9/206         0/156 / 1/206  (max diff .943)
//   300+      156/206        3/156 / 104/206       0/156 / 53/206        0/156 / 13/206 (max diff .943)
//   100-149   no id-level pairs measured: the same bar is used, unmeasured.
// At .95 no different printing reached it (0 of 390, 95% upper bound about 0.8%); only near-duplicates do.
export const PRINT_C = 0.95;
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
