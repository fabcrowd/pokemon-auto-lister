import { variantChoice } from '../../tools/extension-wasm/lib/variant.js';

export function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/** Best overlap first; each predicted and labeled box is used at most once. */
export function greedyMatch(preds, truths, threshold = 0.5) {
  const pairs = [];
  preds.forEach((p, pred) => {
    truths.forEach((t, truth) => {
      const overlap = iou(p, t);
      if (overlap >= threshold) pairs.push({ pred, truth, iou: overlap });
    });
  });
  pairs.sort((a, b) => b.iou - a.iou || a.pred - b.pred || a.truth - b.truth);
  const usedPred = new Set();
  const usedTruth = new Set();
  const kept = [];
  for (const pair of pairs) {
    if (usedPred.has(pair.pred) || usedTruth.has(pair.truth)) continue;
    usedPred.add(pair.pred);
    usedTruth.add(pair.truth);
    kept.push(pair);
  }
  return kept;
}

/** Wilson score interval for k successes in n tries; null when there were no tries. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

const COUNTERS = [
  'photos', 'truthCards', 'truthHit', 'preds', 'predOnCard', 'matchedCards',
  'identityN', 'identityOk', 'labeledIds', 'sureN', 'sureOk', 'unsure',
  'editionLabeled', 'editionCalls', 'editionOk', 'finishLabeled', 'finishCalls', 'finishOk',
  'priceN', 'priceOk', 'variantLabeled',
];

export const emptyTally = () => Object.fromEntries(COUNTERS.map((name) => [name, 0]));

export function addTallies(a, b) {
  return Object.fromEntries(COUNTERS.map((name) => [name, a[name] + b[name]]));
}

const isCard = (label) => label.kind === 'card' || label.kind === 'unknown';

// No edition or finish from the scanner is a call it did not make, not a wrong one.
function tallyCall(t, name, wanted, got) {
  t[`${name}Labeled`] += 1;
  if (!got) return;
  t[`${name}Calls`] += 1;
  if (got === wanted) t[`${name}Ok`] += 1;
}

/**
 * Counts for one photo. truth: [{ box, kind, cardId, edition, finish }]; preds:
 * [{ box, id, unsure, edition, finish, key, variantNames }]. A photo that failed to
 * scan is tallied with preds: [], so every labeled card in it is a miss. Only counts
 * leave this function, so nothing per-photo can be printed from the result.
 */
export function tallyPhoto({ truth, missed = 0, preds }) {
  const t = emptyTally();
  t.photos = 1;
  t.truthCards = truth.filter(isCard).length + missed;
  t.preds = preds.length;
  for (const label of truth) {
    if (label.kind !== 'card' || !label.cardId) continue;
    t.labeledIds += 1;
    if (label.edition || label.finish) t.variantLabeled += 1;
  }
  for (const pair of greedyMatch(preds.map((p) => p.box), truth.map((l) => l.box), 0.5)) {
    const label = truth[pair.truth];
    const pred = preds[pair.pred];
    if (!isCard(label)) continue;
    t.truthHit += 1;
    t.predOnCard += 1;
    t.matchedCards += 1;
    if (pred.unsure) t.unsure += 1;
    if (label.edition) tallyCall(t, 'edition', label.edition, pred.edition);
    if (label.finish) tallyCall(t, 'finish', label.finish, pred.finish);
    if (label.kind !== 'card' || !label.cardId) continue;
    const right = pred.id === label.cardId;
    t.identityN += 1;
    if (right) t.identityOk += 1;
    if (!pred.unsure) {
      t.sureN += 1;
      if (right) t.sureOk += 1;
    }
    if (right && (label.edition || label.finish)) {
      const names = Object.fromEntries((pred.variantNames || []).map((name) => [name, true]));
      const expected = variantChoice({ edition: label.edition, finish: label.finish }, names).key;
      if (expected) {
        t.priceN += 1;
        if (pred.key === expected) t.priceOk += 1;
      }
    }
  }
  return t;
}

export function summarize(t) {
  return {
    detectionRecall: wilson(t.truthHit, t.truthCards),
    detectionPrecision: wilson(t.predOnCard, t.preds),
    identityOfDetected: wilson(t.identityOk, t.identityN),
    identityEndToEnd: wilson(t.identityOk, t.labeledIds),
    precisionWhenSure: wilson(t.sureOk, t.sureN),
    unsureRate: wilson(t.unsure, t.matchedCards),
    editionAccuracy: wilson(t.editionOk, t.editionCalls),
    editionNoCall: wilson(t.editionLabeled - t.editionCalls, t.editionLabeled),
    finishAccuracy: wilson(t.finishOk, t.finishCalls),
    finishNoCall: wilson(t.finishLabeled - t.finishCalls, t.finishLabeled),
    priceOfIdentified: wilson(t.priceOk, t.priceN),
    priceEndToEnd: wilson(t.priceOk, t.variantLabeled),
  };
}
