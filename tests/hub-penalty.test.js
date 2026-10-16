import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { loadCatalog, loadHubPenalty, searchCatalog } from '../tools/extension-wasm/lib/search.js';

const DIM = 512;

// Row i is a unit vector on axis 0 scaled so that its cosine with a query on axis 0 is dots[i].
async function catalogWithDots(dots) {
  const flat = new Float32Array(dots.length * DIM);
  dots.forEach((dot, i) => {
    flat[i * DIM] = dot;
    flat[i * DIM + 1] = Math.sqrt(1 - dot * dot);
  });
  await loadCatalog(zlib.gzipSync(Buffer.from(flat.buffer)));
}

function query() {
  const q = new Float32Array(DIM);
  q[0] = 1;
  return q;
}

function int8(...values) {
  return new Int8Array(values).buffer;
}

let warnings;
const realWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  loadHubPenalty(null);
});
test.after(() => {
  console.warn = realWarn;
});

test('without the option, hits are ranked and scored by cosine alone', async () => {
  await catalogWithDots([0.9, 0.85, 0.5]);
  loadHubPenalty(int8(100, 0, 0));
  const hits = searchCatalog(query(), 3);
  assert.deepEqual(hits.map((h) => h.index), [0, 1, 2]);
  assert.equal('rank' in hits[0], false);
});

test('with the option, rows rank by cosine minus penalty but keep their own cosine as the score', async () => {
  await catalogWithDots([0.9, 0.85, 0.5]);
  loadHubPenalty(int8(100, 0, 0)); // 1 unit = 0.001, so row 0 loses 0.1
  const hits = searchCatalog(query(), 3, { penalty: true });
  assert.deepEqual(hits.map((h) => h.index), [1, 0, 2]);
  assert.ok(Math.abs(hits[0].score - 0.85) < 1e-6);
  assert.ok(Math.abs(hits[1].score - 0.9) < 1e-6, 'the reported score is the raw cosine');
  assert.ok(Math.abs(hits[1].rank - 0.8) < 1e-6);
  assert.ok(Math.abs(hits[0].rank - 0.85) < 1e-6);
});

test('a negative penalty lifts a row that real photos rarely resemble', async () => {
  await catalogWithDots([0.8, 0.82]);
  loadHubPenalty(int8(-50, 0));
  const hits = searchCatalog(query(), 2, { penalty: true });
  assert.deepEqual(hits.map((h) => h.index), [0, 1]);
  assert.ok(Math.abs(hits[0].score - 0.8) < 1e-6);
});

test('a penalty for a different number of rows is ignored and reported once', async () => {
  await catalogWithDots([0.9, 0.85, 0.5]);
  loadHubPenalty(int8(100, 0));
  for (let i = 0; i < 3; i++) {
    const hits = searchCatalog(query(), 3, { penalty: true });
    assert.deepEqual(hits.map((h) => h.index), [0, 1, 2]);
    assert.equal('rank' in hits[0], false);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 rows.*3/);
});

test('asking for the penalty when none was loaded searches by cosine without a warning', async () => {
  await catalogWithDots([0.9, 0.85]);
  const hits = searchCatalog(query(), 2, { penalty: true });
  assert.deepEqual(hits.map((h) => h.index), [0, 1]);
  assert.equal(warnings.length, 0);
});
