import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCard, confirmGuess, isSetConfirmed, isUnsure, lotEstimate } from '../tools/extension-wasm/lib/card-display.js';
import { setMenuCorrection } from '../tools/extension-wasm/lib/card-picker.js';

const guessedRow = {
  identity: { id: 'sv02-5', name: 'Eevee', set: 'Paldea Evolved', setCode: 'sv02', number: '005' },
  setChoices: [{ id: 'sv01-5' }, { id: 'sv02-5' }],
  setConfirmed: false,
  bestGuess: { source: 'hint', reason: 'Page says Paldea Evolved' },
  confidence: 0.7,
  market_price: 3,
  price_grid: { variants: { normal: { conditions: { NM: 3 } } } },
};

test('a best-guess row is shown like a settled one, but is still not confirmed', () => {
  assert.equal(isSetConfirmed(guessedRow), true);
  assert.equal(isUnsure(guessedRow), false);
  assert.equal(classifyCard(guessedRow), 'identified');
});

test('once the user picks another set the guess no longer applies', () => {
  const picked = { ...guessedRow, bestGuess: undefined, setConfirmed: false, identity: { name: 'Eevee' } };
  assert.equal(isSetConfirmed(picked), false);
});

test('the lot estimate counts a best guess at its single price', () => {
  const lot = lotEstimate([guessedRow], () => 'normal');
  assert.equal(lot.low, 3);
  assert.equal(lot.high, 3);
  assert.equal(lot.identified, 1);
});

test('an unrecognised card still counts nothing', () => {
  const lot = lotEstimate([{ abstain: true, identity: null }], () => null);
  assert.equal(lot.high, 0);
  assert.equal(lot.toIdentify, 1);
});

test('confirming the guess settles the row and keeps the menu', () => {
  const next = confirmGuess(guessedRow);
  assert.equal(next.bestGuess, undefined);
  assert.equal(next.setConfirmed, true);
  assert.equal(next.setChoices.length, 2);
  assert.equal(next.identity.id, 'sv02-5');
});

test('confirming a row that is not a guess changes nothing', () => {
  const plain = { identity: { id: 'a' }, setChoices: [] };
  assert.equal(confirmGuess(plain), plain);
});

const scan = { bgScanId: 7, cards: [{ guess: { id: 'sv02-5', choiceIds: ['sv01-5', 'sv02-5'] } }] };

test('choosing a set in the menu is saved as a correction', () => {
  assert.deepEqual(setMenuCorrection(scan, 0, 'sv01-5', 'set-menu'), {
    action: 'saveCorrection', scanId: 7, index: 0, guess: scan.cards[0].guess, pickedId: 'sv01-5', via: 'set-menu',
  });
});

test('confirming the guess saves the guessed printing as the answer', () => {
  const message = setMenuCorrection(scan, 0, 'sv02-5', 'guess-confirmed');
  assert.equal(message.pickedId, 'sv02-5');
  assert.equal(message.via, 'guess-confirmed');
});

test('choosing no set, or a card that is not there, saves nothing', () => {
  assert.equal(setMenuCorrection(scan, 0, '', 'set-menu'), null);
  assert.equal(setMenuCorrection(scan, 3, 'x', 'set-menu'), null);
  assert.equal(setMenuCorrection(null, 0, 'x', 'set-menu'), null);
});
