import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fitWithin, photoRecord, MAX_SIDE } from '../tools/extension-wasm/lib/test-photos.js';

test('fitWithin keeps small photos and scales big ones to a 2000px longest side', () => {
  assert.equal(MAX_SIDE, 2000);
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600, scale: 1 });
  assert.deepEqual(fitWithin(4000, 3000), { width: 2000, height: 1500, scale: 0.5 });
  assert.deepEqual(fitWithin(1000, 5000), { width: 400, height: 2000, scale: 0.4 });
});

const jpeg = 'data:image/jpeg;base64,AAAA';

test('photoRecord keeps the photo, its boxes, and where it came from, and nothing the scanner decided', () => {
  const record = photoRecord({
    id: 'abc',
    ts: 9,
    pageUrl: 'https://www.ebay.com/itm/123?hash=secret#x',
    photo: jpeg,
    boxes: [[10.4, 20.6, 100, 200]],
    scale: 0.5,
    score: 0.99,
    identity: { id: 'base1-4' },
  });
  assert.deepEqual(record, {
    id: 'abc',
    ts: 9,
    pageUrl: 'https://www.ebay.com/itm/123',
    host: 'www.ebay.com',
    photo: jpeg,
    boxes: [[5, 10, 50, 100]],
  });
});

test('photoRecord boxes are in the stored photo pixels', () => {
  const record = photoRecord({ id: 'a', ts: 1, pageUrl: 'https://x.test/', photo: jpeg, boxes: [[100, 200, 300, 400]], scale: 0.25 });
  assert.deepEqual(record.boxes, [[25, 50, 75, 100]]);
});

test('photoRecord refuses a record that would be useless as a test photo', () => {
  const ok = { id: 'a', ts: 1, pageUrl: 'https://x.test/', photo: jpeg, boxes: [], scale: 1 };
  assert.doesNotThrow(() => photoRecord(ok));
  assert.throws(() => photoRecord({ ...ok, photo: 'data:image/png;base64,AA' }), /JPEG/);
  assert.throws(() => photoRecord({ ...ok, photo: null }), /JPEG/);
  assert.throws(() => photoRecord({ ...ok, id: '' }), /id/);
  assert.throws(() => photoRecord({ ...ok, scale: 0 }), /scale/);
  assert.throws(() => photoRecord({ ...ok, boxes: [[1, 2, 3]] }), /box/);
});

test('photoRecord leaves page and host empty when the URL is not a web page', () => {
  const record = photoRecord({ id: 'a', ts: 1, pageUrl: 'chrome://x', photo: jpeg, boxes: [], scale: 1 });
  assert.equal(record.host, null);
  assert.equal(record.pageUrl, null);
  const none = photoRecord({ id: 'a', ts: 1, pageUrl: 'nonsense', photo: jpeg, boxes: [], scale: 1 });
  assert.equal(none.pageUrl, null);
  assert.equal(none.host, null);
});

test('a photo id carries its size so the total is known without reading any photo', async () => {
  const { idWithSize, statsFromIds } = await import('../tools/extension-wasm/lib/test-photos.js');
  assert.equal(idWithSize('abcd', 1500), 'abcd.1500');
  assert.deepEqual(statsFromIds(['abcd.1500', 'ef01.500']), { count: 2, bytes: 2000 });
  assert.deepEqual(statsFromIds(['no-size', 'x.NaN']), { count: 2, bytes: 0 });
  assert.deepEqual(statsFromIds([]), { count: 0, bytes: 0 });
});

test('collection stops at 500 photos or 400 MB, whichever comes first', async () => {
  const { limitReached, LIMITS, describeSize } = await import('../tools/extension-wasm/lib/test-photos.js');
  assert.deepEqual(LIMITS, { photos: 500, bytes: 400 * 1024 * 1024 });
  assert.equal(limitReached({ count: 499, bytes: 1 }), false);
  assert.equal(limitReached({ count: 500, bytes: 1 }), true);
  assert.equal(limitReached({ count: 3, bytes: 400 * 1024 * 1024 }), true);
  assert.equal(limitReached({ count: 3, bytes: 400 * 1024 * 1024 - 1 }), false);
  assert.equal(describeSize(0), '0 MB');
  assert.equal(describeSize(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(describeSize(250 * 1024 * 1024), '250 MB');
});
