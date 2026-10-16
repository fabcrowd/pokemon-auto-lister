import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMBEDDING_DIM, encodeEmbedding } from '../tools/extension-wasm/lib/references.js';
import { gridReport, itemsFromExport, leaveOneOut, summarizeAt } from '../scripts/lib/references-loo.mjs';

function unit(...head) {
  const v = new Float32Array(EMBEDDING_DIM);
  head.forEach((x, i) => { v[i] = x; });
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

const item = (id, cardId, scanId, ...head) => ({ id, cardId, scanId, catalogTop: null, embedding: unit(...head) });

test('itemsFromExport keeps corrections with a usable embedding, with scan and catalog score, and counts the rest', () => {
  const file = {
    corrections: [
      { id: 'a', scanId: 's1', pickedId: 'x', guess: { catalogTop: 0.8 }, embedding: encodeEmbedding(unit(1)) },
      { id: 'b', pickedId: 'y' },
      { id: 'c', pickedId: 'z', embedding: 'AAAA' },
      { id: 'd', embedding: encodeEmbedding(unit(1)) },
      { id: 'e', pickedId: 'x', embedding: encodeEmbedding(unit(1)) },
    ],
  };
  const { items, skipped, withoutCatalogTop } = itemsFromExport(file);
  assert.deepEqual(items.map((i) => i.id), ['a', 'e']);
  assert.equal(items[0].scanId, 's1');
  assert.equal(items[0].catalogTop, 0.8);
  assert.equal(items[1].scanId, null);
  assert.equal(items[1].catalogTop, null);
  assert.equal(skipped, 3);
  assert.equal(withoutCatalogTop, 1);
});

test('itemsFromExport rejects a file without a corrections list', () => {
  assert.throws(() => itemsFromExport({ photos: [] }), /corrections/);
});

test('leaveOneOut finds the nearest other reference and whether it names the right card', () => {
  const items = [
    item('a', 'x', 's1', 1, 0),
    item('b', 'x', 's2', 1, 0.1),
    item('c', 'y', 's3', 0, 1),
    item('d', 'z', 's4', 0.1, 1),
  ];
  const byId = Object.fromEntries(leaveOneOut(items).map((r) => [r.id, r]));
  assert.equal(byId.a.nearestCardId, 'x');
  assert.equal(byId.a.correct, true);
  assert.equal(byId.c.nearestCardId, 'z');
  assert.equal(byId.c.correct, false);
  assert.ok(byId.a.score > 0.99);
});

test('leaveOneOut ignores neighbours from the same scan', () => {
  const rows = leaveOneOut([item('a', 'x', 's1', 1, 0), item('b', 'x', 's1', 1, 0.01), item('c', 'y', 's2', 0, 1)]);
  const a = rows.find((r) => r.id === 'a');
  assert.equal(a.nearestCardId, 'y');
  assert.equal(a.correct, false);
});

test('corrections with no scan are not treated as one scan', () => {
  const rows = leaveOneOut([item('a', 'x', null, 1, 0), item('b', 'x', null, 1, 0.01)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].correct, true);
});

test('a lone reference, or only same-scan neighbours, has nobody to be compared with', () => {
  assert.deepEqual(leaveOneOut([item('a', 'x', 's', 1)]), []);
  assert.deepEqual(leaveOneOut([item('a', 'x', 's', 1), item('b', 'y', 's', 0, 1)]), []);
});

test('rows carry the catalog top score saved with the correction', () => {
  const [row] = leaveOneOut([{ ...item('a', 'x', 's1', 1), catalogTop: 0.8 }, item('b', 'x', 's2', 1)]);
  assert.equal(row.catalogTop, 0.8);
});

test('summarizeAt counts how many fire and how many of those are right, with a Wilson interval', () => {
  const rows = [
    { score: 0.99, catalogTop: 0.5, correct: true },
    { score: 0.97, catalogTop: null, correct: true },
    { score: 0.96, catalogTop: 0.95, correct: true },
    { score: 0.95, catalogTop: 0.5, correct: false },
    { score: 0.8, catalogTop: 0.5, correct: true },
  ];
  const s = summarizeAt(rows, { min: 0.93, margin: 0.02 });
  assert.equal(s.total, 5);
  assert.equal(s.fired, 3);
  assert.equal(s.correct, 2);
  assert.equal(s.interval.k, 2);
  assert.equal(s.interval.n, 3);
  assert.ok(s.interval.lo < 2 / 3 && s.interval.hi > 2 / 3);
});

test('summarizeAt with nothing firing has no interval', () => {
  const s = summarizeAt([{ score: 0.5, catalogTop: null, correct: true }], { min: 0.93, margin: 0.02 });
  assert.equal(s.fired, 0);
  assert.equal(s.interval, null);
});

test('gridReport lists one line per min value, firing less as the minimum rises', () => {
  const rows = [
    { score: 0.99, catalogTop: null, correct: true },
    { score: 0.9, catalogTop: null, correct: false },
    { score: 0.85, catalogTop: null, correct: true },
  ];
  const grid = gridReport(rows, { margin: 0, mins: [0.8, 0.88, 0.95] });
  assert.deepEqual(grid.map((g) => g.min), [0.8, 0.88, 0.95]);
  assert.deepEqual(grid.map((g) => g.fired), [3, 2, 1]);
  assert.deepEqual(grid.map((g) => g.correct), [2, 1, 1]);
});
