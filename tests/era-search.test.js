import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { eraById, eraRowIndices } from '../tools/extension-wasm/lib/era.js';
import { eraHits, loadCatalog, searchCatalog } from '../tools/extension-wasm/lib/search.js';
import { fuseResults } from '../tools/extension-wasm/lib/fusion.js';
import { candidatesFor, closestMatches } from '../tools/extension-wasm/lib/card-picker.js';

const DIM = 512;
const unit = (axis, spill = {}) => {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  for (const [i, x] of Object.entries(spill)) v[i] = x;
  return v;
};
const row = (id, name, setCode, series) => ({ id, name, setCode, number: '1', imageUrl: `https://assets.tcgdex.net/en/${series}/${setCode}/1/high.webp` });

const META = [
  row('swsh9-18', 'Blastoise V', 'swsh9', 'swsh'),
  row('base1-2', 'Blastoise', 'base1', 'base'),
  row('base1-4', 'Charizard', 'base1', 'base'),
  row('bw8-30', 'Plasma Storm Thing', 'bw8', 'bw'),
];
const wotc = eraById('wotc');

async function loadTiny() {
  // The query (axis 0) is closest to the out-of-era Blastoise V; the in-era cards trail it.
  const rows = [unit(0), unit(0, { 1: 2 }), unit(2), unit(0, { 3: 0.5 })];
  const flat = new Float32Array(rows.length * DIM);
  rows.forEach((r, i) => flat.set(r, i * DIM));
  await loadCatalog(zlib.gzipSync(Buffer.from(flat.buffer)));
}

test('eraRowIndices lists only the era rows', () => {
  assert.deepEqual(eraRowIndices(META, wotc), [1, 2]);
  assert.equal(eraRowIndices(META, wotc), eraRowIndices(META, wotc));
});

test('eraHits ranks only in-era rows when the global top is out of era', async () => {
  await loadTiny();
  const query = unit(0);
  assert.equal(searchCatalog(query, 1)[0].index, 0);
  const hits = eraHits(query, META, wotc);
  assert.deepEqual(hits.map((h) => h.index).sort(), [1, 2]);
  assert.equal(hits[0].index, 1);
  assert.equal(closestMatches(hits, META).every((r) => ['base1-2', 'base1-4'].includes(r.id)), true);
  const fused = fuseResults(hits, null, META);
  assert.notEqual(fused.identity?.id, 'swsh9-18');
});

test('candidatesFor drops out-of-era cards when an era is given, and is unchanged without one', () => {
  const card = { identity: null, abstain: true, nearest: ['swsh9-18', 'base1-2', 'bw8-30'] };
  assert.deepEqual(candidatesFor(card, META, 5, wotc).map((r) => r.id), ['base1-2']);
  assert.deepEqual(candidatesFor(card, META).map((r) => r.id), ['swsh9-18', 'base1-2', 'bw8-30']);
});
