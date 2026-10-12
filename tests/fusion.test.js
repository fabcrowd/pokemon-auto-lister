import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuseResults } from '../tools/extension-wasm/lib/fusion.js';

test('a name that leads a near-tie beats one lookalike', () => {
  const meta = [
    { name: 'Exeggutor δ', set: 'A' },
    { name: 'Sunflora', set: 'B' },
    { name: 'Sunflora', set: 'C' },
  ];
  const result = fuseResults([
    { index: 0, score: 0.799 },
    { index: 1, score: 0.798 },
    { index: 2, score: 0.791 },
  ], null, meta, []);
  assert.equal(result.abstain, false);
  assert.equal(result.identity.name, 'Sunflora');
  assert.equal(result.identity.set, 'B');
});

test('later repeats of a lookalike do not outvote the top of the list', () => {
  const meta = [
    { name: 'PokéNav' },
    { name: 'Poké Blower +' },
    { name: 'Switch' },
    { name: 'PokéNav' },
    { name: 'PokéNav' },
  ];
  const result = fuseResults([
    { index: 0, score: 0.792 },
    { index: 1, score: 0.792 },
    { index: 2, score: 0.789 },
    { index: 3, score: 0.780 },
    { index: 4, score: 0.775 },
  ], null, meta, []);
  assert.equal(result.abstain, true);
});

test('a tie between different names still abstains', () => {
  const meta = [
    { name: 'Wynaut' },
    { name: 'Squirtle' },
    { name: 'Gible' },
  ];
  const result = fuseResults([
    { index: 0, score: 0.841 },
    { index: 1, score: 0.836 },
    { index: 2, score: 0.831 },
  ], null, meta, []);
  assert.equal(result.abstain, true);
  assert.equal(result.reason, 'ambiguous');
});
