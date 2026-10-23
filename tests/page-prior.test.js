import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideGuesses, withGuess, BEST_GUESS_CAP } from '../tools/extension-wasm/lib/page-prior.js';

const opt = (id, setCode, set, score) => ({ id, setCode, set, number: '001', name: 'Eevee', score });
const open = (...choices) => ({ identity: { name: 'Eevee' }, setChoices: choices, confidence: 0.7 });
const settled = (setCode, evidence = 'number') => ({ identity: { id: `${setCode}-1`, setCode, set: `Set ${setCode}`, name: 'X' }, setEvidence: evidence, confidence: 0.9 });

test('open rows take the set most confirmed cards on the page share', () => {
  const reads = [settled('sv02'), settled('sv02', 'symbol'), settled('sv03'), open(opt('sv01-5', 'sv01', 'A', 0.9), opt('sv02-5', 'sv02', 'B', 0.5))];
  const out = decideGuesses(reads);
  assert.equal(out[3].choice.id, 'sv02-5');
  assert.equal(out[3].source, 'page');
  assert.match(out[3].reason, /Set sv02/);
  assert.match(out[3].reason, /2 other cards/);
});

test('one confirmed card is enough for the page prior', () => {
  const out = decideGuesses([settled('sv02'), open(opt('a', 'sv01', 'A', 0.9), opt('b', 'sv02', 'B', 0.1))]);
  assert.equal(out[1].choice.id, 'b');
  assert.equal(out[1].source, 'page');
});

test('without a confirmed card the best picture score wins', () => {
  const out = decideGuesses([open(opt('a', 'sv01', 'A', 0.5), opt('b', 'sv02', 'B', 0.8))]);
  assert.equal(out[0].choice.id, 'b');
  assert.equal(out[0].source, 'image');
});

test('when the page set is not on offer the picture decides', () => {
  const out = decideGuesses([settled('sv05'), open(opt('a', 'sv01', 'A', 0.5), opt('b', 'sv02', 'B', 0.8))]);
  assert.equal(out[1].choice.id, 'b');
  assert.equal(out[1].source, 'image');
});

test('choices without scores fall back to the first', () => {
  const choices = [{ id: 'a', setCode: 'sv01' }, { id: 'b', setCode: 'sv02' }];
  const out = decideGuesses([{ identity: { name: 'E' }, setChoices: choices }]);
  assert.equal(out[0].choice.id, 'a');
});

test('settled, abstained and already guessed rows are left alone', () => {
  const guessed = { ...open(opt('a', 'sv01', 'A', 1), opt('b', 'sv02', 'B', 1)), bestGuess: { source: 'image' } };
  const abstained = { ...open(opt('a', 'sv01', 'A', 1), opt('b', 'sv02', 'B', 1)), abstain: true };
  const out = decideGuesses([settled('sv01'), guessed, abstained]);
  assert.deepEqual(out, [null, null, null]);
});

test('a row whose set was only assumed does not count as confirmed evidence', () => {
  const assumed = { identity: { id: 'z', setCode: 'sv09', name: 'Y' }, setUnconfirmed: true };
  const noEvidence = { identity: { id: 'y', setCode: 'sv09', name: 'Y' } };
  const out = decideGuesses([assumed, noEvidence, open(opt('a', 'sv09', 'A', 0.1), opt('b', 'sv02', 'B', 0.8))]);
  assert.equal(out[2].source, 'image');
});

test('the most common confirmed set wins, ties go to the first seen', () => {
  const reads = [settled('sv03'), settled('sv02'), open(opt('a', 'sv02', 'A', 0.1), opt('b', 'sv03', 'B', 0.1))];
  assert.equal(decideGuesses(reads)[2].choice.id, 'b');
});

test('withGuess shows the guessed printing with its single price and keeps the menu', () => {
  const read = { ...open(opt('a', 'sv01', 'A', 0.5), opt('b', 'sv02', 'B', 0.8)), confidence: 0.7, setRange: { low: 1, high: 5 }, catalogTop: 0.8 };
  const card = { id: 'b', name: 'Eevee', set: 'B', setCode: 'sv02', number: '001' };
  const decision = { choice: read.setChoices[1], source: 'hint', reason: 'likely B' };
  const priced = { market_price: 3, price_variant: 'normal', price_grid: { variants: {} } };
  const next = withGuess(read, decision, card, priced);
  assert.equal(next.identity.id, 'b');
  assert.equal(next.setChoices.length, 2);
  assert.equal(next.setRange, undefined);
  assert.equal(next.market_price, 3);
  assert.equal(next.setConfirmed, false);
  assert.deepEqual(next.bestGuess, { source: 'hint', reason: 'likely B' });
  assert.ok(next.confidence <= BEST_GUESS_CAP && BEST_GUESS_CAP < 0.8);
});

test('withGuess keeps the set range for a picture-only guess, which is not priced as one printing', () => {
  const read = { ...open(opt('a', 'sv01', 'A', 0.5), opt('b', 'sv02', 'B', 0.8)), confidence: 0.7, setRange: { low: 1, high: 5 } };
  const card = { id: 'b', name: 'Eevee', set: 'B', setCode: 'sv02', number: '001' };
  const next = withGuess(read, { choice: read.setChoices[1], source: 'image', reason: 'best guess from the picture' }, card, { market_price: 3 });
  assert.deepEqual(next.setRange, { low: 1, high: 5 });
  assert.equal(next.bestGuess.source, 'image');
});

test('withGuess keeps the set range for a guess borrowed from other cards on the page; only a page heading drops it', () => {
  const read = { ...open(opt('a', 'sv01', 'A', 0.5), opt('b', 'sv02', 'B', 0.8)), confidence: 0.7, setRange: { low: 1, high: 5 } };
  const card = { id: 'b', name: 'Eevee', set: 'B', setCode: 'sv02', number: '001' };
  const page = withGuess(read, { choice: read.setChoices[1], source: 'page', reason: 'likely B' }, card, { market_price: 3 });
  assert.deepEqual(page.setRange, { low: 1, high: 5 });
  const hint = withGuess(read, { choice: read.setChoices[1], source: 'hint', reason: 'Page says B' }, card, { market_price: 3 });
  assert.equal(hint.setRange, undefined);
});

test('a first-edition stamp suggestion is preferred over the page prior and the picture score, but not over a page heading', () => {
  const stamped = { ...open(sc('a', 'base1', 'Base Set', 0.2), sc('b', 'sv02', 'X', 0.9)), suggestedSetId: 'a' };
  const out = decideGuesses([settled('sv02'), stamped]);
  assert.equal(out[1].choice.id, 'a');
  assert.equal(out[1].source, 'image');
  assert.match(out[1].reason, /1st Edition/);
  assert.equal(decideGuesses([stamped], { hint: 'sv02' })[0].source, 'hint');
});

const sc = (id, setCode, set, score) => ({ id, setCode, set, number: '1', name: 'Alakazam', score });

test('a page set hint beats the page prior and the picture score', () => {
  const reads = [settled('sv02'), open(sc('a', 'base1', 'Base Set', 0.5), sc('b', 'base4', 'Base Set 2', 0.9), sc('c', 'sv02', 'X', 0.8))];
  const out = decideGuesses(reads, { hint: 'base1' });
  assert.equal(out[1].choice.id, 'a');
  assert.equal(out[1].source, 'hint');
  assert.equal(out[1].reason, 'Page says Base Set');
});

test('a hint leaves settled rows and rows whose choices lack the set alone', () => {
  const out = decideGuesses([settled('sv02'), open(sc('b', 'base4', 'Base Set 2', 0.9), sc('c', 'sv02', 'X', 0.8))], { hint: 'base1' });
  assert.equal(out[0], null);
  assert.equal(out[1].source, 'page');
  assert.equal(out[1].choice.id, 'c');
});

test('picture scores within 0.005 are broken by the stable rank, not by the score', () => {
  const choices = [sc('late', 'xy12', 'Evolutions', 0.803), sc('early', 'base1', 'Base Set', 0.8)];
  const rank = (choice) => (choice.id === 'early' ? 0 : 1);
  assert.equal(decideGuesses([open(...choices)], { rank })[0].choice.id, 'early');
  assert.equal(decideGuesses([open(...[...choices].reverse())], { rank })[0].choice.id, 'early');
});

test('without a rank a tie falls to the id, in either input order', () => {
  const choices = [sc('b', 'xy12', 'E', 0.801), sc('a', 'base1', 'B', 0.8)];
  assert.equal(decideGuesses([open(...choices)])[0].choice.id, 'a');
  assert.equal(decideGuesses([open(...[...choices].reverse())])[0].choice.id, 'a');
});

test('a clear picture-score lead still wins over the rank', () => {
  const choices = [sc('late', 'xy12', 'Evolutions', 0.82), sc('early', 'base1', 'Base Set', 0.8)];
  assert.equal(decideGuesses([open(...choices)], { rank: (c) => (c.id === 'early' ? 0 : 1) })[0].choice.id, 'late');
});

test('two unranked choices tie-break by id in either input order', () => {
  const choices = [sc('b', 'xy12', 'E', 0.801), sc('a', 'base1', 'B', 0.8)];
  const rank = () => Infinity;
  assert.equal(decideGuesses([open(...choices)], { rank })[0].choice.id, 'a');
  assert.equal(decideGuesses([open(...[...choices].reverse())], { rank })[0].choice.id, 'a');
});

test('a printing the user corrected to before is the preselected guess, ahead of the page and the picture', () => {
  const read = { ...open(opt('a', 'sv01', 'A', 0.9), opt('b', 'sv02', 'B', 0.1)), referencedId: 'b' };
  const out = decideGuesses([settled('sv01'), read], { hint: 'sv01' });
  assert.equal(out[1].choice.id, 'b');
  assert.equal(out[1].source, 'correction');
  assert.match(out[1].reason, /corrected/i);
  // A referenced card that is not one of the choices changes nothing.
  const other = { ...open(opt('a', 'sv01', 'A', 0.9), opt('b', 'sv02', 'B', 0.1)), referencedId: 'zzz' };
  assert.equal(decideGuesses([other])[0].choice.id, 'a');
});
