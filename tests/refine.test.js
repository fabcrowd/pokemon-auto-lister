import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_SOURCE_GAIN, looksLikeCard, mergeSourceRead, sourceRefineOrder, tileSource } from '../tools/extension-wasm/lib/refine.js';

const view = (x, extra = {}) => ({ rect: { x, y: 0, w: 100, h: 140 }, ...extra });
const withSrc = (x, src = 'https://img.example/a.png', naturalHeight = 400) => view(x, { src, naturalWidth: 290, naturalHeight });

test('tileSource: a tile uses its own picture', () => {
  const views = [withSrc(0, 'https://img.example/own.png'), withSrc(500)];
  assert.equal(tileSource(views, 0).src, 'https://img.example/own.png');
});

test('tileSource: a slot with no picture borrows the one lying over the same spot, not a neighbour', () => {
  const slot = view(0);
  const over = withSrc(4, 'https://img.example/over.png');
  const neighbour = withSrc(120, 'https://img.example/next.png');
  assert.equal(tileSource([slot, neighbour, over], 0).src, 'https://img.example/over.png');
  assert.equal(tileSource([slot, neighbour], 0), null);
});

test('tileSource: no picture anywhere, or an unloaded one, is null', () => {
  assert.equal(tileSource([view(0)], 0), null);
  assert.equal(tileSource([view(0, { src: 'https://img.example/a.png', naturalHeight: 0 })], 0), null);
  assert.equal(tileSource([], 0), null);
});

test('sourceRefineOrder: only unsettled tiles whose picture holds clearly more pixels, in page order, capped', () => {
  const cards = [{ lowCertainty: true }, { lowCertainty: false }, { lowCertainty: true }, { lowCertainty: true }, { lowCertainty: true }];
  const hint = (naturalHeight) => ({ src: 'https://img.example/a.png', naturalHeight, shownPx: 200 });
  const hints = [hint(400), hint(400), hint(200 * MIN_SOURCE_GAIN), null, hint(900)];
  assert.deepEqual(sourceRefineOrder(cards, hints), [0, 4]);
  assert.deepEqual(sourceRefineOrder(cards, hints, 1), [0]);
});

test('mergeSourceRead: a settled source read replaces the guess but the tile keeps its place on the page', () => {
  const card = { box: [1, 2, 3, 4], score: 1, docBox: [5, 6, 7, 8], via: 'v', lowCertainty: true, unsure: true, identity: { id: 'a' }, ranked: [{ id: 'a' }] };
  const read = { abstain: false, identity: { id: 'b', name: 'B' }, confidence: 0.8 };
  const out = mergeSourceRead(card, read, () => assert.fail('not asked for a guess'));
  assert.equal(out.identity.id, 'b');
  assert.equal(out.lowCertainty, undefined);
  assert.equal(out.unsure, undefined);
  assert.equal(out.ranked, undefined);
  assert.deepEqual(out.box, [1, 2, 3, 4]);
  assert.deepEqual(out.docBox, [5, 6, 7, 8]);
  assert.equal(out.refinedFromSource, true);
});

test('mergeSourceRead: an unsettled source read with a closest card re-ranks the guess; without one the card is unchanged', () => {
  const card = { box: [1, 2, 3, 4], lowCertainty: true, identity: { id: 'a' } };
  const read = { abstain: true, nearest: ['c'] };
  const guess = { ...read, lowCertainty: true, identity: { id: 'c' } };
  assert.equal(mergeSourceRead(card, read, () => guess).identity.id, 'c');
  assert.equal(mergeSourceRead(card, read, () => read), card);
  assert.equal(mergeSourceRead(card, null, () => guess), card);
  assert.equal(mergeSourceRead(card, { cardBack: true, abstain: true }, () => guess), card);
});

test('looksLikeCard: portrait card shapes only', () => {
  assert.equal(looksLikeCard(245, 342), true);
  assert.equal(looksLikeCard(342, 245), false);
  assert.equal(looksLikeCard(300, 300), false);
  assert.equal(looksLikeCard(0, 0), false);
});
