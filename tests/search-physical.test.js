import { test } from 'node:test';
import assert from 'node:assert/strict';

import { physicalHits } from '../tools/extension-wasm/lib/search.js';

const meta = [
  { id: 'ex11-48', name: 'Magneton' },
  { id: 'A1-098', name: 'Magneton' },
  { id: 'A3b-012', name: 'Eevee' },
  { id: 'B1-030', name: 'Pikachu' },
  { id: 'P-A-005', name: 'Poké Ball' },
  { id: 'svp-036', name: 'Palafin' },
  { id: 'base1-4', name: 'Charizard' },
];

test('TCG Pocket cards are never offered: they cannot be bought or sold', () => {
  const hits = meta.map((_, index) => ({ index, score: 0.9 - index * 0.01 }));
  const ids = physicalHits(hits, meta).map((h) => meta[h.index].id);
  assert.deepEqual(ids, ['ex11-48', 'svp-036', 'base1-4']);
});

test('order and scores are kept', () => {
  const hits = [{ index: 6, score: 0.8 }, { index: 1, score: 0.79 }, { index: 0, score: 0.7 }];
  assert.deepEqual(physicalHits(hits, meta), [{ index: 6, score: 0.8 }, { index: 0, score: 0.7 }]);
});
