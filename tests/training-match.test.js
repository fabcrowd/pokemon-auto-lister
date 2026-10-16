import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listingKey, trainingKeysFrom } from '../scripts/lib/training-match.mjs';

test('listingKey names the marketplace listing in a URL', () => {
  assert.equal(listingKey('https://shopgoodwill.com/item/279630564'), 'goodwill:279630564');
  assert.equal(listingKey('https://shopgoodwill.com/item/279630564?x=1#top'), 'goodwill:279630564');
  assert.equal(listingKey('https://www.shopgoodwill.com/Item/279630564'), 'goodwill:279630564');
  assert.equal(listingKey('https://hibid.com/lot/320425372/some-title'), 'hibid:320425372');
  assert.equal(listingKey('https://www.facebook.com/marketplace/item/1776567153539399/'), 'facebook:1776567153539399');
  assert.equal(listingKey('https://www.ebay.com/itm/3057'), 'ebay:3057');
});

test('listingKey is null for pages it cannot tell apart', () => {
  assert.equal(listingKey('https://www.ebay.com/sch/i.html'), null);
  assert.equal(listingKey('not a url'), null);
  assert.equal(listingKey(null), null);
  assert.equal(listingKey('https://example.com/item/12'), null);
});

test('trainingKeysFrom reads manifest lines and marketplace folder names', () => {
  const keys = trainingKeysFrom({
    manifestLines: ['{"listing": "270067229", "file": "a.jpg"}', '', 'broken', '{"file": "no-listing.jpg"}'],
    folders: { goodwill: ['273298162'], hibid: ['hibid_320425371'], facebook: ['facebook_946237095188044'] },
  });
  assert.deepEqual([...keys].sort(), [
    'facebook:946237095188044',
    'goodwill:270067229',
    'goodwill:273298162',
    'hibid:320425371',
  ]);
  assert.equal(keys.has(listingKey('https://shopgoodwill.com/item/270067229')), true);
});
