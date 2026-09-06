import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideDeal, parseFirstMoney, marketForStrategy } from '../src/sniper/deal.js';

describe('decideDeal', () => {
  it('hearts when market/ask >= 1.25', () => {
    assert.equal(decideDeal(125, 100), 'heart');
    assert.equal(decideDeal(200, 100), 'heart');
  });

  it('worklists the 1.15–1.25 band', () => {
    assert.equal(decideDeal(120, 100), 'worklist');
    assert.equal(decideDeal(115, 100), 'worklist');
  });

  it('flags extreme ratios as suspect without hearting', () => {
    assert.equal(decideDeal(500, 100), 'suspect');
    assert.equal(decideDeal(1000, 100), 'suspect');
  });

  it('skips below worklist and invalid inputs', () => {
    assert.equal(decideDeal(110, 100), 'skip');
    assert.equal(decideDeal(null, 100), 'skip');
    assert.equal(decideDeal(100, 0), 'skip');
    assert.equal(decideDeal(100, null), 'skip');
  });
});

describe('parseFirstMoney', () => {
  it('parses a simple price', () => {
    assert.equal(parseFirstMoney('$42.50'), 42.5);
  });

  it('uses only the first token when discounted prices concatenate', () => {
    assert.equal(parseFirstMoney('$99.75$105'), 99.75);
  });

  it('returns null for empty text', () => {
    assert.equal(parseFirstMoney(''), null);
    assert.equal(parseFirstMoney(null), null);
  });
});

describe('marketForStrategy', () => {
  const poke = {
    value: 80,
    graded: { psa8: 120, psa9: 200, psa10: 400 },
  };

  it('uses raw value for raw-crack', () => {
    assert.equal(marketForStrategy(poke, { mode: 'raw-crack', grade: 8 }), 80);
  });

  it('uses matching grade for graded-under', () => {
    assert.equal(marketForStrategy(poke, { mode: 'graded-under', grade: 9 }), 200);
  });

  it('returns null when grade missing', () => {
    assert.equal(marketForStrategy(poke, { mode: 'graded-under', grade: 7 }), null);
  });
});
