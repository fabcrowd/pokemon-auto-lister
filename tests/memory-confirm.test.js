import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REFERENCE_BARS, REFERENCE_MIN_HEIGHT, referenceBar,
} from '../tools/extension-wasm/lib/reference-bars.js';
import {
  EMBEDDING_DIM, REFERENCE_MARGIN, applyMemory, memoryHit, negativeHit,
} from '../tools/extension-wasm/lib/references.js';
import { memoryVerdict } from '../tools/extension-wasm/lib/memory-confirm.js';
import { BELOW_HIGH_CONFIDENCE, SMALL_SOURCE_CONFIDENCE_CAP } from '../tools/extension-wasm/lib/fusion.js';
import { EMBEDDING_VERSION } from '../tools/extension-wasm/lib/embed.js';

const V = EMBEDDING_VERSION;
function unit(...head) {
  const v = new Float32Array(EMBEDDING_DIM);
  head.forEach((x, i) => { v[i] = x; });
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}
const at = (score) => unit(score, Math.sqrt(1 - score * score));
const query = unit(1);
const ref = (cardId, score, extra = {}) => ({ id: `r-${cardId}`, cardId, v: V, embedding: at(score), ...extra });

// Per-height bars from data/reports/g12/thresholds.json (leave-one-out: 541 fires, 0 wrong).
test('the bars per read-height band are the measured table', () => {
  const rows = REFERENCE_BARS.map((r) => [r.minHeight, r.boost, r.confirm]);
  assert.deepEqual(rows, [[300, 0.83, 0.84], [200, 0.83, 0.86], [150, 0.81, 0.83], [100, 0.84, 0.86]]);
  assert.equal(REFERENCE_MIN_HEIGHT, 100);
  assert.equal(REFERENCE_MARGIN, 0.02);
});

test('referenceBar picks the band at its exact boundaries', () => {
  assert.equal(referenceBar(100).boost, 0.84);
  assert.equal(referenceBar(149.9).boost, 0.84);
  assert.equal(referenceBar(150).boost, 0.81);
  assert.equal(referenceBar(199.9).confirm, 0.83);
  assert.equal(referenceBar(200).confirm, 0.86);
  assert.equal(referenceBar(299.9).boost, 0.83);
  assert.equal(referenceBar(300).confirm, 0.84);
  assert.equal(referenceBar(1200).confirm, 0.84);
});

test('referenceBar: under 100 px there is no bar, an unknown height uses the 200-299 row', () => {
  assert.equal(referenceBar(99.9), null);
  assert.equal(referenceBar(1), null);
  for (const unknown of [0, undefined, null, NaN, -5]) assert.equal(referenceBar(unknown).minHeight, 200);
});

test('memoryHit: boost at B, confirm at C, nothing below B (200-299 px)', () => {
  const h = { height: 250 };
  assert.equal(memoryHit(query, [ref('x', 0.829)], 0.5, h), null);
  assert.equal(memoryHit(query, [ref('x', 0.83)], 0.5, h).level, 'boost');
  assert.equal(memoryHit(query, [ref('x', 0.859)], 0.5, h).level, 'boost');
  const confirm = memoryHit(query, [ref('x', 0.86)], 0.5, h);
  assert.equal(confirm.level, 'confirm');
  assert.equal(confirm.cardId, 'x');
});

test('memoryHit: each band has its own B and C', () => {
  assert.equal(memoryHit(query, [ref('x', 0.84)], 0.5, { height: 120 }).level, 'boost');
  assert.equal(memoryHit(query, [ref('x', 0.839)], 0.5, { height: 120 }), null);
  assert.equal(memoryHit(query, [ref('x', 0.86)], 0.5, { height: 120 }).level, 'confirm');
  assert.equal(memoryHit(query, [ref('x', 0.81)], 0.5, { height: 170 }).level, 'boost');
  assert.equal(memoryHit(query, [ref('x', 0.83)], 0.5, { height: 170 }).level, 'confirm');
  assert.equal(memoryHit(query, [ref('x', 0.83)], 0.5, { height: 350 }).level, 'boost');
  assert.equal(memoryHit(query, [ref('x', 0.84)], 0.5, { height: 350 }).level, 'confirm');
});

test('memoryHit: a reference must beat the raw catalog top by the margin', () => {
  const refs = [ref('x', 0.9)];
  assert.equal(memoryHit(query, refs, 0.9 - 0.019, { height: 250 }), null);
  assert.equal(memoryHit(query, refs, 0.9 - 0.02, { height: 250 }).level, 'confirm');
  assert.equal(memoryHit(query, refs, 0.5, { height: 250 }).level, 'confirm');
});

test('memoryHit: never under 100 px, and a reference of another crop version is ignored', () => {
  assert.equal(memoryHit(query, [ref('x', 0.99)], 0.1, { height: 99 }), null);
  assert.equal(memoryHit(query, [ref('x', 0.99, { v: V - 1 })], 0.1, { height: 250 }), null);
  assert.equal(memoryHit(query, [], 0.1, { height: 250 }), null);
});

test('memoryHit: two cards within 0.03 of each other is a conflict, so it only boosts', () => {
  const refs = [ref('x', 0.9), ref('y', 0.88)];
  const hit = memoryHit(query, refs, 0.5, { height: 250 });
  assert.equal(hit.level, 'boost');
  assert.equal(hit.conflict, true);
  const apart = memoryHit(query, [ref('x', 0.9), ref('y', 0.86)], 0.5, { height: 250 });
  assert.equal(apart.level, 'confirm');
  assert.equal(apart.conflict, undefined);
  // The same card twice is agreement, not a conflict.
  assert.equal(memoryHit(query, [ref('x', 0.9), ref('x', 0.89)], 0.5, { height: 250 }).level, 'confirm');
});

test('memoryHit reports the reference and how often the user agreed', () => {
  const hit = memoryHit(query, [ref('x', 0.9, { n: 2, ts: 77 })], 0.5, { height: 250 });
  assert.equal(hit.refId, 'r-x');
  assert.equal(hit.n, 2);
  assert.equal(hit.ts, 77);
  assert.equal(memoryHit(query, [ref('x', 0.9)], 0.5, { height: 250 }).n, 1);
});

test('a superseded reference is ignored', () => {
  assert.equal(memoryHit(query, [ref('x', 0.9, { superseded: 5 })], 0.5, { height: 250 }), null);
});

test('negativeHit: a reference that said "not this card" fires at B for the card now on top', () => {
  const refs = [ref('right', 0.84, { wrongId: 'wrong' })];
  const hit = negativeHit(query, refs, 'wrong', { height: 250 });
  assert.equal(hit.cardId, 'right');
  assert.equal(negativeHit(query, refs, 'other', { height: 250 }), null);
  assert.equal(negativeHit(query, [ref('right', 0.829, { wrongId: 'wrong' })], 'wrong', { height: 250 }), null);
  assert.equal(negativeHit(query, [ref('right', 0.9)], 'wrong', { height: 250 }), null);
  assert.equal(negativeHit(query, refs, 'wrong', { height: 80 }), null);
});

const meta = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
const hitsOf = (...ids) => ids.map((id, i) => ({ index: meta.findIndex((m) => m.id === id), score: 0.7 - i * 0.05 }));

test('applyMemory: a confirm-level reference moves its card first and says so', () => {
  const out = applyMemory(query, [ref('b', 0.9, { n: 2 })], hitsOf('a', 'b', 'c'), 0.7, meta, { height: 250 });
  assert.equal(out.referencedId, 'b');
  assert.equal(meta[out.hits[0].index].id, 'b');
  assert.equal(out.hits[0].score, 0.7);
  assert.equal(out.memory.level, 'confirm');
  assert.ok(Math.abs(out.memory.cos - 0.9) < 1e-5);
  assert.equal(out.memory.n, 2);
});

test('applyMemory: only a card the catalog returned is moved', () => {
  const hits = hitsOf('a', 'c');
  const out = applyMemory(query, [ref('b', 0.9)], hits, 0.7, meta, { height: 250 });
  assert.equal(out.hits, hits);
  assert.equal(out.referencedId, null);
  assert.equal(out.memory, null);
});

test('applyMemory: negative memory puts the corrected card first and flags the wrong top card', () => {
  // The margin fails (the catalog is nearly as sure), so there is no positive hit, but the user once said "a is wrong for this".
  const out = applyMemory(query, [ref('b', 0.85, { wrongId: 'a' })], hitsOf('a', 'b'), 0.84, meta, { height: 250 });
  assert.equal(out.memory.level, 'negative');
  assert.equal(out.memory.wrongId, 'a');
  assert.equal(out.referencedId, 'b');
  assert.equal(meta[out.hits[0].index].id, 'b');
});

test('applyMemory: negative memory keeps the corrected card as a suggestion even when the catalog never returned it', () => {
  const hits = hitsOf('a', 'c');
  const out = applyMemory(query, [ref('b', 0.85, { wrongId: 'a' })], hits, 0.84, meta, { height: 250 });
  assert.equal(out.memory.level, 'negative');
  assert.equal(out.referencedId, 'b');
  assert.equal(out.hits, hits);
});

test('applyMemory: a positive hit wins over a negative one', () => {
  const out = applyMemory(query, [ref('b', 0.9, { wrongId: 'a' })], hitsOf('a', 'b'), 0.7, meta, { height: 250 });
  assert.equal(out.memory.level, 'confirm');
});

test('applyMemory: community pack rows only boost, at the old 0.93 bar, and never confirm', () => {
  const pack = [{ ...ref('b', 0.95), scale: 1 }];
  const out = applyMemory(query, [], hitsOf('a', 'b'), 0.7, meta, { height: 250, pack });
  assert.equal(out.memory.level, 'boost');
  assert.equal(out.memory.pack, true);
  assert.equal(applyMemory(query, [], hitsOf('a', 'b'), 0.7, meta, { height: 250, pack: [ref('b', 0.9)] }).memory, null);
});

test('applyMemory with no rows changes nothing', () => {
  const hits = hitsOf('a');
  const out = applyMemory(query, [], hits, 0.7, meta);
  assert.deepEqual(out, { hits, referencedId: null, memory: null });
});

const picture = { identity: { id: 'a', name: 'A' }, confidence: 0.8, abstain: false, reason: 'confirmed' };
const chosen = { identity: { id: 'a', name: 'A' }, confidence: 0.4, abstain: false, reason: 'choose', choose: true };

test('memoryVerdict: a confirm-level hit confirms the corrected card with source "correction" below the high tier', () => {
  const hits = hitsOf('b', 'a');
  const out = memoryVerdict(chosen, { level: 'confirm', cardId: 'b' }, { hits, meta });
  assert.equal(out.confirmedBy, 'correction');
  assert.equal(out.fused.identity.id, 'b');
  assert.equal(out.fused.abstain, false);
  assert.equal(out.fused.choose, undefined);
  assert.equal(out.fused.confidence, BELOW_HIGH_CONFIDENCE);
  assert.equal(out.fused.reason, 'your-correction');
});

test('memoryVerdict: an abstained read is confirmed too', () => {
  const out = memoryVerdict({ identity: null, confidence: 0.3, abstain: true, reason: 'low_sim' }, { level: 'confirm', cardId: 'b' }, { hits: hitsOf('b'), meta });
  assert.equal(out.confirmedBy, 'correction');
  assert.equal(out.fused.identity.id, 'b');
});

test('memoryVerdict: when the picture already confirms the same card the source stays "picture"', () => {
  const out = memoryVerdict({ ...picture, identity: { id: 'b', name: 'B' } }, { level: 'confirm', cardId: 'b' }, { hits: hitsOf('b'), meta });
  assert.equal(out.confirmedBy, null);
  assert.equal(out.fused.confidence, 0.8);
});

test('memoryVerdict: a boost leaves the read alone', () => {
  const out = memoryVerdict(chosen, { level: 'boost', cardId: 'b' }, { hits: hitsOf('b'), meta });
  assert.equal(out.fused, chosen);
  assert.equal(out.confirmedBy, null);
});

test('memoryVerdict: negative memory stops the card the user called wrong from being confirmed', () => {
  const out = memoryVerdict(picture, { level: 'negative', cardId: 'b', wrongId: 'a' }, { hits: hitsOf('a', 'b'), meta });
  assert.equal(out.fused.choose, true);
  assert.equal(out.fused.reason, 'choose');
  assert.ok(out.fused.confidence <= SMALL_SOURCE_CONFIDENCE_CAP);
  assert.equal(out.negative, true);
  // A read that is not that card, or is not a confirmation, is untouched.
  assert.equal(memoryVerdict(picture, { level: 'negative', cardId: 'b', wrongId: 'c' }, { hits: hitsOf('a'), meta }).fused, picture);
  assert.equal(memoryVerdict(chosen, { level: 'negative', cardId: 'b', wrongId: 'a' }, { hits: hitsOf('a'), meta }).fused, chosen);
});

test('memoryVerdict without memory returns the read as is', () => {
  assert.equal(memoryVerdict(picture, null, { hits: hitsOf('a'), meta }).fused, picture);
});

// PRINT_C: a near-duplicate of the corrected crop settles the exact printing. data/reports/g12/print/print_bar.md:
// no same-name-other-printing pair (0 of 390) reached 0.95, max 0.9426; same-printing pairs reach it in 9/206 (200-299 px) and 53/206 (300+ px).
test('PRINT_C is 0.95', async () => {
  const { PRINT_C } = await import('../tools/extension-wasm/lib/reference-bars.js');
  assert.equal(PRINT_C, 0.95);
});

test('applyMemory remembers which card the reference moved aside', () => {
  const out = applyMemory(query, [ref('b', 0.9)], hitsOf('a', 'b'), 0.7, meta, { height: 250 });
  assert.equal(out.memory.moved, true);
  assert.equal(out.memory.movedFrom, 'a');
  const same = applyMemory(query, [ref('a', 0.9)], hitsOf('a', 'b'), 0.7, meta, { height: 250 });
  assert.equal(same.memory.moved, false);
});

test('memoryVerdict: a reference that moved the card makes the source "your correction" even when the picture then confirms it', () => {
  const hits = hitsOf('b', 'a');
  const confirmedB = { ...picture, identity: { id: 'b', name: 'B' }, confidence: 0.85 };
  const out = memoryVerdict(confirmedB, { level: 'confirm', cardId: 'b', moved: true, movedFrom: 'a', cos: 0.9 }, { hits, meta });
  assert.equal(out.confirmedBy, 'correction');
  assert.equal(out.fused.identity.id, 'b');
  assert.ok(out.fused.confidence <= BELOW_HIGH_CONFIDENCE);
});

test('memoryVerdict: printingExact only for a near-duplicate (at PRINT_C) of the corrected crop', () => {
  const hits = hitsOf('b');
  const at = (cos) => memoryVerdict(chosen, { level: 'confirm', cardId: 'b', cos }, { hits, meta }).printingExact;
  assert.equal(at(0.95), true);
  assert.equal(at(0.949), false);
  assert.equal(memoryVerdict(chosen, { level: 'boost', cardId: 'b', cos: 0.99 }, { hits, meta }).printingExact, false);
  const sameCard = memoryVerdict({ ...picture, identity: { id: 'b', name: 'B' } }, { level: 'confirm', cardId: 'b', cos: 0.99, moved: false }, { hits, meta });
  assert.equal(sameCard.printingExact, true);
  assert.equal(sameCard.confirmedBy, null);
});
