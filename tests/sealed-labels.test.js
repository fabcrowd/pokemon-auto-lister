import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLabel, currentLabels, isPhotoDone, progressOf, truthOf, drawnFor, validPhotoRow,
} from '../scripts/lib/sealed-labels.mjs';

const sha = 'a'.repeat(64);
const photo = (boxes) => ({ sha, boxes, width: 100, height: 100 });
const catalogHas = (id) => id === 'base1-4';

test('a card label needs a catalog id and optional edition and finish', () => {
  const ok = validateLabel(
    { sha, boxIndex: 0, kind: 'card', cardId: 'base1-4', edition: 'first', finish: null },
    { photo: photo([[0, 0, 5, 5]]), catalogHas, now: 7 },
  );
  assert.deepEqual(ok, { sha, boxIndex: 0, cardId: 'base1-4', edition: 'first', finish: null, kind: 'card', ts: 7 });
});

test('rejects what could not be a real label', () => {
  const ctx = { photo: photo([[0, 0, 5, 5]]), catalogHas, now: 1 };
  const bad = [
    { sha: 'xyz', boxIndex: 0, kind: 'not-card' },
    { sha, boxIndex: 1, kind: 'not-card' },
    { sha, boxIndex: -1, kind: 'not-card' },
    { sha, boxIndex: 0.5, kind: 'not-card' },
    { sha, boxIndex: '0', kind: 'not-card' },
    { sha, boxIndex: 0, kind: 'nope' },
    { sha, boxIndex: 0, kind: 'card', cardId: 'missing-1' },
    { sha, boxIndex: 0, kind: 'card', cardId: null },
    { sha, boxIndex: 0, kind: 'card', cardId: 'base1-4', edition: 'second' },
    { sha, boxIndex: 0, kind: 'card', cardId: 'base1-4', finish: 'shiny' },
    { sha, boxIndex: 0, kind: 'not-card', cardId: 'base1-4' },
    { sha, boxIndex: 0, kind: 'bad-box', finish: 'normal' },
    { sha, boxIndex: 0, kind: 'unknown', edition: 'first' },
    { sha, boxIndex: 0, kind: 'photo', missed: 2 },
    { sha, boxIndex: 0, kind: 'removed' },
    null,
    'text',
  ];
  for (const body of bad) assert.throws(() => validateLabel(body, ctx), /label/i, JSON.stringify(body));
});

test('not-card, bad-box and unknown boxes carry no identity', () => {
  const ctx = { photo: photo([[0, 0, 5, 5]]), catalogHas, now: 2 };
  for (const kind of ['not-card', 'bad-box']) {
    assert.deepEqual(validateLabel({ sha, boxIndex: 0, kind }, ctx),
      { sha, boxIndex: 0, cardId: null, edition: null, finish: null, kind, ts: 2 });
  }
  assert.equal(validateLabel({ sha, boxIndex: 0, kind: 'unknown' }, ctx).kind, 'unknown');
});

test('a photo row records how many cards could not be boxed', () => {
  const ctx = { photo: photo([]), catalogHas, now: 3 };
  assert.deepEqual(validateLabel({ sha, kind: 'photo', missed: 2 }, ctx),
    { sha, boxIndex: null, cardId: null, edition: null, finish: null, kind: 'photo', missed: 2, ts: 3 });
  assert.throws(() => validateLabel({ sha, kind: 'photo', missed: -1 }, ctx), /missed/);
  assert.throws(() => validateLabel({ sha, kind: 'photo', missed: 1.5 }, ctx), /missed/);
  assert.throws(() => validateLabel({ sha, kind: 'photo', missed: 500 }, ctx), /missed/);
  assert.throws(() => validateLabel({ sha, kind: 'photo', boxIndex: 0, missed: 1 }, ctx), /label/i);
});

test('a drawn box is a card the detector missed, with a box of the person own making', () => {
  const ctx = { photo: photo([]), catalogHas, now: 4 };
  assert.deepEqual(
    validateLabel({ sha, drawn: true, drawnId: 0, box: [10.4, 20, 60, 90.6], kind: 'card', cardId: 'base1-4', edition: 'first', finish: 'holofoil' }, ctx),
    { sha, boxIndex: null, drawn: true, drawnId: 0, box: [10, 20, 60, 91], cardId: 'base1-4', edition: 'first', finish: 'holofoil', kind: 'card', ts: 4 },
  );
  assert.equal(validateLabel({ sha, drawn: true, drawnId: 3, box: [0, 0, 50, 50], kind: 'unknown' }, ctx).kind, 'unknown');
  assert.deepEqual(
    validateLabel({ sha, drawn: true, drawnId: 3, kind: 'removed' }, ctx),
    { sha, boxIndex: null, drawn: true, drawnId: 3, box: null, cardId: null, edition: null, finish: null, kind: 'removed', ts: 4 },
  );
});

test('rejects drawn boxes that are not on the photo or not a box', () => {
  const ctx = { photo: photo([]), catalogHas, now: 1 };
  const base = { sha, drawn: true, drawnId: 0, kind: 'unknown' };
  const bad = [
    { ...base, box: [0, 0, 5, 5] },
    { ...base, box: [50, 50, 20, 90] },
    { ...base, box: [0, 0, 101, 50] },
    { ...base, box: [-5, 0, 50, 50] },
    { ...base, box: [0, 0, 50] },
    { ...base, box: ['0', 0, 50, 50] },
    { ...base, drawnId: -1, box: [0, 0, 50, 50] },
    { ...base, drawnId: 60, box: [0, 0, 50, 50] },
    { ...base, drawnId: 1.5, box: [0, 0, 50, 50] },
    { ...base, kind: 'not-card', box: [0, 0, 50, 50] },
    { ...base, kind: 'card', cardId: 'nope', box: [0, 0, 50, 50] },
    { ...base, kind: 'removed', cardId: 'base1-4' },
    { ...base, boxIndex: 0, box: [0, 0, 50, 50] },
  ];
  for (const body of bad) assert.throws(() => validateLabel(body, ctx), /label/i, JSON.stringify(body));
});

test('the last label for a box wins, and drawn boxes can be removed', () => {
  const rows = [
    { sha, boxIndex: 0, kind: 'unknown', ts: 1 },
    { sha, boxIndex: 1, kind: 'not-card', ts: 2 },
    { sha, boxIndex: 0, kind: 'card', cardId: 'base1-4', ts: 3 },
    { sha, boxIndex: null, kind: 'photo', missed: 1, ts: 4 },
    { sha, boxIndex: null, kind: 'photo', missed: 2, ts: 5 },
    { sha, boxIndex: null, drawn: true, drawnId: 1, box: [0, 0, 9, 9], kind: 'unknown', ts: 6 },
    { sha, boxIndex: null, drawn: true, drawnId: 0, box: [0, 0, 9, 9], kind: 'unknown', ts: 7 },
    { sha, boxIndex: null, drawn: true, drawnId: 1, box: null, kind: 'removed', ts: 8 },
  ];
  const current = currentLabels(rows);
  assert.equal(current.boxes.get(`${sha}:0`).kind, 'card');
  assert.equal(current.boxes.get(`${sha}:1`).kind, 'not-card');
  assert.equal(current.photos.get(sha).missed, 2);
  assert.deepEqual(drawnFor(sha, current).map((row) => row.drawnId), [0]);
});

test('a photo is done when every box is labeled and the person finished the photo', () => {
  const two = photo([[0, 0, 1, 1], [1, 1, 2, 2]]);
  const rows = [{ sha, boxIndex: 0, kind: 'unknown' }, { sha, boxIndex: 1, kind: 'unknown' }];
  assert.equal(isPhotoDone(two, currentLabels(rows.slice(0, 1))), false);
  assert.equal(isPhotoDone(two, currentLabels(rows)), false);
  rows.push({ sha, boxIndex: null, kind: 'photo', missed: 0 });
  assert.equal(isPhotoDone(two, currentLabels(rows)), true);
  assert.equal(isPhotoDone(two, currentLabels(rows.slice(1))), false);
  assert.equal(isPhotoDone(photo([]), currentLabels([])), false);
  assert.equal(isPhotoDone(photo([]), currentLabels([{ sha, boxIndex: null, kind: 'photo', missed: 0 }])), true);
});

test('progress counts every box and every photo review as a unit', () => {
  const photos = [photo([[0, 0, 1, 1], [1, 1, 2, 2]]), { sha: 'b'.repeat(64), boxes: [] }];
  const current = currentLabels([{ sha, boxIndex: 0, kind: 'unknown' }]);
  assert.deepEqual(progressOf(photos, current), { labeled: 1, total: 4 });
});

test('truthOf pairs each box with its label, adds drawn boxes, and carries the unboxable count', () => {
  const two = photo([[0, 0, 5, 5], [6, 6, 9, 9], [1, 1, 3, 3]]);
  const current = currentLabels([
    { sha, boxIndex: 0, kind: 'card', cardId: 'base1-4', edition: 'first', finish: null },
    { sha, boxIndex: 1, kind: 'not-card', cardId: null, edition: null, finish: null },
    { sha, boxIndex: 2, kind: 'bad-box', cardId: null, edition: null, finish: null },
    { sha, boxIndex: null, kind: 'photo', missed: 3 },
    { sha, boxIndex: null, drawn: true, drawnId: 0, box: [20, 20, 60, 60], kind: 'card', cardId: 'base1-4', edition: null, finish: 'normal' },
    { sha, boxIndex: null, drawn: true, drawnId: 1, box: [30, 30, 40, 40], kind: 'removed' },
  ]);
  assert.deepEqual(truthOf(two, current), {
    truth: [
      { box: [0, 0, 5, 5], kind: 'card', cardId: 'base1-4', edition: 'first', finish: null },
      { box: [6, 6, 9, 9], kind: 'not-card', cardId: null, edition: null, finish: null },
      { box: [1, 1, 3, 3], kind: 'bad-box', cardId: null, edition: null, finish: null },
      { box: [20, 20, 60, 60], kind: 'card', cardId: 'base1-4', edition: null, finish: 'normal' },
    ],
    missed: 3,
  });
  assert.deepEqual(truthOf(photo([]), currentLabels([])), { truth: [], missed: 0 });
});

test('validPhotoRow accepts only rows whose file is exactly photos/<sha>.jpg', () => {
  const row = { sha, file: `photos/${sha}.jpg`, boxes: [[0, 0, 5, 5]], width: 10, height: 10 };
  assert.equal(validPhotoRow(row), true);
  for (const bad of [
    { ...row, file: `photos/../${sha}.jpg` },
    { ...row, file: `../${sha}.jpg` },
    { ...row, file: `photos/${'b'.repeat(64)}.jpg` },
    { ...row, file: `C:\\x\\${sha}.jpg` },
    { ...row, sha: 'short' },
    { ...row, boxes: 'x' },
    { ...row, boxes: [[1, 2, 3]] },
    { ...row, width: 0 },
    { ...row, height: 1.5 },
    null,
  ]) assert.equal(validPhotoRow(bad), false, JSON.stringify(bad));
});
