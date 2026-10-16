import { test } from 'node:test';
import assert from 'node:assert/strict';

import { iou, greedyMatch, wilson, emptyTally, tallyPhoto, addTallies, summarize } from '../scripts/lib/sealed-metrics.mjs';

test('iou is overlap over union and zero for boxes that miss or have no area', () => {
  assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.equal(iou([0, 0, 10, 10], [5, 0, 15, 10]), 50 / 150);
  assert.equal(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0);
  assert.equal(iou([0, 0, 0, 0], [0, 0, 0, 0]), 0);
});

test('greedyMatch pairs the best overlaps first and uses each box once', () => {
  const truth = [[0, 0, 10, 10], [100, 0, 110, 10]];
  const preds = [[1, 0, 11, 10], [0, 0, 10, 10], [101, 0, 111, 10], [300, 300, 310, 310]];
  const pairs = greedyMatch(preds, truth, 0.5);
  assert.deepEqual(pairs.map(({ pred, truth: t }) => [pred, t]), [[1, 0], [2, 1]]);
});

test('greedyMatch ignores overlaps under the threshold', () => {
  assert.deepEqual(greedyMatch([[0, 0, 10, 10]], [[8, 0, 18, 10]], 0.5), []);
});

test('wilson gives the 95% interval and nothing for an empty sample', () => {
  assert.equal(wilson(0, 0), null);
  const half = wilson(50, 100);
  assert.equal(half.p, 0.5);
  assert.ok(Math.abs(half.lo - 0.4038) < 0.001, String(half.lo));
  assert.ok(Math.abs(half.hi - 0.5962) < 0.001, String(half.hi));
  const all = wilson(10, 10);
  assert.equal(all.p, 1);
  assert.equal(all.hi, 1);
  assert.ok(all.lo > 0.69 && all.lo < 0.73, String(all.lo));
  assert.equal(wilson(0, 10).lo, 0);
});

const truthCard = (box, extra = {}) => ({ box, kind: 'card', cardId: 'base1-4', edition: null, finish: null, ...extra });
const pred = (box, extra = {}) => ({ box, id: 'base1-4', unsure: false, edition: null, finish: null, key: null, variantNames: [], ...extra });

test('tallyPhoto scores detection against labeled cards and counts misses', () => {
  const t = tallyPhoto({
    truth: [truthCard([0, 0, 10, 10]), truthCard([100, 0, 110, 10]), { box: [200, 0, 210, 10], kind: 'not-card' }],
    missed: 1,
    preds: [pred([0, 0, 10, 10]), pred([200, 0, 210, 10]), pred([500, 500, 510, 510])],
  });
  assert.equal(t.truthCards, 2 + 1);
  assert.equal(t.truthHit, 1);
  assert.equal(t.preds, 3);
  assert.equal(t.predOnCard, 1);
});

test('tallyPhoto scores identity, sureness and the price key on matched cards', () => {
  const variantNames = ['1stEditionHolofoil', 'unlimitedHolofoil'];
  const t = tallyPhoto({
    truth: [
      truthCard([0, 0, 10, 10], { edition: 'first', finish: 'holofoil' }),
      truthCard([100, 0, 110, 10], { cardId: 'base1-5', edition: 'standard', finish: 'normal' }),
      { box: [200, 0, 210, 10], kind: 'unknown', cardId: null, edition: null, finish: null },
      truthCard([300, 0, 310, 10], { cardId: 'base1-6', edition: 'first' }),
    ],
    missed: 0,
    preds: [
      pred([0, 0, 10, 10], { edition: 'first', finish: 'holofoil', key: '1stEditionHolofoil', variantNames }),
      pred([100, 0, 110, 10], { id: 'base1-9', unsure: true, edition: 'shadowless', finish: 'normal' }),
      pred([200, 0, 210, 10], { id: null, unsure: true }),
    ],
  });
  assert.equal(t.identityN, 2);
  assert.equal(t.identityOk, 1);
  assert.equal(t.labeledIds, 3);
  assert.equal(t.sureN, 1);
  assert.equal(t.sureOk, 1);
  assert.equal(t.matchedCards, 3);
  assert.equal(t.unsure, 2);
  assert.equal(t.priceN, 1);
  assert.equal(t.priceOk, 1);
  assert.equal(t.variantLabeled, 3);
});

test('a prediction with no edition or finish is no call, not a wrong answer', () => {
  const t = tallyPhoto({
    truth: [
      truthCard([0, 0, 10, 10], { edition: 'first', finish: 'holofoil' }),
      truthCard([100, 0, 110, 10], { edition: 'standard', finish: 'normal' }),
      truthCard([200, 0, 210, 10], { edition: 'first', finish: 'reverse' }),
    ],
    missed: 0,
    preds: [
      pred([0, 0, 10, 10], { edition: 'first', finish: null }),
      pred([100, 0, 110, 10], { edition: null, finish: null }),
      pred([200, 0, 210, 10], { edition: 'standard', finish: 'normal' }),
    ],
  });
  assert.deepEqual([t.editionLabeled, t.editionCalls, t.editionOk], [3, 2, 1]);
  assert.deepEqual([t.finishLabeled, t.finishCalls, t.finishOk], [3, 1, 0]);
  const m = summarize(t);
  assert.equal(m.editionAccuracy.k, 1);
  assert.equal(m.editionAccuracy.n, 2);
  assert.equal(m.editionNoCall.k, 1);
  assert.equal(m.editionNoCall.n, 3);
  assert.equal(m.finishAccuracy.n, 1);
  assert.equal(m.finishNoCall.k, 2);
});

test('a bad box counts against precision and is not a card to find', () => {
  const t = tallyPhoto({
    truth: [{ box: [0, 0, 10, 10], kind: 'bad-box', cardId: null, edition: null, finish: null }, truthCard([100, 0, 110, 10])],
    missed: 0,
    preds: [pred([0, 0, 10, 10]), pred([100, 0, 110, 10])],
  });
  assert.equal(t.truthCards, 1);
  assert.equal(t.predOnCard, 1);
  assert.equal(t.preds, 2);
});

test('a photo that failed to scan with no predictions misses every labeled card', () => {
  const t = tallyPhoto({
    truth: [truthCard([0, 0, 10, 10], { edition: 'first' }), { box: [50, 0, 60, 10], kind: 'unknown', cardId: null, edition: null, finish: null }],
    missed: 1,
    preds: [],
  });
  assert.equal(t.photos, 1);
  assert.equal(t.truthCards, 3);
  assert.equal(t.truthHit, 0);
  assert.equal(t.labeledIds, 1);
  assert.equal(t.identityOk, 0);
  assert.equal(t.variantLabeled, 1);
});

test('the price key is judged only where the labeled edition and finish name one priced variant', () => {
  const variantNames = ['1stEditionHolofoil', 'unlimitedHolofoil'];
  const t = tallyPhoto({
    truth: [truthCard([0, 0, 10, 10], { edition: 'first', finish: 'holofoil' }), truthCard([100, 0, 110, 10], { edition: null, finish: null })],
    missed: 0,
    preds: [pred([0, 0, 10, 10], { key: 'unlimitedHolofoil', variantNames }), pred([100, 0, 110, 10], { key: null, variantNames })],
  });
  assert.equal(t.priceN, 1);
  assert.equal(t.priceOk, 0);
});

test('addTallies sums and summarize reports each rate with an interval, detected-only and end to end', () => {
  const one = tallyPhoto({
    truth: [truthCard([0, 0, 10, 10]), truthCard([100, 0, 110, 10])],
    missed: 0,
    preds: [pred([0, 0, 10, 10])],
  });
  const total = addTallies(addTallies(emptyTally(), one), one);
  assert.equal(total.photos, 2);
  const m = summarize(total);
  assert.equal(m.detectionRecall.k, 2);
  assert.equal(m.detectionRecall.n, 4);
  assert.equal(m.identityOfDetected.p, 1);
  assert.equal(m.identityOfDetected.n, 2);
  assert.equal(m.identityEndToEnd.k, 2);
  assert.equal(m.identityEndToEnd.n, 4);
  assert.equal(m.editionAccuracy, null);
  assert.deepEqual(Object.keys(m).sort(), [
    'detectionPrecision', 'detectionRecall', 'editionAccuracy', 'editionNoCall', 'finishAccuracy', 'finishNoCall',
    'identityEndToEnd', 'identityOfDetected', 'precisionWhenSure', 'priceEndToEnd', 'priceOfIdentified', 'unsureRate',
  ]);
});
