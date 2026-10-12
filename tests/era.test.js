import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ERAS, eraById, seriesOf, inEra, eraPrintings } from '../tools/extension-wasm/lib/era.js';

const card = (id, setCode, series) => ({
  id, setCode, imageUrl: series ? `https://assets.tcgdex.net/en/${series}/${setCode}/1/high.webp` : undefined,
});

test('the series comes from the TCGdex image path', () => {
  assert.equal(seriesOf(card('ex16-64', 'ex16', 'ex')), 'ex');
  assert.equal(seriesOf(card('dp3-77', 'dp3', 'dp')), 'dp');
  assert.equal(seriesOf(card('np-40', 'np', 'pop')), 'pop');
});

test('cards without an image fall back to the set code', () => {
  assert.equal(seriesOf(card('ecard2-H1', 'ecard2')), 'ecard');
  assert.equal(seriesOf(card('swsh9tg-TG01', 'swsh9tg')), 'swsh');
  assert.equal(seriesOf(card('sve-1', 'sve')), 'sv');
  assert.equal(seriesOf(card('smp-SM01', 'smp')), 'sm');
  assert.equal(seriesOf(card('cel25-1', 'cel25')), 'swsh');
  assert.equal(seriesOf(card('bwp-BW1', 'bwp')), 'bw');
  assert.equal(seriesOf(card('xy8-1', 'xy8')), 'xy');
});

test('2004-2007 lots: EX, POP and Diamond & Pearl are one era, HeartGold is not', () => {
  const era = eraById('ex-dp');
  assert.ok(inEra(card('ex6-82', 'ex6', 'ex'), era));
  assert.ok(inEra(card('pop4-4', 'pop4', 'pop'), era));
  assert.ok(inEra(card('dp3-112', 'dp3', 'dp'), era));
  assert.ok(!inEra(card('hgss3-24', 'hgss3', 'hgss'), era));
  assert.ok(!inEra(card('sm3-6', 'sm3', 'sm'), era));
});

test('every era has a label and unknown ids mean any era', () => {
  for (const era of ERAS) assert.ok(era.id && era.label && era.series.length);
  assert.equal(eraById('nope'), null);
  assert.equal(eraById(''), null);
});

test('a clear lead inside the era picks that printing', () => {
  const scored = [{ index: 1, score: 0.848 }, { index: 2, score: 0.739 }];
  assert.deepEqual(eraPrintings(scored), { pick: 1 });
});

test('the only printing in the era is picked', () => {
  assert.deepEqual(eraPrintings([{ index: 7, score: 0.69 }]), { pick: 7 });
});

test('a close race offers the two best and any others nearly as close', () => {
  const scored = [
    { index: 1, score: 0.900 }, { index: 2, score: 0.897 }, { index: 3, score: 0.894 },
    { index: 4, score: 0.870 }, { index: 5, score: 0.860 },
  ];
  assert.deepEqual(eraPrintings(scored), { choices: [1, 2, 3] });
});

test('a lead under 0.04 still offers a second printing', () => {
  const scored = [{ index: 1, score: 0.791 }, { index: 2, score: 0.758 }, { index: 3, score: 0.70 }];
  assert.deepEqual(eraPrintings(scored), { choices: [1, 2] });
});

test('no more than four choices', () => {
  const scored = Array.from({ length: 6 }, (_, i) => ({ index: i, score: 0.8 - i * 0.001 }));
  assert.deepEqual(eraPrintings(scored), { choices: [0, 1, 2, 3] });
});

test('nothing in the era gives no answer', () => {
  assert.equal(eraPrintings([]), null);
});
