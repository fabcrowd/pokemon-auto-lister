import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ageLabel,
  detectedVariant,
  editionNote,
  isPrintingConfirmed,
  swapVersion,
  versionLabel,
  lotTotal,
  printingNote,
  quotedPrice,
  sourceFooter,
  sourceName,
  modelFileLabel,
  explainScanError,
  isSetConfirmed,
  isUnsure,
  setRangeOf,
  setRangeNote,
} from '../tools/extension-wasm/lib/card-display.js';

const charizard = {
  market_price: 928,
  price_grid: {
    source: 'pokemontcg',
    updatedAt: '2026-09-01T00:00:00.000Z',
    defaultVariant: 'holofoil',
    spreadRatio: 40,
    variants: {
      holofoil: { market: 928, conditions: { NM: 928, LP: null, MP: null, HP: null, DMG: null } },
      unlimitedHolofoil: { market: 4500, conditions: { NM: 4500, LP: null, MP: null, HP: null, DMG: null } },
      '1stEditionHolofoil': { market: 38000, conditions: { NM: 38000, LP: null, MP: null, HP: null, DMG: null } },
    },
  },
};

test('one printing is quoted and counted', () => {
  const card = {
    market_price: 4.5,
    price_grid: {
      source: 'pokemontcg',
      variants: { normal: { market: 4.5, conditions: { NM: 4.5, LP: null, MP: null, HP: null, DMG: null } } },
    },
  };
  assert.equal(isPrintingConfirmed(card.price_grid, null), true);
  assert.equal(printingNote(card.price_grid), null);
  assert.equal(quotedPrice(card, null).price, 4.5);
  assert.equal(lotTotal([card], () => null).total, 4.5);
  assert.equal(lotTotal([card], () => null).unconfirmed, 0);
});

test('several printings are not quoted until the user picks one', () => {
  assert.equal(isPrintingConfirmed(charizard.price_grid, null), false);
  assert.equal(quotedPrice(charizard, null), null);
  assert.match(printingNote(charizard.price_grid), /3 variants/);
  assert.match(printingNote(charizard.price_grid), /\$928\.00/);
  assert.match(printingNote(charizard.price_grid), /\$38,?000\.00|\$38000\.00/);
  const lot = lotTotal([charizard], () => null);
  assert.equal(lot.total, 0);
  assert.equal(lot.unconfirmed, 1);
});

test('a chosen printing is the only price that counts', () => {
  const quote = quotedPrice(charizard, '1stEditionHolofoil');
  assert.equal(quote.price, 38000);
  assert.equal(quote.printing, '1stEditionHolofoil');
  assert.equal(lotTotal([charizard], () => '1stEditionHolofoil').total, 38000);
  assert.equal(lotTotal([charizard], () => '1stEditionHolofoil').unconfirmed, 0);
});

test('a card with the 1st Edition stamp starts on its 1st Edition price', () => {
  assert.equal(detectedVariant({ ...charizard, firstEdition: true }), '1stEditionHolofoil');
  const jungle = { firstEdition: true, price_grid: { variants: { unlimited: {}, '1stEditionNormal': {} } } };
  assert.equal(detectedVariant(jungle), '1stEditionNormal');
});

test('the trained model picks the reverse holo price', () => {
  const card = {
    variant: { edition: 'standard', finish: 'reverse', stamp: 'none' },
    price_grid: { variants: { holofoil: {}, reverseHolofoil: {}, normal: {} } },
  };
  assert.equal(detectedVariant(card), 'reverseHolofoil');
});

test('a Shadowless border is named even when the price grid has no Shadowless row', () => {
  assert.equal(editionNote({ variant: { edition: 'shadowless', finish: 'normal', stamp: 'none' } }), 'Shadowless border');
  assert.equal(editionNote({ variant: { edition: 'standard', finish: 'holofoil', stamp: 'none' } }), null);
  assert.equal(editionNote({}), null);
});

test('a Base Set card with a drop shadow starts on its non-1st-Edition price', () => {
  const card = { shadow: true, price_grid: { variants: { holofoil: {}, '1stEditionHolofoil': {} } } };
  assert.equal(detectedVariant(card), 'holofoil');
});

test('a drop shadow does not choose between two non-1st-Edition prices', () => {
  const card = { shadow: true, price_grid: { variants: { holofoil: {}, normal: {} } } };
  assert.equal(detectedVariant(card), null);
});

test('no stamp, or no 1st Edition price, leaves the variant to the user', () => {
  assert.equal(detectedVariant({ ...charizard, firstEdition: false }), null);
  assert.equal(detectedVariant(charizard), null);
  assert.equal(detectedVariant({ firstEdition: true, price_grid: { variants: { holofoil: {} } } }), null);
  assert.equal(detectedVariant({ firstEdition: true, price_grid: null }), null);
});

test('a legacy price with no printing map still counts', () => {
  const card = { market_price: 12, price_grid: null };
  assert.equal(quotedPrice(card, null).price, 12);
  assert.equal(lotTotal([card], () => null).total, 12);
});

test('a card whose set is not chosen is not quoted or counted', () => {
  const unsure = {
    market_price: null,
    price_grid: null,
    identity: { name: 'Boost Energy' },
    setChoices: [{ id: 'ex8-93' }, { id: 'ex15-87' }],
  };
  assert.equal(isSetConfirmed(unsure), false);
  assert.equal(quotedPrice(unsure, null), null);
  const lot = lotTotal([unsure], () => null);
  assert.equal(lot.total, 0);
  assert.equal(lot.unconfirmed, 1);

  const picked = { ...unsure, setConfirmed: true, market_price: 8.85 };
  assert.equal(isSetConfirmed(picked), true);
  assert.equal(lotTotal([picked], () => null).total, 8.85);
});

test('the lot total follows the enabled condition', () => {
  const card = {
    market_price: 400,
    price_grid: {
      variants: { normal: { conditions: { NM: 400, LP: 250, MP: null, HP: null, DMG: null } } },
    },
  };
  assert.equal(lotTotal([card], () => null, ['LP']).total, 250);
  assert.equal(lotTotal([card], () => null, ['HP']).total, 0);
});

test('a card with one possible set needs no set choice', () => {
  assert.equal(isSetConfirmed({ setChoices: [{ id: 'ex13-54' }] }), true);
  assert.equal(isSetConfirmed({}), true);
});

test('source footer names the source and flags a price older than 7 days', () => {
  const now = Date.parse('2026-10-11T00:00:00.000Z');
  assert.equal(sourceFooter(charizard.price_grid, now), 'TCGPlayer · updated 40d ago');
  assert.equal(ageLabel(charizard.price_grid.updatedAt, now).stale, true);
  assert.equal(sourceFooter({ source: 'backend' }, now), 'JustTCG');
  assert.equal(sourceName({ source: 'ppt' }), 'Price Tracker');
  assert.equal(sourceName(charizard.price_grid), 'TCGPlayer');
  assert.equal(ageLabel('not-a-date', now), null);
});

test('model download rows use plain names', () => {
  assert.equal(modelFileLabel('clip_visual_int8.onnx'), 'card recognition');
  assert.equal(modelFileLabel('card_detect.onnx'), 'card finder');
  assert.equal(modelFileLabel('catalog.bin.gz'), 'card catalog');
  assert.equal(modelFileLabel('something-else.bin'), 'model file');
});

test('scan failures are explained without service-worker jargon', () => {
  assert.match(explainScanError('Could not establish connection. Receiving end does not exist.'), /Reload the Card Scanner extension/);
  assert.match(explainScanError('Models not loaded'), /downloading/);
  assert.equal(explainScanError('No scannable tab — open a webpage first'), 'No scannable tab — open a webpage first');
});

test('a tab the extension was not opened on says how to give it access', () => {
  const advice = /Click the Card Scanner icon/;
  assert.match(explainScanError('Could not query page for cards: Cannot access contents of the page. Extension manifest must request permission to access the respective host.'), advice);
  assert.match(explainScanError("Either the '<all_urls>' or 'activeTab' permission is required."), advice);
  assert.match(explainScanError('Cannot access a chrome:// URL'), advice);
});

test('a Shadowless border is shown but never picks the higher Shadowless price', () => {
  const card = {
    variant: { edition: 'shadowless', finish: 'holofoil', stamp: 'none' },
    price_grid: { variants: { holofoil: {}, shadowlessHolofoil: {}, '1stEditionHolofoil': {} } },
  };
  assert.equal(detectedVariant(card), null);
  assert.equal(editionNote(card), 'Shadowless border');
});

import { classifyCard, isIdentified, lotTotal as lotTotalForUnsure, scanStatus, splitByRecognition } from '../tools/extension-wasm/lib/card-display.js';

const named = (extra = {}) => ({ identity: { id: 'a-1', name: 'Pikachu' }, confidence: 0.9, abstain: false, ...extra });
const blank = (extra = {}) => ({ identity: {}, confidence: 0, abstain: true, candidates: [], ...extra });
const unsure = (extra = {}) => ({ identity: { name: 'Mew' }, confidence: 0.3, abstain: true, candidates: [{ id: 'm-1' }], ...extra });

test('isIdentified needs an identity, no doubt about it, and a confirmed set', () => {
  assert.equal(isIdentified(named()), true);
  assert.equal(isIdentified(named({ unsure: true })), false);
  assert.equal(isIdentified(named({ confidence: 0.2 })), false);
  assert.equal(isIdentified(named({ setChoices: [{ id: 'a' }, { id: 'b' }] })), false);
  assert.equal(isIdentified(named({ setChoices: [{ id: 'a' }, { id: 'b' }], setConfirmed: true })), true);
  assert.equal(isIdentified(blank()), false);
  assert.equal(isIdentified({ identity: { id: 'x-1' }, confidence: 0.9 }), true);
  assert.equal(isIdentified(null), false);
});

test('classifyCard sorts into identified, pick and unrecognised', () => {
  assert.equal(classifyCard(named()), 'identified');
  assert.equal(classifyCard(unsure()), 'pick');
  assert.equal(classifyCard(blank()), 'unrecognised');
  assert.equal(classifyCard(blank({ candidates: undefined })), 'unrecognised');
  assert.equal(classifyCard(blank({ candidates: [{ id: 'z' }] })), 'pick');
  assert.equal(classifyCard({ cardBack: true, abstain: true }), 'unrecognised');
  assert.equal(classifyCard(named({ confidence: 0.1, abstain: false })), 'pick');
});

test('splitByRecognition keeps page order and original indexes', () => {
  const cards = [blank(), named(), unsure(), blank()];
  const { shown, hidden } = splitByRecognition(cards);
  assert.deepEqual(shown, [1, 2]);
  assert.deepEqual(hidden, [0, 3]);
});

test('scanStatus words every count and drops empty parts', () => {
  assert.equal(scanStatus([]), '');
  assert.equal(scanStatus([named()]), 'Found 1 card: 1 identified');
  assert.equal(scanStatus([named(), named()]), 'Found 2 cards: 2 identified');
  assert.equal(
    scanStatus([named(), named(), ...Array.from({ length: 13 }, () => unsure())]),
    'Found 15 cards: 2 identified, 13 need your pick',
  );
  assert.equal(
    scanStatus([named(), unsure(), ...Array.from({ length: 12 }, () => blank())]),
    'Found 14 cards: 1 identified, 1 needs your pick, 12 not recognised',
  );
  assert.equal(scanStatus([blank()]), 'Found 1 card: 1 not recognised');
  assert.equal(scanStatus([blank(), blank()]), 'Found 2 cards: 2 not recognised');
});

test('lotTotal leaves out cards that are only a guess', () => {
  const priced = (extra) => ({ ...named(extra), market_price: 5, price_grid: { variants: { normal: { market: 5, conditions: { NM: 5 } } } } });
  const choose = () => null;
  assert.equal(lotTotalForUnsure([priced()], choose).total, 5);
  assert.equal(lotTotalForUnsure([priced({ confidence: 0.2 })], choose).total, 0);
  assert.equal(lotTotalForUnsure([priced({ abstain: true })], choose).total, 0);
  assert.equal(lotTotalForUnsure([priced({ unsure: true })], choose).total, 0);
  assert.equal(lotTotalForUnsure([priced({ abstain: true, setConfirmed: true })], choose).total, 5);
});

const grid = (nm) => ({ variants: { normal: { market: nm, conditions: { NM: nm, LP: null, MP: null, HP: null, DMG: null } } } });
const setNamed = (extra = {}) => ({ identity: { name: 'Blastoise' }, confidence: 0.79, abstain: false, setChoices: [{ id: 'base1-2' }, { id: 'base4-2' }], ...extra });

test('a price range across the candidate printings: lowest to highest, one entry per printing', () => {
  const range = setRangeOf([
    { price_grid: grid(40), market_price: 40 },
    { price_grid: { variants: { holofoil: { conditions: { NM: 55, LP: 30 } }, reverse: { conditions: { NM: null, LP: 20 } } } }, market_price: null },
    { price_grid: null, market_price: 12.5 },
    { price_grid: null, market_price: null },
  ]);
  assert.deepEqual(range, { low: 12.5, high: 55, count: 3 });
  assert.equal(setRangeOf([{ price_grid: null, market_price: null }]), null);
  assert.equal(setRangeOf([]), null);
  assert.deepEqual(setRangeOf([{ price_grid: grid(9), market_price: 9 }, { price_grid: grid(9), market_price: 9 }]), { low: 9, high: 9, count: 2 });
});

test('the range is worded for the row and the overlay', () => {
  assert.equal(setRangeNote({ low: 1.65, high: 4.7, count: 3 }), '3 sets · $1.65–$4.70');
  assert.equal(setRangeNote({ low: 9, high: 9, count: 2 }), '2 sets · $9.00');
  assert.equal(setRangeNote(null), null);
});

test('a name with several possible sets and a price range is shown, not asked about', () => {
  const ranged = setNamed({ setRange: { low: 5, high: 40, count: 2 } });
  assert.equal(isUnsure(ranged), false);
  assert.equal(isIdentified(ranged), true);
  assert.equal(classifyCard(ranged), 'identified');
  assert.equal(isSetConfirmed(ranged), false, 'the set is still open, so no single price is quoted');
  assert.equal(quotedPrice(ranged, null), null);
  assert.equal(lotTotal([ranged], () => null).total, 0);
  assert.equal(lotTotal([ranged], () => null).unconfirmed, 1);
  assert.match(scanStatus([ranged]), /1 identified/);
});

test('several possible sets and no price at all still ask, and low confidence still asks', () => {
  assert.equal(isUnsure(setNamed()), true);
  assert.equal(classifyCard(setNamed()), 'pick');
  assert.equal(isUnsure(setNamed({ setRange: { low: 5, high: 40, count: 2 }, confidence: 0.3 })), true);
});

const pikaV = { id: 'swsh4-43', name: 'Pikachu V', set: 'Vivid Voltage', setCode: 'swsh4', number: '43' };
const pikaEx = { id: 'sv8-57', name: 'Pikachu ex', set: 'Surging Sparks', setCode: 'sv8', number: '57' };
const pikaVmax = { id: 'swsh4-44', name: 'Pikachu VMAX', set: 'Vivid Voltage', setCode: 'swsh4', number: '44' };
const versionRead = (extra = {}) => ({
  identity: pikaV, market_price: 2.1, price_variant: 'holofoil', price_grid: grid(2.1), confidence: 0.79, abstain: false,
  versionChoices: [{ ...pikaEx, market_price: 30, price_variant: 'holofoil', price_grid: grid(30) }, { ...pikaVmax, market_price: null, price_grid: null }],
  ...extra,
});

test('another-version choices do not make a read unsure, and its own price stays quotable', () => {
  const read = versionRead();
  assert.equal(isUnsure(read), false);
  assert.equal(isIdentified(read), true);
  assert.equal(classifyCard(read), 'identified');
  assert.equal(isSetConfirmed(read), true);
  assert.equal(quotedPrice(read, null).price, 2.1);
});

test('a version is listed with its set, number and price; no price is left out, not made up', () => {
  assert.equal(versionLabel(versionRead().versionChoices[0]), 'Pikachu ex · Surging Sparks #57 · $30.00');
  assert.equal(versionLabel(versionRead().versionChoices[1]), 'Pikachu VMAX · Vivid Voltage #44');
});

test('swapping to another version brings its price and keeps the old top as a choice', () => {
  const read = versionRead();
  const out = swapVersion(read, 'sv8-57');
  assert.equal(out.identity.id, 'sv8-57');
  assert.equal(out.identity.market_price, undefined, 'prices are fields of the card, not of its identity');
  assert.equal(out.market_price, 30);
  assert.deepEqual(out.versionChoices.map((c) => c.id), ['swsh4-43', 'swsh4-44']);
  assert.equal(out.versionChoices[0].market_price, 2.1);
  assert.equal(out.confidence, 0.79);
  assert.equal(read.identity.id, 'swsh4-43', 'the input is not mutated');
});

test('swapping on a row whose set was open settles it on the chosen card', () => {
  const open = versionRead({ identity: { name: 'Pikachu V' }, setChoices: [pikaV, { ...pikaV, id: 'cel-5' }], setRange: { low: 1, high: 2, count: 2 }, market_price: null, price_grid: null });
  const out = swapVersion(open, 'sv8-57');
  assert.deepEqual(out.setChoices, []);
  assert.equal(out.setRange, undefined);
  assert.deepEqual(out.versionChoices.map((c) => c.id), ['swsh4-44']);
});

test('swapping to an id that is not offered changes nothing', () => {
  const read = versionRead();
  assert.equal(swapVersion(read, 'nope'), read);
});
