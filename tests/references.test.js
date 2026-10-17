import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMBEDDING_DIM,
  REFERENCE_MARGIN,
  REFERENCE_MIN,
  correctionsToEmbed,
  decodeEmbedding,
  encodeEmbedding,
  currentReferences,
  promoteHit,
  referenceHit,
  referenceRow,
  singleFlight,
  withEmbeddings,
} from '../tools/extension-wasm/lib/references.js';
import { EMBEDDING_VERSION } from '../tools/extension-wasm/lib/embed.js';

const V = EMBEDDING_VERSION;

function unit(...head) {
  const v = new Float32Array(EMBEDDING_DIM);
  head.forEach((x, i) => { v[i] = x; });
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

// A unit vector whose dot product with unit(1) is exactly `score`.
const at = (score) => unit(score, Math.sqrt(1 - score * score));
const query = unit(1);

test('the thresholds are conservative placeholders', () => {
  assert.equal(REFERENCE_MIN, 0.93);
  assert.equal(REFERENCE_MARGIN, 0.02);
});

test('referenceHit returns the best reference when it clears the minimum and beats the catalog by the margin', () => {
  const refs = [
    { id: 'a', cardId: 'card-a', v: V, embedding: at(0.95) },
    { id: 'b', cardId: 'card-b', v: V, embedding: at(0.97) },
  ];
  const hit = referenceHit(query, refs, 0.9);
  assert.equal(hit.cardId, 'card-b');
  assert.ok(Math.abs(hit.score - 0.97) < 1e-5);
});

test('referenceHit stays quiet below the minimum', () => {
  assert.equal(referenceHit(query, [{ id: 'a', cardId: 'x', v: V, embedding: at(0.9) }], 0.5), null);
});

test('referenceHit stays quiet when the catalog is nearly as sure', () => {
  const refs = [{ id: 'a', cardId: 'x', v: V, embedding: at(0.95) }];
  assert.equal(referenceHit(query, refs, 0.94), null);
  assert.equal(referenceHit(query, refs, 0.9)?.cardId, 'x');
});

test('referenceHit honours its own min and margin', () => {
  const refs = [{ id: 'a', cardId: 'x', v: V, embedding: at(0.8) }];
  assert.equal(referenceHit(query, refs, 0.5), null);
  assert.equal(referenceHit(query, refs, 0.5, { min: 0.7 })?.cardId, 'x');
  assert.equal(referenceHit(query, refs, 0.79, { min: 0.7, margin: 0 })?.cardId, 'x');
  assert.equal(referenceHit(query, refs, 0.79, { min: 0.7 }), null);
});

test('referenceHit with nothing to compare is null', () => {
  assert.equal(referenceHit(query, [], 0), null);
  assert.equal(referenceHit(query, null, 0), null);
});

test('referenceHit skips references of the wrong length', () => {
  const refs = [{ id: 'a', cardId: 'x', v: V, embedding: new Float32Array(3).fill(1) }];
  assert.equal(referenceHit(query, refs, 0, { min: 0 }), null);
});

test('embeddings survive base64', () => {
  const v = unit(0.3, -0.4, 0.5);
  const text = encodeEmbedding(v);
  assert.equal(typeof text, 'string');
  assert.deepEqual(Array.from(decodeEmbedding(text)), Array.from(v));
});

test('encodeEmbedding takes plain arrays too', () => {
  const plain = Array.from(unit(1, 2));
  assert.deepEqual(Array.from(decodeEmbedding(encodeEmbedding(plain))), plain.map(Math.fround));
});

test('decodeEmbedding refuses anything that is not 512 floats', () => {
  assert.equal(decodeEmbedding('AAAA'), null);
  assert.equal(decodeEmbedding(''), null);
  assert.equal(decodeEmbedding(null), null);
  assert.equal(decodeEmbedding('%%%not base64%%%'), null);
});

test('referenceRow keeps the correction id, the picked card and the crop time', () => {
  const row = referenceRow({ id: 's:0', pickedId: 'card-a', ts: 7 }, unit(1));
  assert.equal(row.id, 's:0');
  assert.equal(row.cardId, 'card-a');
  assert.equal(row.ts, 7);
  assert.equal(row.embedding.length, EMBEDDING_DIM);
});

const crop = 'data:image/jpeg;base64,AA';

test('correctionsToEmbed lists corrections with a crop and no matching reference', () => {
  const corrections = [
    { id: 'a', ts: 1, pickedId: 'x', crop },
    { id: 'b', ts: 2, pickedId: 'y', crop },
    { id: 'c', ts: 3, pickedId: 'z', crop: null },
  ];
  const refs = [{ id: 'a', cardId: 'x', ts: 1, v: V, embedding: unit(1) }];
  assert.deepEqual(correctionsToEmbed(corrections, refs).map((c) => c.id), ['b']);
});

test('correctionsToEmbed treats a reference for an older answer as missing', () => {
  const corrections = [
    { id: 'a', ts: 5, pickedId: 'x', crop },
    { id: 'b', ts: 2, pickedId: 'new', crop },
  ];
  const refs = [
    { id: 'a', cardId: 'x', ts: 1, v: V, embedding: unit(1) },
    { id: 'b', cardId: 'old', ts: 2, v: V, embedding: unit(1) },
  ];
  assert.deepEqual(correctionsToEmbed(corrections, refs).map((c) => c.id), ['a', 'b']);
});

test('withEmbeddings adds base64 only where a current reference exists', () => {
  const corrections = [
    { id: 'a', ts: 1, pickedId: 'x', crop },
    { id: 'b', ts: 2, pickedId: 'y', crop },
    { id: 'c', ts: 3, pickedId: 'z', crop },
  ];
  const refs = [
    { id: 'a', cardId: 'x', ts: 1, v: V, embedding: unit(1) },
    { id: 'c', cardId: 'old', ts: 3, v: V, embedding: unit(1) },
  ];
  const out = withEmbeddings(corrections, refs);
  assert.deepEqual(Array.from(decodeEmbedding(out[0].embedding)), Array.from(unit(1)));
  assert.equal('embedding' in out[1], false);
  assert.equal('embedding' in out[2], false);
  assert.equal('embedding' in corrections[0], false);
});

test('promoteHit moves a card already in the hits to the front at the top score, nothing else changes', () => {
  const hits = [{ index: 4, score: 0.8 }, { index: 9, score: 0.7 }, { index: 2, score: 0.6 }];
  assert.deepEqual(promoteHit(hits, 9), [{ index: 9, score: 0.8 }, { index: 4, score: 0.8 }, { index: 2, score: 0.6 }]);
  assert.deepEqual(promoteHit(hits, 4), hits);
  assert.equal(hits[1].index, 9);
});

test('promoteHit ties a ranked hit with the top on rank too', () => {
  const hits = [{ index: 4, score: 0.8, rank: 0.5 }, { index: 9, score: 0.7, rank: 0.4 }];
  assert.deepEqual(promoteHit(hits, 9)[0], { index: 9, score: 0.8, rank: 0.5 });
});

test('promoteHit never adds a card the catalog did not return', () => {
  const hits = [{ index: 4, score: 0.8 }, { index: 9, score: 0.7 }];
  assert.deepEqual(promoteHit(hits, 77), hits);
  assert.deepEqual(promoteHit([], 1), []);
});

test('decodeEmbedding refuses non-finite components', () => {
  const v = unit(1);
  v[3] = NaN;
  assert.equal(decodeEmbedding(encodeEmbedding(v)), null);
  v[3] = Infinity;
  assert.equal(decodeEmbedding(encodeEmbedding(v)), null);
});

test('decodeEmbedding refuses vectors that are not unit length', () => {
  assert.equal(decodeEmbedding(encodeEmbedding(new Float32Array(EMBEDDING_DIM))), null);
  assert.equal(decodeEmbedding(encodeEmbedding(unit(1).map((x) => x * 2))), null);
  assert.equal(decodeEmbedding(encodeEmbedding(unit(1).map((x) => x * 1.01))), null);
  assert.notEqual(decodeEmbedding(encodeEmbedding(unit(1).map((x) => x * 1.0005))), null);
});

test('referenceHit skips references and queries that do not give a finite score', () => {
  const bad = new Float32Array(EMBEDDING_DIM).fill(NaN);
  const refs = [{ id: 'a', cardId: 'bad', v: V, embedding: bad }, { id: 'b', cardId: 'ok', v: V, embedding: at(0.97) }];
  assert.equal(referenceHit(query, refs, 0.5)?.cardId, 'ok');
  const nanQuery = query.map(() => NaN);
  assert.equal(referenceHit(nanQuery, refs, 0), null);
});

test('correctionsToEmbed works from light records that only say whether a crop exists', () => {
  const heads = [{ id: 'a', ts: 1, pickedId: 'x', hasCrop: true }, { id: 'b', ts: 2, pickedId: 'y', hasCrop: false }];
  assert.deepEqual(correctionsToEmbed(heads, []).map((c) => c.id), ['a']);
});

test('currentReferences drops references whose correction changed or is gone, and keeps imported ones', () => {
  const heads = [{ id: 'a', ts: 1, pickedId: 'x' }, { id: 'b', ts: 5, pickedId: 'y' }, { id: 'c', ts: 3, pickedId: 'z' }];
  const refs = [
    { id: 'a', cardId: 'x', ts: 1, v: V },
    { id: 'b', cardId: 'y', ts: 2, v: V },
    { id: 'c', cardId: 'old', ts: 3, v: V },
    { id: 'gone', cardId: 'x', ts: 1, v: V },
    { id: 'import:s:0', cardId: 'x', ts: null, v: V },
  ];
  assert.deepEqual(currentReferences(refs, heads).map((r) => r.id), ['a', 'import:s:0']);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('singleFlight runs one task at a time and runs again for a request made while it ran', async () => {
  let runs = 0;
  let running = 0;
  let overlapped = false;
  let request;
  const task = async () => {
    runs += 1;
    running += 1;
    if (running > 1) overlapped = true;
    if (runs === 1) request();
    await tick();
    running -= 1;
  };
  request = singleFlight(task);
  const done = request();
  request();
  await done;
  assert.equal(runs, 2);
  assert.equal(overlapped, false);
});

test('singleFlight does not lose a request made by a microtask as the run ends', async () => {
  let runs = 0;
  let request;
  const task = async () => {
    runs += 1;
    if (runs === 1) Promise.resolve().then(() => request());
  };
  request = singleFlight(task);
  await request();
  assert.equal(runs, 2);
  await request();
  assert.equal(runs, 3);
});

test('singleFlight reports a failing task and keeps going', async () => {
  const errors = [];
  let runs = 0;
  const request = singleFlight(async () => { runs += 1; if (runs === 1) throw new Error('boom'); }, (err) => errors.push(err.message));
  await request();
  await request();
  assert.deepEqual(errors, ['boom']);
  assert.equal(runs, 2);
});

test('referenceRow stamps the current embedding version', () => {
  assert.equal(referenceRow({ id: 's:0', pickedId: 'card-a', ts: 7 }, unit(1)).v, EMBEDDING_VERSION);
});

test('referenceHit ignores references made with an older or unknown crop', () => {
  const old = { id: 'a', cardId: 'x', embedding: at(0.99) };
  assert.equal(referenceHit(query, [old], 0.5), null);
  assert.equal(referenceHit(query, [{ ...old, v: EMBEDDING_VERSION - 1 }], 0.5), null);
  assert.equal(referenceHit(query, [{ ...old, v: V }], 0.5)?.cardId, 'x');
  const mixed = [old, { id: 'b', cardId: 'y', v: V, embedding: at(0.95) }];
  assert.equal(referenceHit(query, mixed, 0.5)?.cardId, 'y');
});

test('correctionsToEmbed re-embeds a reference made with an older crop, keeping the correction', () => {
  const corrections = [{ id: 'a', ts: 1, pickedId: 'x', crop }, { id: 'b', ts: 2, pickedId: 'y', crop }];
  const refs = [
    { id: 'a', cardId: 'x', ts: 1, embedding: unit(1) },
    { id: 'b', cardId: 'y', ts: 2, v: V, embedding: unit(1) },
  ];
  assert.deepEqual(correctionsToEmbed(corrections, refs).map((c) => c.id), ['a']);
});

test('currentReferences drops references of an older version, imported ones included', () => {
  const heads = [{ id: 'a', ts: 1, pickedId: 'x' }, { id: 'b', ts: 2, pickedId: 'y' }];
  const refs = [
    { id: 'a', cardId: 'x', ts: 1, embedding: unit(1) },
    { id: 'b', cardId: 'y', ts: 2, v: V, embedding: unit(1) },
    { id: 'import:1', cardId: 'z', ts: null, embedding: unit(1) },
    { id: 'import:2', cardId: 'z', ts: null, v: V, embedding: unit(1) },
  ];
  assert.deepEqual(currentReferences(refs, heads).map((r) => r.id), ['b', 'import:2']);
});

test('withEmbeddings exports no embedding made with an older crop, and names the version of those it does', () => {
  const corrections = [{ id: 'a', ts: 1, pickedId: 'x', crop }, { id: 'b', ts: 2, pickedId: 'y', crop }];
  const refs = [
    { id: 'a', cardId: 'x', ts: 1, embedding: unit(1) },
    { id: 'b', cardId: 'y', ts: 2, v: V, embedding: unit(1) },
  ];
  const out = withEmbeddings(corrections, refs);
  assert.equal('embedding' in out[0], false);
  assert.equal(out[0].pickedId, 'x');
  assert.equal(out[1].embeddingVersion, V);
});
