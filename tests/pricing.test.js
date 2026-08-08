import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decidePrice, formatListPrice, NEEDS_REVIEW_THRESHOLD } from '../src/pricing/pricing.js';

test('threshold constant is 15%', () => {
  assert.equal(NEEDS_REVIEW_THRESHOLD, 0.15);
});

test('formatListPrice rounds to the nearest whole dollar', () => {
  assert.equal(formatListPrice(19.4), 19);
  assert.equal(formatListPrice(19.5), 20);
});

test('sources within 15% and high confidence auto-list at median with default multipliers', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    tcgplayer: { market: 105 },
    ebay: { median: 102 },
  });

  assert.equal(result.action, 'auto');
  assert.deepEqual(result.comps, { pokegrade: 100, tcgplayer: 105, ebay: 102 });
  assert.equal(result.suggested.mercari, 102);
  assert.equal(result.suggested.ebay, 102);
});

test('pairwise relative spread over 15% forces needs_review', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    tcgplayer: { market: 130 },
    ebay: { median: 102 },
  });

  assert.equal(result.action, 'needs_review');
});

test('low PokeGrade confidence forces needs_review even when numbers agree', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'low' },
    tcgplayer: { market: 101 },
    ebay: { median: 99 },
  });

  assert.equal(result.action, 'needs_review');
});

test('a missing source forces needs_review but still returns partial comps', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    tcgplayer: { market: 101 },
    ebay: null,
  });

  assert.equal(result.action, 'needs_review');
  assert.deepEqual(result.comps, { pokegrade: 100, tcgplayer: 101, ebay: null });
  assert.ok(result.suggested.mercari > 0);
});

test('mercariMultiplier and ebayMultiplier apply independently', () => {
  const result = decidePrice(
    {
      pokegrade: { value: 100, confidence: 'high' },
      tcgplayer: { market: 100 },
      ebay: { median: 100 },
    },
    { mercariMultiplier: 1.1, ebayMultiplier: 0.9 },
  );

  assert.equal(result.suggested.mercari, 110);
  assert.equal(result.suggested.ebay, 90);
});
