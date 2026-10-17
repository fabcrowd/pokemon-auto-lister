import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { adapterActive, configureCatalog, loadCatalog, searchCatalog } from '../tools/extension-wasm/lib/search.js';
import { applyMemory } from '../tools/extension-wasm/lib/references.js';
import { BELOW_HIGH_CONFIDENCE, capAdapterChange } from '../tools/extension-wasm/lib/fusion.js';

const DIM = 512;
const axis = (k, v = 1) => {
  const out = new Float32Array(DIM);
  out[k] = v;
  return out;
};
const rowsOf = (...vs) => {
  const out = new Float32Array(vs.length * DIM);
  vs.forEach((v, i) => out.set(v, i * DIM));
  return out;
};
const meta = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
// U = e0, V = e1: the query e1 is adapted to normalize(e1 + e0).
const adapter = { rank: 1, u: axis(0), v: axis(1) };

beforeEach(async () => {
  await loadCatalog(zlib.gzipSync(Buffer.from(rowsOf(axis(0), axis(1), axis(2)).buffer)));
  configureCatalog({});
});

test('a raw search ignores the adapter, a normal one uses it', () => {
  configureCatalog({ adapter, adapted: rowsOf(axis(0), axis(1), axis(2)) });
  assert.equal(adapterActive(), true);
  assert.equal(searchCatalog(axis(1), 1)[0].rank.toFixed(3), Math.SQRT1_2.toFixed(3));
  assert.equal(searchCatalog(axis(1), 1, { raw: true })[0].score, 1);
  configureCatalog({});
  assert.equal(adapterActive(), false);
});

test('memory is judged on the raw query against the raw catalog top, not the adapted score', () => {
  const rows = [{ cardId: 'c', embedding: Int8Array.from(axis(5, 127)), scale: 1 / 127, v: 2 }];
  const hits = [{ index: 0, score: 0.5 }, { index: 2, score: 0.4 }];
  const query = axis(5);
  // adapted top is low, so the old code (adapted baseline 0.5) would accept; the raw top 0.99 leaves no margin.
  assert.equal(applyMemory(query, rows, hits, 0.99, meta).referencedId, null);
  const taken = applyMemory(query, rows, hits, 0.5, meta);
  assert.equal(taken.referencedId, 'c');
  assert.equal(taken.hits[0].index, 2);
  // a card the hits do not list is never promoted
  assert.equal(applyMemory(query, [{ ...rows[0], cardId: 'zzz' }], hits, 0.5, meta).referencedId, null);
  assert.equal(applyMemory(query, [], hits, 0.5, meta).hits, hits);
});

const hi = (index, score, second = 0.5) => [{ index, score }, { index: (index + 1) % 3, score: second }];
const result = (confidence) => ({ identity: { id: 'a' }, confidence, abstain: false });

test('high needs the final top card to be the raw top card and the raw read to be high', () => {
  const raw = hi(0, 0.9);
  const same = hi(0, 0.95);
  assert.equal(capAdapterChange(result(0.95), same, raw, meta).confidence, 0.95);
  const changed = hi(1, 0.95);
  const capped = capAdapterChange(result(0.95), changed, raw, meta);
  assert.equal(capped.confidence, BELOW_HIGH_CONFIDENCE);
  assert.equal(capped.confidenceBeforeAdapterCap, 0.95);
  // same card but the raw search was not high (adapter lifted the score): capped
  assert.equal(capAdapterChange(result(0.95), same, hi(0, 0.7), meta).confidence, BELOW_HIGH_CONFIDENCE);
});

test('without an adapter (same array) and for non-high or abstained reads nothing changes', () => {
  const hits = hi(0, 0.95);
  const r = result(0.95);
  assert.equal(capAdapterChange(r, hits, hits, meta), r);
  const low = result(0.6);
  assert.equal(capAdapterChange(low, hi(1, 0.6), hi(0, 0.9), meta), low);
  const abstain = { identity: null, confidence: 0, abstain: true };
  assert.equal(capAdapterChange(abstain, hi(1, 0.9), hi(0, 0.9), meta), abstain);
});
