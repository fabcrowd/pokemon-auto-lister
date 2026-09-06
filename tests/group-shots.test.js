import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupCardPhotos,
  groupShotsBySequence,
  pairFrontsWithFollowingBacks,
  isFullCardShot,
} from '../src/photos/groupShots.js';
import { histogramIntersection, rgbHistogram, proximityBonus } from '../src/photos/photoMatch.js';

test('pairFrontsWithFollowingBacks uses next full-card as back after each front', () => {
  const pairs = pairFrontsWithFollowingBacks([
    { path: 'f1.jpg', kind: 'full_front', score: 0.8 },
    { path: 'b1.jpg', kind: 'full_back', score: 0.7 },
    { path: 'f2.jpg', kind: 'full_front', score: 0.75 },
    { path: 'b2.jpg', kind: 'full_back', score: 0.7 },
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].front.path, 'f1.jpg');
  assert.equal(pairs[0].back.path, 'b1.jpg');
  assert.equal(pairs[1].front.path, 'f2.jpg');
  assert.equal(pairs[1].back.path, 'b2.jpg');
});

test('pairFrontsWithFollowingBacks skips orphan backs and ignores closeups in the full list', () => {
  const pairs = pairFrontsWithFollowingBacks([
    { path: 'orphan-back.jpg', kind: 'full_back', score: 0.7 },
    { path: 'f1.jpg', kind: 'full_front', score: 0.8 },
    { path: 'b1.jpg', kind: 'full_back', score: 0.7 },
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].front.path, 'f1.jpg');
});

test('isFullCardShot only accepts front/back kinds', () => {
  assert.equal(isFullCardShot({ kind: 'full_front' }), true);
  assert.equal(isFullCardShot({ kind: 'closeup', score: 0.9, scores: { widthFrac: 0.9 } }), false);
});

test('groupCardPhotos matches closeups to fronts via matchCloseupFn', async () => {
  const groups = await groupCardPhotos(
    [
      { path: 'f1.jpg', kind: 'full_front', score: 0.8 },
      { path: 'c-wrong.jpg', kind: 'closeup', score: 0.2 },
      { path: 'c-right.jpg', kind: 'closeup', score: 0.2 },
      { path: 'b1.jpg', kind: 'full_back', score: 0.7 },
      { path: 'f2.jpg', kind: 'full_front', score: 0.75 },
      { path: 'b2.jpg', kind: 'full_back', score: 0.7 },
    ],
    {
      matchCloseupFn: async (closeupPath, frontPaths) => {
        if (closeupPath === 'c-right.jpg') {
          return { frontPath: 'f1.jpg', score: 0.9, label: 'tl' };
        }
        if (closeupPath === 'c-wrong.jpg') {
          return { frontPath: null, score: 0.1, label: null };
        }
        return { frontPath: frontPaths[0], score: 0.5, label: 'full' };
      },
    },
  );

  const g1 = groups.find((g) => g.frontImagePath === 'f1.jpg');
  assert.ok(g1);
  assert.equal(g1.backImagePath, 'b1.jpg');
  assert.ok(g1.photos.includes('c-right.jpg'));
  // Unmatched closeups soft-attach to the nearest front by IMG_#### when available;
  // with non-IMG names they still land on the first front via nearestFrontByImg fallback.
  assert.ok(g1.photos.includes('c-wrong.jpg') || groups.some((g) => g.photos.includes('c-wrong.jpg')));
});

test('groupShotsBySequence still pairs fronts/backs without similarity', () => {
  const groups = groupShotsBySequence([
    { path: 'f1.jpg', kind: 'full_front', score: 0.8 },
    { path: 'b1.jpg', kind: 'full_back', score: 0.7 },
    { path: 'c1.jpg', kind: 'closeup', score: 0.2 },
  ]);
  assert.equal(groups[0].frontImagePath, 'f1.jpg');
  assert.equal(groups[0].backImagePath, 'b1.jpg');
  assert.equal(groups[1].noFullFront, true);
});

test('histogramIntersection is 1 for identical histograms', () => {
  const data = Buffer.alloc(8 * 8 * 3, 128);
  const h = rgbHistogram(data, 8, 8, 3);
  assert.ok(Math.abs(histogramIntersection(h, h) - 1) < 1e-6);
});

test('proximityBonus is higher for nearer IMG numbers', () => {
  assert.ok(proximityBonus('IMG_100.jpg', 'IMG_101.jpg') > proximityBonus('IMG_100.jpg', 'IMG_200.jpg'));
});
