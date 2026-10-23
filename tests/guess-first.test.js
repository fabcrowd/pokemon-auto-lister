import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topGuessOf, guessPrice, guessQuote, lotTotals, readFromSmallCrop } from '../tools/extension-wasm/lib/card-display.js';
import { largerRendition } from '../tools/extension-wasm/lib/full-size.js';

const cand = (id, name) => ({ id, name, set: 'Base Set', setCode: 'base1', number: '58' });

test('a nameless card with candidates gets its closest card as the top guess; named cards and backs do not', () => {
  assert.deepEqual(topGuessOf({ abstain: true, candidates: [cand('base1-58', 'Pikachu'), cand('x', 'Raichu')] }),
    { id: 'base1-58', name: 'Pikachu', set: 'Base Set', setCode: 'base1', number: '58' });
  assert.equal(topGuessOf({ abstain: true, candidates: [] }), null);
  assert.equal(topGuessOf({ identity: { name: 'Mew' }, unsure: true, candidates: [cand('a', 'Mew')] }), null);
  assert.equal(topGuessOf({ cardBack: true, candidates: [cand('a', 'Mew')] }), null);
});

test('small crops are flagged under 150 px; unknown height is not small', () => {
  assert.equal(readFromSmallCrop({ readHeight: 120 }), true);
  assert.equal(readFromSmallCrop({ readHeight: 150 }), false);
  assert.equal(readFromSmallCrop({}), false);
});

test('lot totals: sure from identified cards, guesses from top guesses and asked names, together the sum', () => {
  const sure = { identity: { id: 'a', name: 'Charizard' }, confidence: 0.95, market_price: 100 };
  const guess = { abstain: true, topGuess: { id: 'b', name: 'Pikachu', price: 1.2 } };
  const unpriced = { abstain: true, topGuess: { id: 'c', name: 'Mew', price: null } };
  const asked = { identity: { id: 'd', name: 'Magcargo' }, unsure: true, confidence: 0.3, market_price: 2 };
  const back = { cardBack: true };
  const t = lotTotals([sure, guess, unpriced, asked, back], () => null);
  assert.equal(t.sure.low, 100);
  assert.equal(t.sure.identified, 1);
  assert.equal(Number(t.guess.toFixed(2)), 3.2);
  assert.equal(t.guessed, 2);
  assert.equal(Number(t.high.toFixed(2)), 103.2);
  assert.equal(guessPrice(back, null), null);
});

test('a larger rendition is offered only when it is known to be bigger', () => {
  const base = 'https://example.com/listing';
  const srcset = 'https://cdn.example.com/a-480.jpg 480w, https://cdn.example.com/a-1600.jpg 1600w';
  assert.deepEqual(largerRendition({ src: 'https://cdn.example.com/a-480.jpg', naturalWidth: 480, naturalHeight: 640, srcset, base }),
    { url: 'https://cdn.example.com/a-1600.jpg', side: 2133 });
  assert.equal(largerRendition({ src: 'https://cdn.example.com/a.jpg', naturalWidth: 1600, naturalHeight: 1600, srcset: 'https://cdn.example.com/b.jpg 1700w', base }), null);
  const fb = 'https://scontent.xx.fbcdn.net/v/t39/123456789_n.jpg?stp=dst-jpg&ctp=p600x600&_nc_ht=x';
  const offer = largerRendition({ src: fb, naturalWidth: 600, naturalHeight: 800, base });
  assert.ok(offer && !offer.url.includes('ctp=') && offer.side === null);
  assert.equal(largerRendition({ src: 'https://scontent.xx.fbcdn.net/v/t39/1_n.jpg?stp=dst-jpg', naturalWidth: 600, naturalHeight: 800, base }), null);
});

test('a guess priced over the cap is listed to check, not added to the guesses total', () => {
  const rare = { abstain: true, topGuess: { id: 'r', name: 'Rayquaza δ', price: 349.99 } };
  const cheap = { abstain: true, topGuess: { id: 'p', name: 'Pikachu', price: 1.2 } };
  const t = lotTotals([rare, cheap], () => null);
  assert.equal(t.guess, 1.2);
  assert.equal(t.toCheck, 1);
  assert.equal(t.guessed, 1);
});

const multiGrid = (prices, extra = {}) => ({
  variants: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { market: v, conditions: { NM: v, LP: null, MP: null, HP: null, DMG: null } }])),
  ...extra,
});
const unsureNamed = (extra = {}) => ({ identity: { id: 'n-1', name: 'Eevee' }, unsure: true, confidence: 0.3, ...extra });

test('guessQuote: an unconfirmed printing is priced at the default printing (holofoil, then normal, then reverse) and marked approx', () => {
  const card = unsureNamed({ price_grid: multiGrid({ normal: 2, holofoil: 10, reverseHolofoil: null, unlimited: 6 }) });
  assert.deepEqual(guessQuote(card, null), { price: 10, approx: true });
  assert.equal(guessPrice(card, null), 10);
  const noHolo = unsureNamed({ price_grid: multiGrid({ reverseHolofoil: 4, normal: 2, unlimited: 6 }) });
  assert.equal(guessPrice(noHolo, null), 2);
  const onlyReverse = unsureNamed({ price_grid: multiGrid({ holofoil: null, reverseHolofoil: 4, other: 9 }) });
  assert.equal(guessPrice(onlyReverse, null), 4);
  const unlisted = unsureNamed({ price_grid: multiGrid({ a: 9, b: 3 }) });
  assert.equal(guessPrice(unlisted, null), 9);
});

test('guessQuote: a confirmed printing keeps its exact quote, and an all-null grid gives null', () => {
  const card = unsureNamed({ price_grid: multiGrid({ normal: 2, holofoil: 10 }) });
  assert.deepEqual(guessQuote(card, 'holofoil'), { price: 10, approx: false });
  const empty = unsureNamed({ price_grid: multiGrid({ normal: null, holofoil: null }) });
  assert.equal(guessQuote(empty, null), null);
  assert.equal(guessPrice(empty, null), null);
});

test('lot totals: an approx printing guess counts under Guesses, never Sure', () => {
  const card = unsureNamed({ price_grid: multiGrid({ normal: 2, holofoil: 10 }) });
  const t = lotTotals([card], () => null);
  assert.equal(t.sure.low, 0);
  assert.equal(t.guess, 10);
  assert.equal(t.guessed, 1);
});

const imageGuess = (price, extra = {}) => ({
  identity: { id: 'e-1', name: 'Eevee' }, confidence: 0.7, setConfirmed: false,
  bestGuess: { source: 'image', reason: 'best guess from the picture' },
  setChoices: [{ id: 'a' }, { id: 'b' }], market_price: price, price_grid: multiGrid({ normal: price }),
  ...extra,
});

test('lot totals: a picture-only best guess over the cap is to check, not in Sure', () => {
  const t = lotTotals([imageGuess(800), imageGuess(5)], () => null);
  assert.equal(t.sure.high, 5);
  assert.equal(t.toCheck, 1);
  assert.equal(t.high, 5);
});

test('lot totals: a page or hint best guess over the cap still counts as Sure', () => {
  const page = imageGuess(800, { bestGuess: { source: 'page', reason: 'x' } });
  const hint = imageGuess(700, { bestGuess: { source: 'hint', reason: 'x' } });
  const t = lotTotals([page, hint], () => null);
  assert.equal(t.sure.high, 1500);
  assert.equal(t.toCheck, 0);
});

test('lot totals: a stale-grid price is to check, not summed, for sure rows and guess rows', () => {
  const stale = { identity: { id: 's-1', name: 'Mew' }, confidence: 0.95, market_price: 9, price_grid: multiGrid({ normal: 9 }, { stale: true }) };
  const fresh = { identity: { id: 'f-1', name: 'Mew' }, confidence: 0.95, market_price: 4, price_grid: multiGrid({ normal: 4 }) };
  const staleGuess = { abstain: true, topGuess: { id: 'g', name: 'Pikachu', price: 3, stale: true } };
  const t = lotTotals([stale, fresh, staleGuess], () => null);
  assert.equal(t.sure.high, 4);
  assert.equal(t.guess, 0);
  assert.equal(t.toCheck, 2);
});
