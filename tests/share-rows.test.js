import { test } from 'node:test';
import assert from 'node:assert/strict';

import { examGroups, examRows, shareFor, teachRow, wantsExamPrompt } from '../tools/extension-wasm/lib/share-rows.js';
import { splitOf } from '../tools/extension-wasm/lib/photo-id.js';

const scanner = (cardId = 'a') => ({ cardId, confidence: 0.5, stripe: 'medium' });
const share = (photoId, index, cardId) => ({ photoId, split: splitOf(photoId), box: [0, 0, 0.5, 0.5], scanner: scanner(cardId ?? `s${index}`) });
const EXAM = '0000000000000005';
const TEACH = '0000000000000001';

test('shareFor ties a card to its photo with the split and a normalized box', () => {
  const made = shareFor({ photoId: EXAM, box: [10, 10, 60, 110], width: 100, height: 200, card: { identity: { id: 'x' }, confidence: 0.9 } });
  assert.deepEqual(made, { photoId: EXAM, split: 'exam', box: [0.1, 0.05, 0.5, 0.5], scanner: { cardId: 'x', confidence: 0.9, stripe: 'high' } });
  assert.equal(shareFor({ photoId: TEACH, box: [5, 5, 5, 5], width: 100, height: 100, card: {} }), null);
});

test('a pick or a Wrong card? fix becomes one row', () => {
  const row = teachRow({ share: share(TEACH, 0), crop: 'QUJD', pickedId: 'base1-4', via: 'wrong-card' });
  assert.deepEqual(row, { box: [0, 0, 0.5, 0.5], crop: 'QUJD', answer: { cardId: 'base1-4' }, scanner: scanner('s0'), source: 'wrong-card' });
  assert.equal(teachRow({ share: share(TEACH, 0), crop: 'QUJD', pickedId: 'x', via: 'candidates' }).source, 'pick');
  assert.equal(teachRow({ share: share(TEACH, 0), crop: 'QUJD', pickedId: 'x', via: 'search' }).source, 'pick');
});

test('exam rows are grouped by photo and teach rows are left out', () => {
  const shares = [share(EXAM, 0), share(TEACH, 1), share(EXAM, 2), null, share('00000000000000a0', 4)];
  const groups = examGroups(shares);
  assert.deepEqual([...groups.entries()], [[EXAM, [0, 2]], ['00000000000000a0', [4]]]);
  assert.equal(wantsExamPrompt(shares), true);
  assert.equal(wantsExamPrompt([share(TEACH, 0), null]), false);
  assert.equal(wantsExamPrompt([]), false);
});

test('confirming an exam photo answers every row: fixes first, then what the popup showed', () => {
  const shares = [share(EXAM, 0), share(EXAM, 1), share(EXAM, 2), share(EXAM, 3)];
  const rows = examRows({
    shares,
    indices: [0, 1, 2, 3],
    crops: ['c0', 'c1', 'c2', 'c3'],
    picks: { 1: { cardId: 'fixed', source: 'wrong-card' }, 3: { cardId: 'chosen', source: 'pick' } },
    displayed: { 0: { cardId: 'seen' }, 1: { cardId: 'ignored-because-fixed' }, 2: { notACard: true }, 3: { unknown: true } },
    known: (id) => id !== 'bad',
  });
  assert.deepEqual(rows.map((r) => [r.answer, r.source]), [
    [{ cardId: 'seen' }, 'confirm'],
    [{ cardId: 'fixed' }, 'wrong-card'],
    [{ notACard: true }, 'confirm'],
    [{ cardId: 'chosen' }, 'pick'],
  ]);
  assert.deepEqual(rows.map((r) => r.crop), ['c0', 'c1', 'c2', 'c3']);
  assert.deepEqual(rows[0].scanner, scanner('s0'));
});

test('a row nothing is known about, or whose id is not in the catalog, is answered unknown', () => {
  const rows = examRows({
    shares: [share(EXAM, 0), share(EXAM, 1)],
    indices: [0, 1],
    crops: ['c0', 'c1'],
    picks: {},
    displayed: { 0: { cardId: 'bad' } },
    known: (id) => id !== 'bad',
  });
  assert.deepEqual(rows.map((r) => r.answer), [{ unknown: true }, { unknown: true }]);
});

test('a photo with a row that has no picture cannot be sent as a whole, so none of it is', () => {
  assert.equal(examRows({ shares: [share(EXAM, 0), share(EXAM, 1)], indices: [0, 1], crops: ['c0', null], picks: {}, displayed: {}, known: () => true }), null);
});
