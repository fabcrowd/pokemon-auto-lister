import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FILTERS,
  mergeFilters,
  primaryCondition,
  withCondition,
  withGrader,
} from '../tools/extension-wasm/lib/price-prefs.js';

test('defaults: raw NM only, no graders', () => {
  assert.deepEqual(DEFAULT_FILTERS, {
    raw: { NM: true, LP: false, MP: false, HP: false, DMG: false },
    graded: { PSA: false, BGS: false, CGC: false, SGC: false },
  });
});

test('mergeFilters returns defaults for missing or junk input', () => {
  assert.deepEqual(mergeFilters(undefined), DEFAULT_FILTERS);
  assert.deepEqual(mergeFilters(null), DEFAULT_FILTERS);
  assert.deepEqual(mergeFilters('x'), DEFAULT_FILTERS);
  assert.deepEqual(mergeFilters({ raw: 5, graded: null }), DEFAULT_FILTERS);
});

test('mergeFilters keeps booleans only and ignores unknown keys', () => {
  const out = mergeFilters({ raw: { NM: false, LP: 'yes', XX: true }, graded: { PSA: true, BGS: 1 } });
  assert.equal(out.raw.NM, false);
  assert.equal(out.raw.LP, false);
  assert.equal('XX' in out.raw, false);
  assert.equal(out.graded.PSA, true);
  assert.equal(out.graded.BGS, false);
});

test('mergeFilters does not mutate defaults', () => {
  const out = mergeFilters({ raw: { LP: true } });
  out.raw.MP = true;
  assert.equal(DEFAULT_FILTERS.raw.MP, false);
  assert.equal(DEFAULT_FILTERS.raw.LP, false);
});

test('primaryCondition picks first enabled in NM..DMG order, else NM', () => {
  assert.equal(primaryCondition(DEFAULT_FILTERS), 'NM');
  assert.equal(primaryCondition({ raw: { NM: false, LP: false, MP: true, HP: true, DMG: false } }), 'MP');
  assert.equal(primaryCondition({ raw: { NM: false, LP: false, MP: false, HP: false, DMG: false } }), 'NM');
  assert.equal(primaryCondition({ raw: { DMG: true } }), 'DMG');
});

test('withCondition sets exactly one raw key and keeps graded', () => {
  const start = withGrader(DEFAULT_FILTERS, 'PSA', true);
  const out = withCondition(start, 'HP');
  assert.deepEqual(out.raw, { NM: false, LP: false, MP: false, HP: true, DMG: false });
  assert.equal(out.graded.PSA, true);
  assert.equal(start.raw.NM, true);
});

test('withGrader sets one grader and keeps raw, without mutating', () => {
  const out = withGrader(withCondition(DEFAULT_FILTERS, 'LP'), 'CGC', true);
  assert.equal(out.graded.CGC, true);
  assert.equal(out.graded.PSA, false);
  assert.equal(out.raw.LP, true);
  assert.equal(DEFAULT_FILTERS.graded.CGC, false);
  assert.equal(withGrader(out, 'CGC', false).graded.CGC, false);
});
