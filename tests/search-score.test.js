import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { loadCatalog, scoreIndices } from '../tools/extension-wasm/lib/search.js';

const DIM = 512;
function unit(axis) {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

test('scoreIndices scores only the given catalog rows, best first', async () => {
  const rows = [unit(0), unit(1), unit(2)];
  rows[2][0] = 0.6; // row 2 is partly like row 0
  const flat = new Float32Array(rows.length * DIM);
  rows.forEach((r, i) => flat.set(r, i * DIM));
  await loadCatalog(zlib.gzipSync(Buffer.from(flat.buffer)));

  const scored = scoreIndices(unit(0), [1, 2, 0]);
  assert.deepEqual(scored.map((h) => h.index), [0, 2, 1]);
  assert.equal(scored[0].score, 1);
  assert.ok(Math.abs(scored[1].score - 0.6) < 1e-6);
  assert.equal(scored[2].score, 0);
});
