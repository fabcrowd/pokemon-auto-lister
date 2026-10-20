import assert from 'node:assert/strict';
import test from 'node:test';
import { BELOW_HIGH_CONFIDENCE, MIN_NAME_HEIGHT, MIN_RELIABLE_HEIGHT, SMALL_SOURCE_CONFIDENCE_CAP, capHeightFor, capSmallSource, informationHeight } from '../tools/extension-wasm/lib/fusion.js';
import { confTier } from '../tools/extension-wasm/lib/card-display.js';
import { isUnsure } from '../tools/extension-wasm/lib/card-picker.js';

const named = { identity: { id: 'a-1', name: 'Mewtwo V-UNION' }, confidence: 0.91, abstain: false, market_price: 10.94 };

test('a card read from a tiny crop is never returned above the unsure level', () => {
  const capped = capSmallSource(named, MIN_NAME_HEIGHT - 1);
  assert.equal(capped.confidence, SMALL_SOURCE_CONFIDENCE_CAP);
  assert.equal(confTier(capped.confidence), 'low');
  assert.equal(isUnsure(capped), true);
  assert.equal(capped.identity.name, 'Mewtwo V-UNION');
  assert.equal(capped.abstain, false);
  assert.equal(capped.smallSource, true);
  assert.equal(capped.unsure, true);
});

test('a crop tall enough to read keeps its confidence', () => {
  assert.equal(capSmallSource(named, MIN_RELIABLE_HEIGHT), named);
  assert.equal(capSmallSource(named, 1200), named);
});

test('an unknown crop height is not treated as small', () => {
  assert.equal(capSmallSource(named, 0), named);
  assert.equal(capSmallSource(named, undefined), named);
  assert.equal(capSmallSource(named, NaN), named);
});

test('a read that is already unsure or abstained is left alone', () => {
  const low = { identity: { name: 'Onix' }, confidence: 0.3, abstain: false };
  const abstained = { identity: null, confidence: 0.4, abstain: true };
  assert.equal(capSmallSource(low, 100), low);
  assert.equal(capSmallSource(abstained, 100), abstained);
  assert.equal(capSmallSource(null, 100), null);
});

test('the height the matcher can use is the smaller of the pixels shown and the picture\'s own pixels', () => {
  assert.equal(informationHeight(800, 1), 800);
  assert.equal(informationHeight(600, 0.5), 300);
  assert.equal(informationHeight(240, 4), 240);
  assert.equal(informationHeight(240, 0), 240);
  assert.equal(informationHeight(240, undefined), 240);
  assert.equal(informationHeight(0, 1), 0);
});

test('the size cap is not applied on grid pages, where small tiles are normal', () => {
  assert.equal(capHeightFor('grid', 120), 0);
  assert.equal(capHeightFor('listing', 120), 120);
  assert.equal(capHeightFor('unknown', 120), 120);
});

test('a read from a mid-size crop keeps its name, below high, and is not unsure', () => {
  const kept = capSmallSource(named, MIN_NAME_HEIGHT);
  assert.equal(kept.confidence, BELOW_HIGH_CONFIDENCE);
  assert.equal(confTier(kept.confidence), 'medium');
  assert.equal(kept.unsure, undefined);
  assert.equal(kept.smallSource, true);
  assert.equal(kept.confidenceBeforeSmallCap, 0.91);
  assert.equal(isUnsure(kept), false);
  const medium = { ...named, confidence: 0.7 };
  const same = capSmallSource(medium, MIN_RELIABLE_HEIGHT - 1);
  assert.equal(same.confidence, 0.7);
  assert.equal(same.smallSource, true);
});
