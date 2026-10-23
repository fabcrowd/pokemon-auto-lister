import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CORRECTIONS, MAX_HISTORY, PROTECT_DAYS, isProtected, nextCorrectionState, pickEvictions,
} from '../tools/extension-wasm/lib/correction-state.js';
import { correctionRecord, guessWithWhy, wrongIdOf } from '../tools/extension-wasm/lib/card-picker.js';
import { createCorrectionsStore } from '../tools/extension-wasm/lib/corrections-store.js';
import { currentReferences, referenceRow } from '../tools/extension-wasm/lib/references.js';
import { fakeIndexedDB } from './helpers/fake-idb.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 23);
const why = (src) => ({ w: 1, src, cos: 0.7 });

test('caps', () => {
  assert.equal(MAX_CORRECTIONS, 400);
  assert.equal(MAX_HISTORY, 3);
  assert.equal(PROTECT_DAYS, 30);
});

test('a first correction has count 1 and no history', () => {
  assert.deepEqual(nextCorrectionState(null, { ts: 5, pickedId: 'a', via: 'wrong-card', why: why('picture') }), { count: 1, history: [] });
});

test('correcting the same crop to the same card again counts x2 and keeps the earlier why-record', () => {
  const prev = { ts: 5, pickedId: 'a', via: 'wrong-card', why: why('picture'), count: 1, history: [] };
  const next = nextCorrectionState(prev, { ts: 9, pickedId: 'a', via: 'candidates', why: why('user') });
  assert.equal(next.count, 2);
  assert.deepEqual(next.history, [{ ts: 5, pickedId: 'a', via: 'wrong-card', why: why('picture') }]);
});

test('a contradicting correction resets the count, keeps the old answer in history', () => {
  const prev = { ts: 5, pickedId: 'a', via: 'search', why: why('picture'), count: 2, history: [] };
  const next = nextCorrectionState(prev, { ts: 9, pickedId: 'b', via: 'wrong-card', why: why('user') });
  assert.equal(next.count, 1);
  assert.equal(next.history[0].pickedId, 'a');
});

test('history keeps the newest three entries', () => {
  let prev = null;
  for (let i = 1; i <= 6; i++) {
    const record = { ts: i, pickedId: `c${i}`, via: 'search', why: why('picture') };
    const state = nextCorrectionState(prev, record);
    prev = { ...record, ...state };
  }
  assert.equal(prev.history.length, 3);
  assert.deepEqual(prev.history.map((h) => h.pickedId), ['c3', 'c4', 'c5']);
});

test('an old row with no why, count or history is read as count 1', () => {
  const next = nextCorrectionState({ ts: 1, pickedId: 'a', via: 'search' }, { ts: 2, pickedId: 'a', via: 'search' });
  assert.equal(next.count, 2);
  assert.deepEqual(next.history, [{ ts: 1, pickedId: 'a', via: 'search' }]);
});

test('isProtected: x2, or confirmed within 30 days', () => {
  assert.equal(isProtected({ ts: NOW - 40 * DAY, count: 2 }, NOW), true);
  assert.equal(isProtected({ ts: NOW - 29 * DAY, count: 1 }, NOW), true);
  assert.equal(isProtected({ ts: NOW - 31 * DAY, count: 1 }, NOW), false);
  assert.equal(isProtected({ ts: NOW - 31 * DAY, lastAgreed: NOW - DAY }, NOW), true);
  assert.equal(isProtected({ ts: NOW - 31 * DAY }, NOW), false);
});

const head = (id, ageDays, extra = {}) => ({ id, ts: NOW - ageDays * DAY, pickedId: id, hasCrop: true, ...extra });

test('pickEvictions drops nothing under the cap', () => {
  assert.deepEqual(pickEvictions([head('a', 90), head('b', 1)], { max: 2, now: NOW }), []);
});

test('pickEvictions drops the oldest unprotected first', () => {
  const heads = [head('old-x2', 200, { count: 2 }), head('older', 120), head('old', 60), head('recent', 2)];
  assert.deepEqual(pickEvictions(heads, { max: 2, now: NOW }), ['older', 'old']);
});

test('pickEvictions never drops an x2 or recent row while an unprotected one exists, and holds the cap otherwise', () => {
  const heads = [head('r1', 3), head('r2', 2), head('r3', 1), head('x', 300, { count: 3 })];
  const out = pickEvictions(heads, { max: 2, now: NOW });
  assert.equal(out.length, 2);
  assert.deepEqual(out, ['r1', 'r2']);
  const allX = [head('a', 5, { count: 2 }), head('b', 4, { count: 2 }), head('c', 3, { count: 2 })];
  assert.deepEqual(pickEvictions(allX, { max: 2, now: NOW }), ['a']);
});

test('pickEvictions defaults to the 400 cap', () => {
  const many = Array.from({ length: 405 }, (_, i) => head(`c${i}`, 100 + (405 - i)));
  assert.equal(pickEvictions(many, { now: NOW }).length, 5);
});

test('wrongIdOf: the guessed card when it differs in name, never for a printing change', () => {
  const nameOf = (id) => ({ a: 'Pikachu', a2: 'Pikachu', b: 'Raichu' })[id];
  assert.equal(wrongIdOf('a', 'b', nameOf), 'a');
  assert.equal(wrongIdOf('a', 'a2', nameOf), null);
  assert.equal(wrongIdOf('a', 'a', nameOf), null);
  assert.equal(wrongIdOf(null, 'a', nameOf), null);
});

test('correctionRecord keeps a sanitized why, wrongId, count and history, and old callers still work', () => {
  const base = { ts: 1, scanId: 's', index: 0, pickedId: 'a', via: 'wrong-card', guess: { id: 'z' } };
  const old = correctionRecord(base);
  assert.equal(old.why, undefined);
  assert.equal(old.count, 1);
  assert.deepEqual(old.history, []);
  assert.equal(old.wrongId, null);
  const full = correctionRecord({ ...base, why: { ...why('picture'), evil: 1 }, wrongId: 'z', count: 2, history: [{ ts: 0, pickedId: 'q', via: 'search', why: why('user') }] });
  assert.equal(full.why.src, 'picture');
  assert.equal(full.why.evil, undefined);
  assert.equal(full.wrongId, 'z');
  assert.equal(full.count, 2);
  assert.equal(full.history[0].pickedId, 'q');
  assert.equal(correctionRecord({ ...base, why: { src: 'bogus' } }).why, undefined);
});

test('guessWithWhy sends the scanner guess with the why-record of the confirmation, plus the price shown', () => {
  const card = { guess: { id: 'z', confidence: 0.7, abstain: false, choiceIds: [], catalogTop: 0.8 }, why: why('promoted'), memory: { refId: 'r1', cardId: 'z', level: 'confirm' } };
  const out = guessWithWhy(card, 12.5);
  assert.equal(out.id, 'z');
  assert.equal(out.why.src, 'promoted');
  assert.equal(out.why.price, 12.5);
  assert.deepEqual(out.memory, { refId: 'r1', cardId: 'z' });
  assert.equal(guessWithWhy({ guess: { id: 'z' } }).why, undefined);
});

test('the store lists heads with count and wrongId, and deletes one correction', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.save({ id: 's:0', ts: 1, pickedId: 'a', count: 2, wrongId: 'z', crop: 'x', lastAgreed: 9 });
  await store.save({ id: 's:1', ts: 2, pickedId: 'b', crop: null });
  const heads = await store.correctionHeads();
  assert.deepEqual(heads[0], { id: 's:0', ts: 1, pickedId: 'a', hasCrop: true, count: 2, wrongId: 'z', lastAgreed: 9 });
  assert.equal(heads[1].count, 1);
  await store.deleteCorrection('s:0');
  assert.equal(await store.count(), 1);
});

test('referenceRow carries wrongId and count; currentReferences follows the correction head', () => {
  const row = referenceRow({ id: 's:0', ts: 1, pickedId: 'a', wrongId: 'z', count: 2 }, new Float32Array(1));
  assert.equal(row.wrongId, 'z');
  assert.equal(row.n, 2);
  const current = currentReferences([row], [{ id: 's:0', ts: 1, pickedId: 'a', count: 3, wrongId: 'z' }]);
  assert.equal(current[0].n, 3);
  assert.equal(currentReferences([{ id: 'imp', cardId: 'q', ts: null, v: row.v }], [])[0].n, undefined);
});
