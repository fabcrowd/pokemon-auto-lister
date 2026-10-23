import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agreeWithReference, evictCorrections, storeCorrection } from '../tools/extension-wasm/lib/correction-save.js';
import { createCorrectionsStore } from '../tools/extension-wasm/lib/corrections-store.js';
import { fakeIndexedDB } from './helpers/fake-idb.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 23);
const draft = (extra = {}) => ({ id: 's:0', ts: NOW, scanId: 's', index: 0, pickedId: 'a', via: 'wrong-card', crop: 'data:image/jpeg;base64,AA', count: 1, history: [], ...extra });

test('a first save has count 1; saving the same crop to the same card again is x2 and keeps the first why-record', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await storeCorrection(store, draft({ why: { w: 1, src: 'picture' } }), { now: NOW });
  const second = await storeCorrection(store, draft({ ts: NOW + 1, via: 'candidates', why: { w: 1, src: 'user' } }), { now: NOW });
  assert.equal(second.count, 2);
  const [row] = await store.all();
  assert.equal(row.count, 2);
  assert.deepEqual(row.history.map((h) => [h.pickedId, h.why.src]), [['a', 'picture']]);
});

test('a contradicting correction replaces the answer and keeps the earlier one', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await storeCorrection(store, draft(), { now: NOW });
  await storeCorrection(store, draft({ ts: NOW + 1, pickedId: 'b' }), { now: NOW });
  const [row] = await store.all();
  assert.equal(row.pickedId, 'b');
  assert.equal(row.count, 1);
  assert.equal(row.history[0].pickedId, 'a');
});

test('the old reference of a replaced answer is deleted', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await storeCorrection(store, draft(), { now: NOW });
  await store.saveReference({ id: 's:0', cardId: 'a', ts: NOW, v: 3, embedding: new Float32Array(2) });
  await storeCorrection(store, draft({ ts: NOW + 1, pickedId: 'b' }), { now: NOW });
  assert.equal(await store.countReferences(), 0);
});

test('the cap evicts the oldest unprotected corrections and their references, never an x2 or a recent one first', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.save({ id: 'old-x2', ts: NOW - 300 * DAY, pickedId: 'a', count: 2 });
  await store.save({ id: 'old', ts: NOW - 100 * DAY, pickedId: 'b' });
  await store.save({ id: 'older', ts: NOW - 200 * DAY, pickedId: 'c' });
  await store.save({ id: 'new', ts: NOW - DAY, pickedId: 'd' });
  await store.saveReference({ id: 'older', cardId: 'c', ts: NOW - 200 * DAY, v: 3, embedding: new Float32Array(2) });
  const gone = await evictCorrections(store, 2, NOW);
  assert.deepEqual(gone, ['older', 'old']);
  assert.deepEqual((await store.all()).map((r) => r.id).sort(), ['new', 'old-x2']);
  assert.equal(await store.countReferences(), 0);
});

test('saving over the cap evicts in the same call', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.save({ id: 'x', ts: NOW - 90 * DAY, pickedId: 'a' });
  await storeCorrection(store, draft(), { max: 1, now: NOW });
  assert.deepEqual((await store.all()).map((r) => r.id), ['s:0']);
});

test('a full disk: room is made, then the answer is kept without its picture if it still does not fit', async () => {
  const real = createCorrectionsStore(fakeIndexedDB());
  await real.save({ id: 'old', ts: NOW - 90 * DAY, pickedId: 'z' });
  const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  let calls = 0;
  const store = { ...real, save: async (row) => { calls += 1; if (row.crop && calls <= 2) throw quota; return real.save(row); } };
  const record = await storeCorrection(store, draft(), { now: NOW });
  assert.equal(record.pickedId, 'a');
  const saved = (await real.all()).find((r) => r.id === 's:0');
  assert.equal(saved.pickedId, 'a');
  assert.equal(saved.crop, null);
});

test('an error that is not about space is thrown', async () => {
  const real = createCorrectionsStore(fakeIndexedDB());
  const store = { ...real, save: async () => { throw new Error('boom'); } };
  await assert.rejects(storeCorrection(store, draft(), { now: NOW }), /boom/);
});

test('agreeWithReference: confirming the corrected card again from another crop counts x2 and stores no new row', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.save({ id: 's1:0', ts: NOW - DAY, pickedId: 'a', crop: 'x' });
  const msg = { scanId: 's2', index: 3, pickedId: 'a', guess: { memory: { refId: 's1:0', cardId: 'a' } } };
  assert.deepEqual(await agreeWithReference(store, msg, NOW), { count: 2 });
  const [row] = await store.all();
  assert.equal(row.count, 2);
  assert.equal(row.lastAgreed, NOW);
  assert.equal(row.crop, 'x');
  assert.equal(await store.count(), 1);
});

test('agreeWithReference: not when another card is picked, the reference is gone, or it is the same row', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.save({ id: 's1:0', ts: 1, pickedId: 'a' });
  const guess = { memory: { refId: 's1:0', cardId: 'a' } };
  assert.equal(await agreeWithReference(store, { scanId: 's2', index: 0, pickedId: 'b', guess }, NOW), null);
  assert.equal(await agreeWithReference(store, { scanId: 's2', index: 0, pickedId: 'a', guess: { memory: { refId: 'gone', cardId: 'a' } } }, NOW), null);
  assert.equal(await agreeWithReference(store, { scanId: 's1', index: 0, pickedId: 'a', guess }, NOW), null);
  assert.equal(await agreeWithReference(store, { scanId: 's2', index: 0, pickedId: 'a', guess: {} }, NOW), null);
});

test('an old row with no why, count or history is read, extended and still saved', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.save({ id: 's:0', ts: 5, pickedId: 'a', via: 'search' });
  const record = await storeCorrection(store, draft(), { now: NOW });
  assert.equal(record.count, 2);
  assert.equal(record.history[0].pickedId, 'a');
});
