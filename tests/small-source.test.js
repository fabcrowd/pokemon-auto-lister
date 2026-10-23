import assert from 'node:assert/strict';
import test from 'node:test';
import { SMALL_SOURCE_CONFIDENCE_CAP, capHeightFor, informationHeight, markChoose, naturalPerFedFor } from '../tools/extension-wasm/lib/fusion.js';
import { confTier } from '../tools/extension-wasm/lib/card-display.js';
import { isUnsure } from '../tools/extension-wasm/lib/card-picker.js';

const named = { identity: { id: 'a-1', name: 'Mewtwo V-UNION' }, confidence: 0.49, abstain: false, market_price: 10.94, choose: true };

test('a CHOOSE read from a tiny crop is returned as an unsure suggestion with its name', () => {
  const marked = markChoose(named, 199);
  assert.equal(marked.confidence, SMALL_SOURCE_CONFIDENCE_CAP);
  assert.equal(confTier(marked.confidence), 'low');
  assert.equal(isUnsure(marked), true);
  assert.equal(marked.identity.name, 'Mewtwo V-UNION');
  assert.equal(marked.abstain, false);
  assert.equal(marked.smallSource, true);
  assert.equal(marked.unsure, true);
  assert.equal('choose' in marked, false);
});

test('an unknown crop height is not treated as small', () => {
  for (const h of [0, undefined, NaN]) assert.equal(markChoose(named, h).smallSource, undefined);
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

test("a card read from a fetched original is judged at the original's pixels, not the shown photo's", () => {
  // shown 720 px photo, original 1600 px: a card 150 px tall on the original has 150 px of information.
  const shownScale = 720 / 1600;
  const perFed = naturalPerFedFor({ fromSource: true, shownNaturalPerFed: shownScale });
  assert.equal(perFed, 1);
  assert.equal(informationHeight(150, perFed), 150);
  // the old rule scaled it down to the shown size
  assert.equal(informationHeight(150, shownScale), 67.5);
});

test('screenshot and tile reads keep the shown-scale rule; unknown natural size stays unlimited', () => {
  assert.equal(naturalPerFedFor({ fromSource: false, shownNaturalPerFed: 0.5 }), 0.5);
  assert.equal(naturalPerFedFor({ fromSource: false, shownNaturalPerFed: undefined }), undefined);
  assert.equal(informationHeight(200, naturalPerFedFor({ fromSource: false, shownNaturalPerFed: undefined })), 200);
});

test('a srcset upgrade or a plain source read is already at its own pixels', () => {
  assert.equal(naturalPerFedFor({ fromSource: true, shownNaturalPerFed: undefined }), 1);
  assert.equal(informationHeight(300, naturalPerFedFor({ fromSource: true, shownNaturalPerFed: 0.25 })), 300);
});
