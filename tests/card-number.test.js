import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  textBoxes, ctcDecode, parseCardNumber, setSizes, printingByNumber, printingByExactTotal, exactTotalHits,
  prefixTotals, promoCollectorNumber, blackStarPromo,
} from '../tools/extension-wasm/lib/card-number.js';

function probMap(width, height, rects) {
  const map = new Float32Array(width * height);
  for (const [x1, y1, x2, y2, p] of rects) {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) map[y * width + x] = p;
  }
  return map;
}

test('each blob of text becomes one box, grown a little past its edges', () => {
  const map = probMap(100, 40, [[10, 10, 40, 20, 0.9], [60, 25, 90, 32, 0.8]]);
  const boxes = textBoxes(map, 100, 40);
  assert.equal(boxes.length, 2);
  const [first] = boxes.sort((a, b) => a.x1 - b.x1);
  assert.ok(first.x1 < 10 && first.y1 < 10 && first.x2 > 40 && first.y2 > 20);
  assert.ok(first.x1 >= 0 && first.y1 >= 0);
});

test('faint blobs and specks are not text', () => {
  const map = probMap(100, 40, [[10, 10, 40, 20, 0.4], [70, 10, 72, 12, 0.9]]);
  assert.deepEqual(textBoxes(map, 100, 40), []);
});

test('a sparse line is judged on its own strokes when asked, not on the empty space around them', () => {
  // Three thin strokes joined by a faint bridge: the box is mostly empty, the strokes are sure.
  const map = probMap(100, 40, [[10, 10, 12, 30, 0.95], [30, 10, 32, 30, 0.95], [50, 10, 52, 30, 0.95], [10, 19, 52, 21, 0.35]]);
  assert.deepEqual(textBoxes(map, 100, 40), []);
  assert.equal(textBoxes(map, 100, 40, { strokeScore: true }).length, 1);
});

test('the decoder drops blanks and repeats and keeps only plain characters', () => {
  const classes = 6625;
  const steps = [93, 93, 0, 25, 0, 25, 487, 3539, 94, 0, 25];
  const probs = new Float32Array(steps.length * classes);
  steps.forEach((cls, t) => { probs[t * classes + cls] = 1; });
  assert.equal(ctcDecode(probs, steps.length, classes), '122/h32');
});

test('a collector number is read as number and printed total', () => {
  assert.deepEqual(parseCardNumber(['2007Pokemon/Nintendo', '88/132']), { number: '88', total: 132 });
  assert.deepEqual(parseCardNumber(['85 / 112']), { number: '85', total: 112 });
  assert.deepEqual(parseCardNumber(['77/1320']), { number: '77', total: 132 });
  assert.deepEqual(parseCardNumber(['TG01/TG30']), { number: 'TG01', total: 30 });
});

test('a letter O inside the number is a zero', () => {
  assert.deepEqual(parseCardNumber(['O7/1O2']), { number: '07', total: 102 });
});

test('a letter I beside the digits is a one', () => {
  assert.deepEqual(parseCardNumber(['95/I32']), { number: '95', total: 132 });
  assert.deepEqual(parseCardNumber(['I999 Wizards 8/102']), { number: '8', total: 102 });
  assert.equal(parseCardNumber(['I995,96,98 Nintendo']), null);
});

test('words in front of the number are not part of it', () => {
  assert.deepEqual(parseCardNumber(['SVI EN 001/198']), { number: '001', total: 198 });
  assert.deepEqual(parseCardNumber(['MEW EN 001/165']), { number: '001', total: 165 });
  assert.deepEqual(parseCardNumber(['ILLUS.KAGEMARU HIMENO 058/165']), { number: '058', total: 165 });
  assert.equal(parseCardNumber(['EN001/165']), null);
});

test('a slash read as the digit 1 is still the collector number', () => {
  assert.deepEqual(parseCardNumber(['Wizards 39164']), { number: '39', total: 64 });
  assert.deepEqual(parseCardNumber(['53164@ SHOPGOODWILL']), { number: '53', total: 64 });
  assert.deepEqual(parseCardNumber(['Wrds33164']), { number: '33', total: 64 });
  assert.deepEqual(parseCardNumber(['17162']), { number: '17', total: 62 });
  assert.deepEqual(parseCardNumber(['flavor 11162 and 39164']), { number: '39', total: 64 });
  assert.deepEqual(parseCardNumber(['2164★']), { number: '2', total: 64 });
  assert.deepEqual(parseCardNumber(['55/640']), { number: '55', total: 64 });
  assert.deepEqual(parseCardNumber(['Sugimori 11624']), { number: '11', total: 62 });
  assert.deepEqual(parseCardNumber(['631102 | 1999Wizards.']), { number: '63', total: 102 });
  assert.equal(parseCardNumber(['1999102']), null);
});

test('a slash read as 1 keeps a three-digit number and needs no digit before it', () => {
  assert.deepEqual(parseCardNumber(['1011102']), { number: '101', total: 102 });
  assert.equal(parseCardNumber(['123456162']), null);
});

test('a truncated total can be one digit short of a real set size', () => {
  assert.deepEqual(prefixTotals(13), [130, 131, 132, 135]);
  assert.deepEqual(prefixTotals(132), []);
  assert.deepEqual(prefixTotals(64), []);
  assert.deepEqual(prefixTotals(7), []);
});

test('a copyright year is not a collector number', () => {
  assert.equal(parseCardNumber(['1995,96,98 Nintendo']), null);
  assert.equal(parseCardNumber(['©1999 Wizards']), null);
});

test('text without a number/total gives nothing', () => {
  assert.equal(parseCardNumber(['DPBP#224', '2007Pokemon/Nintendo', '+20']), null);
  assert.equal(parseCardNumber([]), null);
});

const rows = [
  { setCode: 'dp3', number: '82' }, { setCode: 'dp3', number: '112' },
  { setCode: 'ex6', number: '82' }, { setCode: 'base1', number: '46' },
];
const sizes = new Map([['dp3', 132], ['ex6', 116], ['base1', 102], ['sv1', 258]]);

test('cards are counted per set', () => {
  const counted = setSizes([{ setCode: 'a' }, { setCode: 'a' }, { setCode: 'b' }]);
  assert.equal(counted.get('a'), 2);
  assert.equal(counted.get('b'), 1);
});

test('the number picks the printing whose set has that many cards', () => {
  assert.equal(printingByNumber(rows, { number: '82', total: 132 }, sizes), 0);
  assert.equal(printingByNumber(rows, { number: '82', total: 112 }, sizes), 2);
  assert.equal(printingByNumber(rows, { number: '046', total: 102 }, sizes), 3);
});

test('a number with the wrong set size is a misread, not a match', () => {
  assert.equal(printingByNumber(rows, { number: '12', total: 132 }, sizes), null);
  assert.equal(printingByNumber(rows, { number: '46', total: 132 }, sizes), null);
});

test('modern sets with many secret rares still match their printed total', () => {
  const modern = [{ setCode: 'sv1', number: '198' }];
  assert.equal(printingByNumber(modern, { number: '198', total: 198 }, sizes), 0);
});

test('a letter misread for a digit still finds the printing', () => {
  const energy = [{ setCode: 'ex15', number: '87' }, { setCode: 'swsh9tg', number: 'TG07' }];
  const withSizes = new Map([['ex15', 101], ['swsh9tg', 30]]);
  assert.equal(printingByNumber(energy, { number: 'B7', total: 101 }, withSizes), 0);
  assert.equal(printingByNumber(energy, { number: 'TG07', total: 30 }, withSizes), 1);
});

test('official set totals beat a closer catalog row count', () => {
  const modern = [
    { setCode: 'sv03.5', number: '1' },
    { setCode: 'me01', number: '1' },
  ];
  const catalogCounts = new Map([['sv03.5', 207], ['me01', 188]]);
  assert.equal(printingByNumber(modern, { number: '001', total: 165 }, catalogCounts), 0);
});

test('a letter-prefixed subset is matched by its own count', () => {
  const holos = Array.from({ length: 32 }, (_, i) => ({ setCode: 'ecard2', number: `H${i + 1}` }));
  assert.equal(printingByNumber(holos, { number: 'H01', total: 32 }, new Map([['ecard2', 169]])), 0);
});

test('an exact set total names the one card with that number', () => {
  const tied = [
    { setCode: 'base1', number: '63' },
    { setCode: 'hgss4', number: '63' },
  ];
  assert.equal(printingByExactTotal([{ setCode: 'base1', number: '63' }], { number: '63', total: 102 }, new Map()), 0);
  assert.equal(printingByExactTotal(tied, { number: '63', total: 102 }, new Map()), null);
  assert.equal(printingByExactTotal(tied, { number: '63', total: 112 }, new Map()), null);
  assert.deepEqual(exactTotalHits(
    [{ setCode: 'gym1', number: '14' }, { setCode: 'gym2', number: '14' }],
    { number: '14', total: 132 },
    new Map(),
  ), [0, 1]);
});

test('a black-star promo number is the bare number at the right, not a set total', () => {
  assert.equal(promoCollectorNumber('83 | 29'), '29');
  assert.equal(promoCollectorNumber('2000 Wiards | 22'), '22');
  assert.equal(promoCollectorNumber('8 | 00Wizards'), '8');
  assert.equal(promoCollectorNumber('0Wizards. | 23'), '23');
  assert.equal(promoCollectorNumber('#149 | 43 | W'), '43');
  assert.equal(promoCollectorNumber('4/64'), null);
  assert.equal(promoCollectorNumber('19/64 ★'), null);
  assert.equal(promoCollectorNumber(''), null);
  const promos = [
    { id: 'basep-29', setCode: 'basep', number: '29', name: 'Marill' },
    { id: 'basep-8', setCode: 'basep', number: '8', name: 'Mew' },
    { id: 'base2-29', setCode: 'base2', number: '29', name: 'Oddish' },
  ];
  assert.equal(blackStarPromo(promos, '29')?.id, 'basep-29');
  assert.equal(blackStarPromo(promos, '8')?.id, 'basep-8');
  assert.equal(blackStarPromo(promos.concat([{ id: 'basep-29b', setCode: 'basep', number: '29', name: 'Marill' }]), '29'), null);
  assert.equal(blackStarPromo(promos, null), null);
});

test('an impossible total is ignored when only one printing has the number', () => {
  assert.equal(printingByNumber(rows, { number: '112', total: 712 }, sizes), 1);
  assert.equal(printingByNumber(rows, { number: '82', total: 712 }, sizes), null);
});
