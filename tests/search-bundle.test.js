import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { configureCatalog, loadCatalog, loadHubPenalty, scoreIndices, searchCatalog } from '../tools/extension-wasm/lib/search.js';

const DIM = 512;
const axis = (k, v = 1) => {
  const out = new Float32Array(DIM);
  out[k] = v;
  return out;
};
const rowsOf = (...vectors) => {
  const out = new Float32Array(vectors.length * DIM);
  vectors.forEach((v, i) => out.set(v, i * DIM));
  return out;
};
// rank 1: U = e0, V = e1, so e1 becomes normalize(e1 + e0).
const adapter = { rank: 1, u: axis(0), v: axis(1) };

beforeEach(async () => {
  loadHubPenalty(null);
  await loadCatalog(zlib.gzipSync(Buffer.from(rowsOf(axis(0), axis(2)).buffer)));
  configureCatalog({});
});

test('extra rows are searchable after the base rows and can be removed again', () => {
  configureCatalog({ extra: rowsOf(axis(7)) });
  assert.equal(searchCatalog(axis(7), 1)[0].index, 2);
  assert.equal(scoreIndices(axis(7), [2])[0].score, 1);
  configureCatalog({});
  assert.notEqual(searchCatalog(axis(7), 1)[0].index, 2);
});

test('with an adapter the query is adapted and the adapted catalog rows are searched', () => {
  configureCatalog({ adapter, adapted: rowsOf(axis(0), axis(2)) });
  const [best] = searchCatalog(axis(1), 2);
  assert.equal(best.index, 0);
  assert.ok(Math.abs(best.score - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(scoreIndices(axis(1), [0])[0].score - Math.SQRT1_2) < 1e-6);
});

test('an adapter without a matching adapted catalog is ignored rather than mixing spaces', () => {
  configureCatalog({ adapter, adapted: rowsOf(axis(0)) });
  const [best] = searchCatalog(axis(1), 1);
  assert.ok(best.score < 0.01);
});

test('a hub penalty built for the base catalog still applies when rows are appended', () => {
  configureCatalog({ extra: rowsOf(axis(0)) });
  loadHubPenalty(new Int8Array([100, 0]).buffer);
  const hits = searchCatalog(axis(0), 2, { penalty: true });
  assert.equal(hits[0].index, 2);
  assert.equal(hits[1].index, 0);
});
