import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setChoices } from '../tools/extension-wasm/lib/set-choice.js';

const meta = [
  { id: 'ex8-93', name: 'Boost Energy', set: 'Deoxys', setCode: 'ex8', number: '93' },
  { id: 'ex10-98', name: 'Boost Energy', set: 'Unseen Forces', setCode: 'ex10', number: '98' },
  { id: 'pop5-8', name: 'Cyclone Energy', set: 'POP Series 5', setCode: 'pop5', number: '8' },
  { id: 'ex15-87', name: 'Boost Energy', set: 'Dragon Frontiers', setCode: 'ex15', number: '87' },
  { id: 'dp7-95', name: 'Boost Energy', set: 'Stormfront', setCode: 'dp7', number: '95' },
  { id: 'ex13-54', name: 'Vibrava δ', set: 'Holon Phantoms', setCode: 'ex13', number: '54' },
  { id: 'xy5-109', name: 'Vibrava', set: 'Primal Clash', setCode: 'xy5', number: '109' },
  { id: 'ex12-88', name: 'Mew ex', set: 'Legend Maker', setCode: 'ex12', number: '88' },
  { id: 'pop4-4', name: 'Mew', set: 'POP Series 4', setCode: 'pop4', number: '4' },
];

const hit = (index, score) => ({ index, score });

test('close same-name matches from different sets are offered as choices', () => {
  const hits = [hit(0, 0.908), hit(1, 0.903), hit(2, 0.898), hit(3, 0.897), hit(4, 0.871)];
  const choices = setChoices(meta[0], hits, meta);
  assert.deepEqual(choices.map((c) => c.id), ['ex8-93', 'ex10-98', 'ex15-87']);
});

test('a match far below the best is not offered', () => {
  const hits = [hit(0, 0.908), hit(4, 0.871)];
  assert.deepEqual(setChoices(meta[0], hits, meta).map((c) => c.id), ['ex8-93']);
});

test('a delta card and the plain card share a name for choosing', () => {
  const hits = [hit(5, 0.797), hit(6, 0.790)];
  assert.deepEqual(setChoices(meta[5], hits, meta).map((c) => c.id), ['ex13-54', 'xy5-109']);
});

test('an ex card is a different card from the plain one', () => {
  const hits = [hit(8, 0.847), hit(7, 0.838)];
  assert.deepEqual(setChoices(meta[8], hits, meta).map((c) => c.id), ['pop4-4']);
});

test('the accepted card is offered even when its hit is not in the list', () => {
  assert.deepEqual(setChoices(meta[3], [hit(0, 0.9)], meta).map((c) => c.id), ['ex15-87', 'ex8-93']);
});

test('no more than four choices', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}-1`, name: 'Pikachu', set: `Set ${i}`, setCode: `s${i}`, number: '1',
  }));
  const hits = many.map((_, i) => hit(i, 0.9 - i * 0.001));
  assert.equal(setChoices(many[0], hits, many).length, 4);
});
