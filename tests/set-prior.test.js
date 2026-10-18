import assert from 'node:assert/strict';
import test from 'node:test';
import { PRIOR_BETA, applySetPrior, pageSetShares, setBonus } from '../tools/extension-wasm/lib/set-prior.js';

const settled = (setCode, extra = {}) => ({ identity: { id: `${setCode}-1`, name: 'X', setCode }, abstain: false, confidence: 0.8, ...extra });
const META = new Map([
  ['a-1', { id: 'a-1', name: 'Alakazam', setCode: 'a' }],
  ['b-1', { id: 'b-1', name: 'Alakazam', setCode: 'b' }],
  ['z-9', { id: 'z-9', name: 'Zubat', setCode: 'z' }],
]);
const lookup = (id) => META.get(id);

test('shares count settled reads only, spread open printings, and let a named set count', () => {
  const reads = [
    settled('a'), settled('a'), settled('b'),
    { identity: { name: 'Y' }, setChoices: [{ setCode: 'a' }, { setCode: 'c' }], confidence: 0.7 },
    settled('z', { unsure: true }), settled('z', { lowCertainty: true }), { abstain: true, identity: null }, settled('z', { confidence: 0.4 }),
  ];
  const shares = pageSetShares(reads);
  assert.equal(Math.round(shares.get('a') * 100), Math.round(2.5 / 4 * 100));
  assert.equal(shares.get('b'), 0.25);
  assert.equal(shares.get('c'), 0.125);
  assert.equal(shares.has('z'), false);
  assert.ok(pageSetShares([], { hint: 'q' }).get('q') >= 0.3);
  assert.equal(pageSetShares(null).size, 0);
});

test('the bonus is soft: none for noise, full for a big share, linear between', () => {
  const shares = new Map([['big', 0.5], ['mid', 0.165], ['tiny', 0.02]]);
  assert.equal(setBonus('big', shares), PRIOR_BETA);
  assert.equal(setBonus('tiny', shares), 0);
  assert.equal(setBonus('none', shares), 0);
  assert.ok(Math.abs(setBonus('mid', shares) - PRIOR_BETA / 2) < 1e-9);
});

const guess = (ranked) => ({ lowCertainty: true, unsure: true, identity: lookup(ranked[0].id), nearest: ranked.map((r) => r.id), ranked });

test('a page set breaks near-ties toward itself but never beats a clearly better picture match', () => {
  const shares = new Map([['b', 0.6]]);
  const near = applySetPrior(guess([{ id: 'a-1', rank: 0.80 }, { id: 'b-1', rank: 0.79 }, { id: 'z-9', rank: 0.5 }]), shares, lookup);
  assert.equal(near.identity.id, 'b-1');
  assert.deepEqual(near.nearest, ['b-1', 'a-1', 'z-9']);
  const clear = guess([{ id: 'a-1', rank: 0.85 }, { id: 'b-1', rank: 0.70 }]);
  assert.equal(applySetPrior(clear, shares, lookup), clear);
});

test('several sets on one page each get the bonus; other sets are demoted only relatively, never removed', () => {
  const shares = new Map([['a', 0.4], ['b', 0.4]]);
  const out = applySetPrior(guess([{ id: 'z-9', rank: 0.80 }, { id: 'b-1', rank: 0.79 }, { id: 'a-1', rank: 0.78 }]), shares, lookup);
  assert.deepEqual(out.nearest, ['b-1', 'a-1', 'z-9']);
  assert.equal(out.nearest.length, 3);
});

test('only low-certainty guesses with ranked hits are touched', () => {
  const shares = new Map([['b', 1]]);
  const sure = settled('a');
  assert.equal(applySetPrior(sure, shares, lookup), sure);
  const noRank = { lowCertainty: true, identity: lookup('a-1') };
  assert.equal(applySetPrior(noRank, shares, lookup), noRank);
  const g = guess([{ id: 'a-1', rank: 0.8 }]);
  assert.equal(applySetPrior(g, new Map(), lookup), g);
});
