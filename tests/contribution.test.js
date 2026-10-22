import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CROP_LONG_SIDE, MAX_CARDS, MAX_CROP_CHARS, buildContribution, dayOf, modelTags, normalizeBox, cropSize, scannerOf, validateContribution } from '../tools/extension-wasm/lib/contribution.js';
import { EMBEDDING_VERSION } from '../tools/extension-wasm/lib/embed.js';

const INSTALL = '3f2b1c9e-8a47-4d65-9b0e-1c2d3e4f5a6b';
const row = (over = {}) => ({
  box: [0.1, 0.2, 0.3, 0.4],
  crop: 'QUJD',
  answer: { cardId: 'base1-4' },
  scanner: { cardId: 'base1-5', confidence: 0.4, stripe: 'low' },
  source: 'pick',
  ...over,
});
// 0000000000000001 is teach; 0000000000000005 is exam.
const good = (over = {}) => ({
  v: 1, install: INSTALL, split: 'teach', photoId: '0000000000000001', day: '2026-10-16',
  model: { clip: 'd15ade1768efb9c3', crop: EMBEDDING_VERSION }, catalog: '2f3c50cec84937ff',
  cards: [row()], ...over,
});

test('a well-formed contribution has no errors', () => {
  assert.deepEqual(validateContribution(good()), []);
});

test('model tags are the first 16 hex of the pinned CLIP model and catalog hashes', () => {
  assert.deepEqual(modelTags(), { clip: 'd15ade1768efb9c3', catalog: '2f3c50cec84937ff', crop: EMBEDDING_VERSION });
});

test('every field is checked', () => {
  const bad = (contribution, pattern) => {
    const errors = validateContribution(contribution);
    assert.ok(errors.some((e) => pattern.test(e)), `${pattern}: ${JSON.stringify(errors)}`);
  };
  bad(good({ v: 2 }), /^v/);
  bad(good({ install: 'nope' }), /install/);
  bad(good({ split: 'maybe' }), /split/);
  bad(good({ photoId: 'ABC' }), /photoId/);
  bad(good({ split: 'exam' }), /split.*photoId/);
  bad(good({ photoId: '0000000000000005' }), /split.*photoId/);
  bad(good({ day: '16-10-2026' }), /day/);
  bad(good({ model: { clip: 'zz', crop: 2 } }), /model\.clip/);
  bad(good({ model: { clip: 'd15ade1768efb9c3', crop: 0 } }), /model\.crop/);
  bad(good({ catalog: '12' }), /catalog/);
  bad(good({ cards: [] }), /cards/);
  bad(good({ cards: Array.from({ length: MAX_CARDS + 1 }, () => row()) }), /cards/);
  bad(good({ cards: [row({ box: [0, 0, 1] })] }), /box/);
  bad(good({ cards: [row({ box: [-0.1, 0, 0.5, 0.5] })] }), /box/);
  bad(good({ cards: [row({ box: [0.5, 0, 0.6, 0.5] })] }), /box/);
  bad(good({ cards: [row({ box: [0, 0, 0, 0.5] })] }), /box/);
  bad(good({ cards: [row({ crop: '' })] }), /crop/);
  bad(good({ cards: [row({ crop: 'not base64!' })] }), /crop/);
  bad(good({ cards: [row({ crop: 'A'.repeat(MAX_CROP_CHARS + 1) })] }), /crop/);
  bad(good({ cards: [row({ answer: {} })] }), /answer/);
  bad(good({ cards: [row({ answer: { cardId: '' } })] }), /answer/);
  bad(good({ cards: [row({ answer: { cardId: 'a', unknown: true } })] }), /answer/);
  bad(good({ cards: [row({ answer: { notACard: false } })] }), /answer/);
  bad(good({ cards: [row({ scanner: { cardId: 5, confidence: 0.4, stripe: 'low' } })] }), /scanner\.cardId/);
  bad(good({ cards: [row({ scanner: { cardId: null, confidence: 2, stripe: 'low' } })] }), /scanner\.confidence/);
  bad(good({ cards: [row({ scanner: { cardId: null, confidence: 0.5, stripe: 'loud' } })] }), /scanner\.stripe/);
  bad(good({ cards: [row({ source: 'guess' })] }), /source/);
  bad(good({ extra: 1 }), /extra/);
  bad(good({ cards: [row({ pageUrl: 'https://x' })] }), /pageUrl/);
  bad(null, /object/);
});

test('the three answer shapes and a null scanner card are accepted', () => {
  const cards = [
    row({ answer: { notACard: true }, source: 'confirm', scanner: { cardId: null, confidence: 0, stripe: 'none' } }),
    row({ answer: { unknown: true }, source: 'wrong-card' }),
    row({ answer: { cardId: 'x1' }, source: 'confirm' }),
  ];
  assert.deepEqual(validateContribution(good({ cards })), []);
});

test('an exam contribution is split exam with an exam photo', () => {
  assert.deepEqual(validateContribution(good({ split: 'exam', photoId: '0000000000000005' })), []);
});

test('buildContribution fills the model tags, split and day, and validates', () => {
  const built = buildContribution({ install: INSTALL, photoId: '0000000000000005', cards: [row()], now: new Date('2026-10-16T23:59:00Z') });
  assert.equal(built.split, 'exam');
  assert.equal(built.day, '2026-10-16');
  assert.equal(built.model.clip, 'd15ade1768efb9c3');
  assert.equal(built.catalog, '2f3c50cec84937ff');
  assert.equal(built.v, 1);
  assert.throws(() => buildContribution({ install: 'x', photoId: '0000000000000005', cards: [row()] }), /install/);
});

test('dayOf is the UTC date', () => {
  assert.equal(dayOf(new Date('2026-01-02T23:30:00-05:00')), '2026-01-03');
});

test('normalizeBox turns a pixel box into fractions of the photo', () => {
  assert.deepEqual(normalizeBox([100, 50, 300, 250], 1000, 500), [0.1, 0.1, 0.2, 0.4]);
  assert.deepEqual(normalizeBox([-10, -10, 2000, 900], 1000, 500), [0, 0, 1, 1]);
  assert.equal(normalizeBox([5, 5, 5, 9], 100, 100), null);
});

test('scannerOf reads what the scanner said about a card', () => {
  assert.deepEqual(scannerOf({ identity: { id: 'a' }, confidence: 0.9 }), { cardId: 'a', confidence: 0.9, stripe: 'high' });
  assert.deepEqual(scannerOf({ identity: { id: 'a' }, confidence: 0.6 }), { cardId: 'a', confidence: 0.6, stripe: 'medium' });
  assert.deepEqual(scannerOf({ identity: { id: 'a' }, confidence: 0.2 }), { cardId: 'a', confidence: 0.2, stripe: 'low' });
  assert.deepEqual(scannerOf({ identity: null, abstain: true, confidence: 0 }), { cardId: null, confidence: 0, stripe: 'none' });
  assert.deepEqual(scannerOf({ identity: { id: 'a' }, confidence: 7 }), { cardId: 'a', confidence: 1, stripe: 'high' });
  assert.deepEqual(scannerOf(null), { cardId: null, confidence: 0, stripe: 'none' });
});

test('cropSize scales the long side to 320 and keeps the shape', () => {
  assert.equal(CROP_LONG_SIDE, 320);
  assert.deepEqual(cropSize(375, 525), { width: 229, height: 320 });
  assert.deepEqual(cropSize(800, 400), { width: 320, height: 160 });
  assert.deepEqual(cropSize(100, 100), { width: 320, height: 320 });
});
