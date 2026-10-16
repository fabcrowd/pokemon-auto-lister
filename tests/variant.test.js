import { test } from 'node:test';
import assert from 'node:assert/strict';

import { choiceForStamp, confidentClass, finishFromNumber, finishFromVariants, finishSharedByNumber, stampAfterWizards, stampFromCorner, stampSetCode, variantChoice, variantTensor, EDITIONS, FINISHES } from '../tools/extension-wasm/lib/variant.js';
import { ART_STAMP_BOX, NAME_BOX, NUMBER_CORNER, NUMBER_STRIPS } from '../tools/extension-wasm/lib/ocr.js';

const base = { '1stEditionHolofoil': {}, unlimitedHolofoil: {}, holofoil: {} };
const jungle = { '1stEditionNormal': {}, unlimited: {} };
const modern = { holofoil: {}, reverseHolofoil: {}, normal: {} };

test('a white pixel is normalized the way the model was trained', () => {
  const tensor = variantTensor(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
  assert.ok(Math.abs(tensor[0] - (1 - 0.485) / 0.229) < 1e-6);
  assert.ok(Math.abs(tensor[2] - (1 - 0.406) / 0.225) < 1e-6);
});

test('a near tie is not a variant', () => {
  assert.equal(confidentClass([1.1, 1.0, 0.2], EDITIONS), null);
  assert.equal(confidentClass([0, 5, 0], FINISHES), 'reverse');
});

test('a Wizards copyright is not an ex-era set stamp', () => {
  assert.equal(stampAfterWizards('setstamp', '1999-2000 Wizards 18/132'), 'none');
  assert.equal(stampAfterWizards('setstamp', '1999-2000Wizds.'), 'none');
  assert.equal(stampAfterWizards('setstamp', '2003 Pokemon/Nintendo'), 'setstamp');
  assert.equal(stampAfterWizards('prerelease', '1999-2000 Wizards'), 'prerelease');
  assert.equal(stampAfterWizards('league', 'Wizards'), 'league');
});

test('the art-corner logo is a set stamp and an illustrator line is not', () => {
  assert.equal(stampFromCorner('HOLON | PHANTOMS'), 'setstamp');
  assert.equal(stampFromCorner('PLATINU 1N06WP13.7bs'), 'setstamp');
  assert.equal(stampFromCorner('llus. Kagemaru Hin'), 'none');
  assert.equal(stampFromCorner('11WT119.0Ibs'), 'none');
  assert.equal(stampFromCorner('Weight:14 Ibs. deck for a Basic'), 'none');
  assert.equal(stampFromCorner('?X | POWER | KEEPERS | llus.Ken Sugimori'), 'setstamp');
  assert.equal(stampFromCorner('EXOELTR | SPECIES | lus.Hajime'), 'setstamp');
  assert.equal(stampFromCorner('CRYSTAL | EX | GUARDIANS | lllus. Sachiko Adachi'), 'setstamp');
  assert.equal(stampFromCorner('CRYSTA | GUARDIA'), 'setstamp');
  assert.equal(stampFromCorner('OELTA | PECIES | llus.Ryo Ueda'), 'setstamp');
  assert.equal(stampFromCorner(''), null);
});

test('a fragment shorter than six letters is not read as a stamp', () => {
  assert.equal(stampFromCorner('FOR'), null);
  assert.equal(stampFromCorner('PLAT'), null);
  assert.equal(stampFromCorner('HOL EX PHAN llus.Mitsu'), 'none');
});

test('a misread Unseen Forces stamp keeps that set among the choices', () => {
  const choices = [
    { id: 'ex10-34', setCode: 'ex10' },
    { id: 'dp5-51', setCode: 'dp5' },
  ];
  assert.equal(stampSetCode('EUNSELN EORCES PKS'), 'ex10');
  assert.equal(choiceForStamp(choices, 'EUNSELN EORCES PKS')?.id, 'ex10-34');
  assert.equal(choiceForStamp(choices, 'FORCES')?.id, 'ex10-34');
  assert.equal(choiceForStamp(choices, 'Weight:19 Ibs.'), null);
  assert.equal(choiceForStamp(choices, 'HOLON PHANTOMS'), null);
  assert.equal(stampSetCode('OELTA PECIES'), 'ex11');
  assert.equal(stampSetCode('CRYSTAL GUARDIANS'), 'ex14');
  assert.equal(stampSetCode('CRYSTA GUARDIA'), 'ex14');
});

test('finish uses the same confidence bar as the other heads', () => {
  assert.equal(confidentClass([0, 0.7, 0], FINISHES), null);
  assert.equal(confidentClass([2, 0, 0], FINISHES), 'holofoil');
});

test('a 1st Edition holo photo selects that price', () => {
  const choice = variantChoice({ edition: 'first', finish: 'holofoil', stamp: 'none' }, base);
  assert.equal(choice.key, '1stEditionHolofoil');
  assert.equal(choice.stamp, null);
});

test('a 1st Edition photo with no finish still selects the only 1st Edition price', () => {
  assert.equal(variantChoice({ edition: 'first', finish: null }, jungle).key, '1stEditionNormal');
});

test('a finish alone does not pick a price when the edition is still open', () => {
  const grid = { '1stEditionHolofoil': {}, holofoil: {} };
  assert.equal(variantChoice({ edition: null, finish: 'holofoil', stamp: 'none' }, grid).key, null);
  assert.equal(variantChoice({ edition: 'standard', finish: 'holofoil', stamp: 'none' }, grid).key, 'holofoil');
  assert.equal(variantChoice({ edition: null, finish: 'normal' }, { unlimitedShadowless: {}, normal: {} }).key, null);
  assert.equal(variantChoice({ edition: null, finish: 'reverse' }, { normal: {}, reverseHolofoil: {} }).key, 'reverseHolofoil');
});

test('shadowless does not fall back to the unlimited price', () => {
  const choice = variantChoice({ edition: 'shadowless', finish: 'holofoil' }, { holofoil: {} });
  assert.equal(choice.key, null);
  assert.equal(choice.shadow, true);
  assert.equal(
    variantChoice({ edition: 'shadowless' }, { shadowlessHolofoil: {}, holofoil: {} }).key,
    'shadowlessHolofoil',
  );
});

test('reverse, holo, and normal each select their own price', () => {
  assert.equal(variantChoice({ finish: 'reverse' }, modern).key, 'reverseHolofoil');
  assert.equal(variantChoice({ edition: 'standard', finish: 'holofoil' }, modern).key, 'holofoil');
  assert.equal(variantChoice({ finish: 'normal' }, modern).key, 'normal');
});

test('two holo prices are not guessed between', () => {
  assert.equal(variantChoice({ finish: 'holofoil' }, base).key, null);
});

test('the collector number is the finish when that set prints holos as the low numbers', () => {
  assert.equal(finishFromNumber('base3', '30', 62), 'normal');
  assert.equal(finishFromNumber('base3', '15', 62), 'holofoil');
  assert.equal(finishFromNumber('base2', '2', 64), 'holofoil');
  assert.equal(finishFromNumber('base1', '63', 102), 'normal');
  assert.equal(finishFromNumber('base5', '2', 82), 'holofoil');
  assert.equal(finishFromNumber('base5', '17', 82), 'holofoil');
  assert.equal(finishFromNumber('base5', '19', 82), 'normal');
  assert.equal(finishFromNumber('base4', '20', 130), 'holofoil');
  assert.equal(finishFromNumber('base4', '21', 130), 'normal');
  assert.equal(finishFromNumber('base4', '30', 130), 'normal');
  assert.equal(finishFromNumber('base3', '30', 64), null);
  assert.equal(finishFromNumber('gym1', '19', 132), 'holofoil');
  assert.equal(finishFromNumber('gym1', '20', 132), 'normal');
  assert.equal(finishFromNumber('gym2', '20', 132), 'holofoil');
  assert.equal(finishFromNumber('gym2', '21', 132), 'normal');
  assert.equal(finishFromNumber('neo1', '19', 111), 'holofoil');
  assert.equal(finishFromNumber('neo1', '20', 111), 'normal');
  assert.equal(finishFromNumber('neo2', '17', 75), 'holofoil');
  assert.equal(finishFromNumber('neo2', '18', 75), 'normal');
  assert.equal(finishFromNumber('neo3', '14', 64), 'holofoil');
  assert.equal(finishFromNumber('neo3', '15', 64), 'normal');
  assert.equal(finishFromNumber('neo3', '66', 64), null);
  assert.equal(finishFromNumber('neo4', '16', 105), 'holofoil');
  assert.equal(finishFromNumber('neo4', '17', 105), 'normal');
  assert.equal(finishFromNumber('neo4', '106', 105), null);
  assert.equal(finishFromNumber('sv1', '30', 198), null);
});

test('a Wizards promo with one printing takes that finish', () => {
  assert.equal(finishFromVariants({ holo: false, normal: true, reverse: false }), 'normal');
  assert.equal(finishFromVariants({ holo: false, normal: false, reverse: true }), 'reverse');
  assert.equal(finishFromVariants({ holo: true, normal: false, reverse: false }), 'holofoil');
  assert.equal(finishFromVariants({ holo: true, normal: false, reverse: true }), null);
  assert.equal(finishFromVariants({ holo: false, normal: true, reverse: true }), null);
  assert.equal(finishFromVariants(null), null);
});

test('a tied collector number keeps the finish only when every set agrees', () => {
  const gengar = [{ setCode: 'gym1', number: '14' }, { setCode: 'gym2', number: '14' }];
  const slowpoke = [{ setCode: 'gym1', number: '95' }, { setCode: 'gym2', number: '95' }];
  const golem = [{ setCode: 'gym1', number: '20' }, { setCode: 'gym2', number: '20' }];
  const jungleHolo = [{ setCode: 'base2', number: '15' }, { setCode: 'neo3', number: '15' }];
  const bothNormal = [{ setCode: 'base2', number: '30' }, { setCode: 'neo3', number: '30' }];
  assert.equal(finishSharedByNumber(gengar, 132), 'holofoil');
  assert.equal(finishSharedByNumber(slowpoke, 132), 'normal');
  assert.equal(finishSharedByNumber(golem, 132), null);
  assert.equal(finishSharedByNumber(jungleHolo, 64), null);
  assert.equal(finishSharedByNumber(bothNormal, 64), 'normal');
  assert.equal(finishSharedByNumber(gengar.slice(0, 1), 132), null);
});

test('a 3x bottom band is only the fallback after the 1x strips', () => {
  assert.deepEqual(NUMBER_STRIPS.map((strip) => strip.scale), [1, 1, 3]);
  assert.ok(NUMBER_STRIPS[2].top > NUMBER_STRIPS[1].top);
  assert.ok(NUMBER_STRIPS[2].top < NUMBER_STRIPS[0].top);
});

test('the right-corner number is the last fallback', () => {
  assert.deepEqual(NUMBER_CORNER, { x1: 0.7, y1: 0.855, x2: 0.94, y2: 0.93, scale: 4 });
});

test('the name is read from the top of the card', () => {
  assert.deepEqual(NAME_BOX, { x1: 0, y1: 0, x2: 1, y2: 0.2, scale: 2 });
});

test('the art-stamp crop reaches the Platinum box', () => {
  assert.deepEqual(ART_STAMP_BOX, { x1: 0.62, y1: 0.36, x2: 0.97, y2: 0.54, scale: 4 });
});

test('a promo stamp is reported even when the price key is the finish', () => {
  const choice = variantChoice({ edition: 'standard', finish: 'holofoil', stamp: 'prerelease' }, modern);
  assert.equal(choice.key, 'holofoil');
  assert.equal(choice.stamp, 'prerelease');
});
