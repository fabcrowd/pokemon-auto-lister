import { test } from 'node:test';
import assert from 'node:assert/strict';

import { referencesForExport } from '../tools/extension-wasm/lib/references.js';
import { EMBEDDING_VERSION } from '../tools/extension-wasm/lib/embed.js';

const vec = (n) => Float32Array.from({ length: 512 }, (_, i) => (i === n ? 1 : 0));
const head = (id, ts = 1, pickedId = 'sv1-1') => ({ id, ts, pickedId, hasCrop: true });

function setup(corrections) {
  const byId = new Map(corrections.map((c) => [c.id, c]));
  const embedded = [];
  return {
    embedded,
    getCorrection: async (id) => byId.get(id),
    embedCrop: async (crop) => { embedded.push(crop); return vec(embedded.length); },
  };
}

test('corrections without a current reference are embedded; current ones are reused', async () => {
  const have = { id: 'a', cardId: 'sv1-1', ts: 1, v: EMBEDDING_VERSION, embedding: vec(0) };
  const io = setup([{ ...head('b'), crop: 'crop-b' }]);
  const { rows, failed } = await referencesForExport({ heads: [head('a'), head('b')], refs: [have], ...io });
  assert.deepEqual(io.embedded, ['crop-b']);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['a', 'b']);
  assert.equal(failed, 0);
});

test('a reference made with an older crop is embedded again from the saved picture', async () => {
  const old = { id: 'a', cardId: 'sv1-1', ts: 1, embedding: vec(0) };
  const io = setup([{ ...head('a'), crop: 'crop-a' }]);
  const { rows } = await referencesForExport({ heads: [head('a')], refs: [old], ...io });
  assert.deepEqual(io.embedded, ['crop-a']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].v, EMBEDDING_VERSION);
});

test('a reference made from an older answer is replaced, not reused', async () => {
  const stale = { id: 'a', cardId: 'sv1-1', ts: 1, embedding: vec(0) };
  const io = setup([{ id: 'a', ts: 2, pickedId: 'sv1-9', crop: 'crop-a2' }]);
  const { rows } = await referencesForExport({ heads: [head('a', 2, 'sv1-9')], refs: [stale], ...io });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cardId, 'sv1-9');
  assert.equal(rows[0].ts, 2);
});

test('progress is reported for each embedded correction', async () => {
  const io = setup([{ ...head('a'), crop: 'x' }, { ...head('b'), crop: 'y' }]);
  const seen = [];
  await referencesForExport({ heads: [head('a'), head('b')], refs: [], ...io, onProgress: (p) => seen.push(p) });
  assert.deepEqual(seen, [{ done: 1, total: 2 }, { done: 2, total: 2 }]);
});

test('a crop that fails to embed is counted and the rest still export', async () => {
  const io = setup([{ ...head('a'), crop: 'x' }, { ...head('b'), crop: 'y' }]);
  let calls = 0;
  io.embedCrop = async () => { calls += 1; if (calls === 1) throw new Error('bad jpeg'); return vec(3); };
  const { rows, failed } = await referencesForExport({ heads: [head('a'), head('b')], refs: [], ...io });
  assert.equal(failed, 1);
  assert.deepEqual(rows.map((r) => r.id), ['b']);
});

test('a correction replaced while embedding is skipped', async () => {
  const io = setup([{ id: 'a', ts: 5, pickedId: 'sv1-1', crop: 'x' }]);
  const { rows } = await referencesForExport({ heads: [head('a', 1)], refs: [], ...io });
  assert.deepEqual(rows, []);
});

test('each new row is handed to onEmbedded so the caller decides whether to keep it', async () => {
  const io = setup([{ ...head('a'), crop: 'x' }]);
  const kept = [];
  await referencesForExport({ heads: [head('a')], refs: [], ...io, onEmbedded: async (row) => { kept.push(row.id); } });
  assert.deepEqual(kept, ['a']);
});
