import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cornerRects, stripSize, parseCornerText, choiceFromCorner } from '../tools/extension-wasm/lib/corner-read.js';
import { catalogSetsForCode } from '../tools/extension-wasm/lib/set-codes.js';

test('both bottom corners are cut from the source box', () => {
  const rects = cornerRects([100, 200, 300, 480], 1000, 1000);
  assert.equal(rects.length, 2);
  const [left, right] = rects;
  assert.equal(left.side, 'left');
  assert.equal(left.rect[0], 100);
  assert.equal(right.side, 'right');
  assert.equal(right.rect[0] + right.rect[2], 300);
  for (const { rect } of rects) {
    assert.ok(Math.abs(rect[2] - 68) <= 1, 'about 34% of the card width');
    assert.ok(rect[1] >= 200 + 0.85 * 280 - 1, 'starts in the bottom strip');
    assert.ok(rect[1] + rect[3] <= 480 + 1);
  }
});

test('corner rects stay inside the picture when the box runs past the edge', () => {
  for (const { rect } of cornerRects([-20, 900, 180, 1200], 1000, 1000)) {
    assert.ok(rect[0] >= 0 && rect[1] >= 0);
    assert.ok(rect[0] + rect[2] <= 1000 && rect[1] + rect[3] <= 1000);
    assert.ok(rect[2] > 0 && rect[3] > 0);
  }
});

test('corner rects are empty for a degenerate box', () => {
  assert.deepEqual(cornerRects([10, 10, 10, 10], 100, 100), []);
});

test('a strip is scaled so the number text is about 100 px, with sides the detector accepts', () => {
  const { width, height, scale } = stripSize(200, 83, 832);
  assert.ok(Math.abs(scale - 100 / (0.022 * 832)) < 1e-9);
  assert.equal(width % 32, 0);
  assert.equal(height % 32, 0);
});

test('a strip never gets wider than the detector can take', () => {
  const { width } = stripSize(400, 120, 300);
  assert.ok(width <= 1400 + 16);
});

test('a card already large is not shrunk and a tiny one is not blown up past the cap', () => {
  assert.equal(stripSize(500, 400, 8000).scale, 1);
  assert.equal(stripSize(20, 10, 40).scale, 12);
});

test('the reader gluing the code to the language still gives the code', () => {
  assert.deepEqual(parseCornerText('G SVPEN 078'), { number: '078', total: null, code: 'SVP' });
  assert.deepEqual(parseCornerText('SVPEN078'), { number: '078', total: null, code: 'SVP' });
  assert.equal(parseCornerText('PALEN 063/193').code, 'PAL');
});

test('older cards print number and total', () => {
  assert.deepEqual(parseCornerText('088/132'), { number: '088', total: 132, code: null });
  assert.equal(parseCornerText('Illus. Mitsuhiro Arita 4/102 *').number, '4');
});

test('a slash read as a 1 and a rarity symbol read as a digit still give the pair', () => {
  assert.deepEqual(parseCornerText('+10 PAOO 771320'), { number: '77', total: 132, code: null });
  assert.equal(parseCornerText('? 771320').total, 132);
  assert.equal(parseCornerText('12345678'), null);
});

test('Sword & Shield prints number and total at the bottom left', () => {
  const read = parseCornerText('025/216');
  assert.equal(read.number, '025');
  assert.equal(read.total, 216);
});

test('Scarlet & Violet prints a set code, language, number and total', () => {
  assert.deepEqual(parseCornerText('SVI EN 123/198'), { number: '123', total: 198, code: 'SVI' });
  assert.equal(parseCornerText('PAF EN 045/091').code, 'PAF');
  assert.equal(parseCornerText('G MEW EN 006/165').code, 'MEW');
});

test('a promo prints a code and a bare number', () => {
  assert.deepEqual(parseCornerText('SVP EN 045'), { number: '045', total: null, code: 'SVP' });
  assert.deepEqual(parseCornerText('SWSH123'), { number: 'SWSH123', total: null, code: null });
  assert.equal(parseCornerText('BW 45').number, 'BW45');
  assert.equal(parseCornerText('XY12').number, 'XY12');
  assert.equal(parseCornerText('SM123').number, 'SM123');
  assert.equal(parseCornerText('HGSS07').number, 'HGSS07');
});

test('trainer gallery numbers keep their prefix', () => {
  const read = parseCornerText('TG12/TG30');
  assert.equal(read.number, 'TG12');
  assert.equal(read.total, 30);
});

test('text with no number is not a read', () => {
  assert.equal(parseCornerText('Illus. Someone'), null);
  assert.equal(parseCornerText(''), null);
  assert.equal(parseCornerText(null), null);
});

test('a code that is not a printed set code is ignored', () => {
  assert.equal(parseCornerText('ABC EN 12/200').code, null);
});

test('printed set codes map to catalog set codes', () => {
  assert.deepEqual(catalogSetsForCode('PAL'), ['sv02']);
  assert.deepEqual(catalogSetsForCode('obf'), ['sv03']);
  assert.deepEqual(catalogSetsForCode('BLK'), ['sv10.5b']);
  assert.deepEqual(catalogSetsForCode('NOPE'), []);
});

const choice = (setCode, number, id = `${setCode}-${number}`) => ({ id, setCode, number, name: 'Pikachu', set: setCode });

test('a number and total pick the one choice of that size', () => {
  const choices = [choice('swsh1', '025'), choice('swsh9', '025')];
  const hit = choiceFromCorner(choices, { number: '025', total: 202, code: null }, new Map());
  assert.equal(hit.choice.id, 'swsh1-025');
  assert.equal(hit.via, 'number');
});

test('a number that matches none of the choices is not accepted', () => {
  const choices = [choice('swsh1', '025'), choice('swsh9', '026')];
  assert.equal(choiceFromCorner(choices, { number: '077', total: 202, code: null }, new Map()), null);
});

test('a total that fits neither choice is not accepted', () => {
  const choices = [choice('swsh1', '025'), choice('swsh9', '025')];
  assert.equal(choiceFromCorner(choices, { number: '025', total: 64, code: null }, new Map()), null);
});

test('a printed set code picks its set, and is strong evidence', () => {
  const choices = [choice('sv01', '063'), choice('sv02', '063'), choice('sv03', '063')];
  const hit = choiceFromCorner(choices, { number: '063', total: 193, code: 'PAL' }, new Map());
  assert.equal(hit.choice.id, 'sv02-063');
  assert.equal(hit.via, 'code');
});

test('a code naming a set with several printings is settled by the number', () => {
  const choices = [choice('svp', '078'), choice('svp', '033'), choice('sv02', '015')];
  assert.equal(choiceFromCorner(choices, { number: '078', total: null, code: 'SVP' }, new Map()).choice.id, 'svp-078');
  assert.equal(choiceFromCorner(choices, { number: '099', total: null, code: 'SVP' }, new Map()), null);
});

test('a code for a set that is not on offer is not accepted', () => {
  const choices = [choice('sv01', '063'), choice('sv03', '063')];
  assert.equal(choiceFromCorner(choices, { number: '063', total: 193, code: 'PAL' }, new Map()), null);
});

test('a bare number is accepted only when one choice has it', () => {
  const unique = [choice('svp', '045'), choice('sve', '010')];
  assert.equal(choiceFromCorner(unique, { number: '045', total: null, code: null }, new Map()).choice.id, 'svp-045');
  const tied = [choice('svp', '045'), choice('sve', '045')];
  assert.equal(choiceFromCorner(tied, { number: '045', total: null, code: null }, new Map()), null);
});

test('a promo number picks the promo set', () => {
  const choices = [choice('swshp', 'SWSH123'), choice('swsh1', '123')];
  assert.equal(choiceFromCorner(choices, { number: 'SWSH123', total: null, code: null }, new Map()).choice.id, 'swshp-SWSH123');
});

test('nothing to match', () => {
  assert.equal(choiceFromCorner([], { number: '1', total: 10, code: null }, new Map()), null);
  assert.equal(choiceFromCorner([choice('a', '1')], null, new Map()), null);
});
