import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topGuessOf, guessPrice, lotTotals, readFromSmallCrop } from '../tools/extension-wasm/lib/card-display.js';
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
