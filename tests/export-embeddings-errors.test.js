import { test } from 'node:test';
import assert from 'node:assert/strict';

import { referencesForExport } from '../tools/extension-wasm/lib/references.js';

const vec = (n) => Float32Array.from({ length: 512 }, (_, i) => (i === n ? 1 : 0));
const head = (id) => ({ id, ts: 1, pickedId: 'sv1-1', hasCrop: true });
const heads = [head('a'), head('b')];
const getCorrection = async (id) => ({ ...head(id), crop: `crop-${id}` });

test('every embed failing is an error that carries the first cause, not a partial file', async () => {
  const causes = ['model not loaded', 'second'];
  const logged = [];
  await assert.rejects(
    referencesForExport({
      heads, refs: [], getCorrection,
      embedCrop: async () => { throw new Error(causes.shift()); },
      onError: (e) => logged.push(e.message),
    }),
    /model not loaded/,
  );
  assert.deepEqual(logged, ['model not loaded', 'second']);
});

test('some failures are reported with the first cause alongside the rows that worked', async () => {
  let calls = 0;
  const result = await referencesForExport({
    heads, refs: [], getCorrection,
    embedCrop: async () => { calls += 1; if (calls === 1) throw new Error('bad jpeg'); return vec(3); },
    onError: () => {},
  });
  assert.equal(result.failed, 1);
  assert.equal(result.firstError, 'bad jpeg');
  assert.equal(result.rows.length, 1);
});
