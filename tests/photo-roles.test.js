import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  inferBackImagePath,
  orderedListingPhotos,
  pickBackImagePath,
  resolvePhotoRoles,
} from '../src/photos/roles.js';

test('pickBackImagePath prefers explicit backImagePath', () => {
  const photos = ['/a.jpg', '/b.jpg', '/c.jpg'];
  assert.equal(
    pickBackImagePath({ photos, frontImagePath: '/a.jpg', backImagePath: '/c.jpg' }),
    '/c.jpg',
  );
});

test('pickBackImagePath falls back to first non-front', () => {
  assert.equal(
    pickBackImagePath({ photos: ['/a.jpg', '/b.jpg'], frontImagePath: '/a.jpg' }),
    '/b.jpg',
  );
});

test('orderedListingPhotos puts front then back then extras', () => {
  assert.deepEqual(
    orderedListingPhotos({
      photos: ['/extra.jpg', '/front.jpg', '/back.jpg'],
      frontImagePath: '/front.jpg',
      backImagePath: '/back.jpg',
    }),
    ['/front.jpg', '/back.jpg', '/extra.jpg'],
  );
});

test('resolvePhotoRoles swaps front and back within the same batch', () => {
  const photos = ['/a.jpg', '/b.jpg'];
  const next = resolvePhotoRoles(photos, {
    frontImagePath: '/b.jpg',
    backImagePath: '/a.jpg',
  });
  assert.equal(next.frontImagePath, '/b.jpg');
  assert.equal(next.backImagePath, '/a.jpg');
  assert.deepEqual(next.photos, ['/b.jpg', '/a.jpg']);
});

test('resolvePhotoRoles rejects paths outside the batch', () => {
  assert.throws(
    () => resolvePhotoRoles(['/a.jpg'], { frontImagePath: '/missing.jpg' }),
    /frontImagePath must be one of the card photos/,
  );
});

test('resolvePhotoRoles rejects front === back', () => {
  assert.throws(
    () => resolvePhotoRoles(['/a.jpg', '/b.jpg'], { frontImagePath: '/a.jpg', backImagePath: '/a.jpg' }),
    /cannot be the same/,
  );
});

test('inferBackImagePath skips the front', () => {
  assert.equal(inferBackImagePath(['/f.jpg', '/b.jpg'], '/f.jpg'), '/b.jpg');
  assert.equal(inferBackImagePath(['/f.jpg'], '/f.jpg'), null);
});
