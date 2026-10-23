import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ageLabel,
  suggestedVariant,
  editionNote,
  isPrintingConfirmed,
  swapVersion,
  versionLabel,
  lotValue,
  setRangeSpan,
  printingNote,
  quotedPrice,
  sourceFooter,
  sourceName,
  modelFileLabel,
  explainScanError,
  isSetConfirmed,
  isUnsure,
  setRangeOf,
  setRangeSummary,
  setRangeNote,
  needsPrinting,
  fromSeveralPhotos,
  photoLabel,
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
});

test('several printings are not quoted until the user picks one', () => {
  assert.equal(isPrintingConfirmed(charizard.price_grid, null), false);
  assert.equal(quotedPrice(charizard, null), null);
  assert.match(printingNote(charizard.price_grid), /3 variants/);
  assert.match(printingNote(charizard.price_grid), /\$928\.00/);
  assert.match(printingNote(charizard.price_grid), /\$38,?000\.00|\$38000\.00/);
});

test('a chosen printing is the only price that counts', () => {
  const quote = quotedPrice(charizard, '1stEditionHolofoil');
  assert.equal(quote.price, 38000);
  assert.equal(quote.printing, '1stEditionHolofoil');
});

test('a card with the 1st Edition stamp starts on its 1st Edition price', () => {
  assert.equal(suggestedVariant({ ...charizard, firstEdition: true }), '1stEditionHolofoil');
  const jungle = { firstEdition: true, price_grid: { variants: { unlimited: {}, '1stEditionNormal': {} } } };
  assert.equal(suggestedVariant(jungle), '1stEditionNormal');
});

test('the trained model picks the reverse holo price', () => {
  const card = {
    variant: { edition: 'standard', finish: 'reverse', stamp: 'none' },
    price_grid: { variants: { holofoil: {}, reverseHolofoil: {}, normal: {} } },
  };
  assert.equal(suggestedVariant(card), 'reverseHolofoil');
});

test('a Shadowless border is named even when the price grid has no Shadowless row', () => {
  assert.equal(editionNote({ variant: { edition: 'shadowless', finish: 'normal', stamp: 'none' } }), 'Shadowless border');
  assert.equal(editionNote({ variant: { edition: 'standard', finish: 'holofoil', stamp: 'none' } }), null);
  assert.equal(editionNote({}), null);
});

test('a Base Set card with a drop shadow starts on its non-1st-Edition price', () => {
  const card = { shadow: true, price_grid: { variants: { holofoil: {}, '1stEditionHolofoil': {} } } };
  assert.equal(suggestedVariant(card), 'holofoil');
});

test('a drop shadow does not choose between two non-1st-Edition prices', () => {
  const card = { shadow: true, price_grid: { variants: { holofoil: {}, normal: {} } } };
  assert.equal(suggestedVariant(card), null);
});

test('no stamp, or no 1st Edition price, leaves the variant to the user', () => {
  assert.equal(suggestedVariant({ ...charizard, firstEdition: false }), null);
  assert.equal(suggestedVariant(charizard), null);
  assert.equal(suggestedVariant({ firstEdition: true, price_grid: { variants: { holofoil: {} } } }), null);
  assert.equal(suggestedVariant({ firstEdition: true, price_grid: null }), null);
});

test('a legacy price with no printing map still counts', () => {
  const card = { market_price: 12, price_grid: null };
  assert.equal(quotedPrice(card, null).price, 12);
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

  const picked = { ...unsure, setConfirmed: true, market_price: 8.85 };
  assert.equal(isSetConfirmed(picked), true);
  assert.equal(quotedPrice(picked, null).price, 8.85);
});

test('the quoted price follows the enabled condition', () => {
  const card = {
    market_price: 400,
    price_grid: {
      variants: { normal: { conditions: { NM: 400, LP: 250, MP: null, HP: null, DMG: null } } },
    },
  };
  assert.equal(quotedPrice(card, null, ['LP']).price, 250);
  assert.equal(quotedPrice(card, null, ['HP']), null);
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
  assert.equal(suggestedVariant(card), null);
  assert.equal(editionNote(card), 'Shadowless border');
});

import { classifyCard, isIdentified, lotEstimate, scanStatus, splitByRecognition, sureNote } from '../tools/extension-wasm/lib/card-display.js';

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
  assert.equal(classifyCard(blank()), 'pick');
  assert.equal(classifyCard(blank({ candidates: undefined })), 'pick');
  assert.equal(classifyCard(blank({ candidates: [{ id: 'z' }] })), 'pick');
  assert.equal(classifyCard({ cardBack: true, abstain: true }), 'unrecognised');
  assert.equal(classifyCard(named({ confidence: 0.1, abstain: false })), 'pick');
});

test('splitByRecognition keeps page order and original indexes', () => {
  const cards = [blank(), named(), unsure(), blank()];
  const { shown, hidden } = splitByRecognition(cards);
  assert.deepEqual(shown, [0, 1, 2, 3]);
  assert.deepEqual(hidden, []);
  assert.deepEqual(splitByRecognition([named(), { cardBack: true, abstain: true }]).hidden, [1]);
});

test('a sure name with its printing open counts as identified, with the printing to pick', () => {
  const open = { identity: { id: 'base1-4', name: 'Charizard' }, confidence: 0.79, abstain: false,
    setChoices: [{ id: 'base1-4' }, { id: 'base4-4' }], setRange: { low: 120, high: 950, count: 2 } };
  assert.equal(needsPrinting(open), true);
  // A printing the page heading names keeps its own price and the "Set?" menu.
  assert.equal(needsPrinting({ ...open, bestGuess: { source: 'hint', reason: 'Page says Base Set' } }), false);
  assert.equal(classifyCard(open), 'identified');
  // A picture-only guess is no evidence: the printing is still the user's call, with the guess preselected.
  assert.equal(needsPrinting({ ...open, bestGuess: { source: 'image', reason: 'best guess from the picture' } }), true);
  assert.equal(needsPrinting({ ...open, setConfirmed: true }), false);
  assert.equal(needsPrinting({ ...open, setChoices: [{ id: 'base1-4' }] }), false);
  assert.equal(needsPrinting({ ...open, unsure: true }), false);
  assert.equal(scanStatus([open, named()]), 'Found 2 cards: 2 identified (1 to pick printing)');
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
    'Found 14 cards: 1 identified, 13 need your pick',
  );
  assert.equal(scanStatus([blank()]), 'Found 1 card: 1 needs your pick');
  assert.equal(scanStatus([named(), { cardBack: true, abstain: true }]), 'Found 2 cards: 1 identified, 1 not recognised');
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
  assert.deepEqual(range, { low: 12.5, high: 55, count: 3, total: 4 });
  assert.equal(setRangeOf([{ price_grid: null, market_price: null }]), null);
  assert.equal(setRangeOf([]), null);
  assert.deepEqual(setRangeOf([{ price_grid: grid(9), market_price: 9 }, { price_grid: grid(9), market_price: 9 }]), { low: 9, high: 9, count: 2, total: 2 });
});

test('the range is worded for the row and the overlay', () => {
  assert.equal(setRangeNote({ low: 1.65, high: 4.7, count: 3, total: 3 }), '3 sets · $1.65–$4.70');
  assert.equal(setRangeNote({ low: 9, high: 9, count: 2, total: 2 }), '2 sets · $9.00');
  assert.equal(setRangeNote(null), null);
});

test('a name with several possible sets and a price range is shown, not asked about', () => {
  const ranged = setNamed({ setRange: { low: 5, high: 40, count: 2 } });
  assert.equal(isUnsure(ranged), false);
  assert.equal(isIdentified(ranged), true);
  assert.equal(classifyCard(ranged), 'identified');
  assert.equal(isSetConfirmed(ranged), false, 'the set is still open, so no single price is quoted');
  assert.equal(quotedPrice(ranged, null), null);
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
  assert.deepEqual(out.versionChoices.map((c) => c.id), ['keep:Pikachu V', 'swsh4-44']);
});

test('swapping to an id that is not offered changes nothing', () => {
  const read = versionRead();
  assert.equal(swapVersion(read, 'nope'), read);
});

const sunPikachu = { id: 'sm1-1', name: 'Pikachu GX', set: 'Sun & Moon', setCode: 'sm1', number: '1' };
const promoPikachu = { ...sunPikachu, id: 'smp-9', set: 'Promos', setCode: 'smp', number: '9' };
const openGx = () => ({
  ...sunPikachu, market_price: 3, price_variant: 'holofoil', price_grid: grid(3),
  setChoices: [sunPikachu, promoPikachu],
  setRange: { low: 3, high: 8, count: 2, total: 2, byCondition: { NM: { low: 3, high: 8, count: 2, total: 2 } } },
});

test('a version printed in several sets stays set-unconfirmed with its own range and Set? menu', () => {
  const read = versionRead({ versionChoices: [openGx(), { ...pikaVmax, market_price: null, price_grid: null }] });
  const out = swapVersion(read, 'sm1-1');
  assert.deepEqual(out.identity, { name: 'Pikachu GX' });
  assert.deepEqual(out.setChoices.map((c) => c.id), ['sm1-1', 'smp-9']);
  assert.equal(out.setRange.high, 8);
  assert.equal(out.market_price, null);
  assert.equal(out.price_grid, null);
  assert.equal(isSetConfirmed(out), false);
  assert.equal(quotedPrice(out, null), null);
  assert.equal(isUnsure(out), false, 'a range is on offer');
  assert.equal(out.confidence, 0.79);
});

test('swapping to a version and back restores the original row exactly', () => {
  const read = versionRead({ versionChoices: [openGx(), { ...pikaVmax, market_price: null, price_grid: null }] });
  const there = swapVersion(read, 'sm1-1');
  const back = swapVersion(there, 'swsh4-43');
  for (const key of ['identity', 'market_price', 'price_variant', 'price_grid', 'confidence']) assert.deepEqual(back[key], read[key], key);
  assert.equal(back.setChoices, read.setChoices);
  assert.equal(back.setRange, undefined);
  assert.deepEqual(back.versionChoices.map((c) => c.id).sort(), ['sm1-1', 'swsh4-44']);
  const again = back.versionChoices.find((c) => c.id === 'sm1-1');
  assert.deepEqual(again.setChoices.map((c) => c.id), ['sm1-1', 'smp-9']);
  assert.equal(again.setRange.high, 8);
});

test('an open-set row swaps away and back with its range, choices and menu intact', () => {
  const open = versionRead({
    identity: { name: 'Pikachu V' }, setChoices: [pikaV, { ...pikaV, id: 'cel-5' }], setRange: { low: 1, high: 2, count: 2, total: 2 },
    market_price: null, price_variant: null, price_grid: null,
  });
  const there = swapVersion(open, 'sv8-57');
  assert.equal(isSetConfirmed(there), true);
  assert.equal(there.market_price, 30);
  const back = swapVersion(there, 'keep:Pikachu V');
  assert.deepEqual(back.identity, { name: 'Pikachu V' });
  assert.deepEqual(back.setChoices, open.setChoices);
  assert.deepEqual(back.setRange, open.setRange);
  assert.equal(back.market_price, null);
  assert.equal(isSetConfirmed(back), false);
});

test('a confirmed set pick survives a swap away and back', () => {
  const picked = versionRead({ setChoices: [pikaV, { ...pikaV, id: 'cel-5' }], setConfirmed: true });
  const back = swapVersion(swapVersion(picked, 'sv8-57'), 'swsh4-43');
  assert.equal(back.setConfirmed, true);
  assert.equal(back.identity.id, 'swsh4-43');
  assert.equal(back.market_price, 2.1);
  assert.equal(isSetConfirmed(back), true);
});

test('a version whose price lookup failed brings its error to the swapped row', () => {
  const read = versionRead({ versionChoices: [{ ...pikaEx, market_price: null, price_grid: null, priceError: "Couldn't get a price. Try again." }] });
  const out = swapVersion(read, 'sv8-57');
  assert.equal(out.priceError, "Couldn't get a price. Try again.");
  assert.equal(swapVersion(out, 'swsh4-43').priceError, null);
});

test('a version in several sets is listed with its set range, not one printing price', () => {
  assert.equal(versionLabel(openGx()), 'Pikachu GX · 2 sets · $3.00–$8.00');
});

const gridAt = (conditions) => ({ variants: { normal: { conditions } } });

test('one condition is used for every candidate and printings without it are left out', () => {
  const items = [
    { price_grid: gridAt({ NM: 40, LP: 30 }) },
    { price_grid: gridAt({ NM: null, LP: 10 }) },
    { price_grid: gridAt({ NM: 55, LP: 45 }) },
  ];
  assert.deepEqual(setRangeOf(items), { low: 40, high: 55, count: 2, total: 3 });
  assert.deepEqual(setRangeOf(items, ['LP', 'NM']), { low: 10, high: 45, count: 3, total: 3 });
  assert.deepEqual(setRangeOf(items, []), { low: 40, high: 55, count: 2, total: 3 });
  assert.equal(setRangeOf(items, ['DMG']), null);
});

test('a printing with no grid counts at near mint only', () => {
  const items = [{ price_grid: null, market_price: 12 }, { price_grid: gridAt({ NM: 20, LP: 15 }) }];
  assert.equal(setRangeOf(items, ['NM']).count, 2);
  assert.deepEqual(setRangeOf(items, ['LP']), { low: 15, high: 15, count: 1, total: 2 });
});

test('the range note follows the conditions the popup has switched on', () => {
  const summary = setRangeSummary([{ price_grid: gridAt({ NM: 40, LP: 30 }) }, { price_grid: gridAt({ NM: 55, LP: 20 }) }]);
  assert.equal(setRangeNote(summary), '2 sets · $40.00–$55.00');
  assert.equal(setRangeNote(summary, ['NM']), '2 sets · $40.00–$55.00');
  assert.equal(setRangeNote(summary, ['LP']), '2 sets · $20.00–$30.00');
  assert.equal(setRangeNote(summary, ['HP']), null);
  assert.equal(setRangeSummary([{ price_grid: null, market_price: null }]), null);
});

test('range wording: singular, a single price, and how many printings were priced', () => {
  assert.equal(setRangeNote({ low: 9, high: 9, count: 1, total: 1 }), '1 set · $9.00');
  assert.equal(setRangeNote({ low: 9, high: 9, count: 1, total: 4 }), '1 of 4 sets priced · $9.00');
  assert.equal(setRangeNote({ low: 3, high: 8, count: 3, total: 5 }), '3 of 5 sets priced · $3.00–$8.00');
  assert.equal(setRangeNote({ low: 3, high: 8, count: 2 }), '2 sets · $3.00–$8.00');
});

const priceAt = (nm, extra = {}) => ({ ...named(extra), market_price: nm, price_grid: grid(nm) });

test('lotEstimate: confirmed prices count at both ends, nothing else is invented', () => {
  const lot = lotEstimate([priceAt(5), priceAt(7.5), priceAt(2)], () => null);
  assert.deepEqual(lot, { low: 14.5, high: 14.5, identified: 3, total: 3, toIdentify: 0, toCheck: 0, noPrice: 0 });
});

test('lotEstimate: a mixed lot spans set ranges and counts guesses, unrecognised and unpriced rows as $0', () => {
  const ranged = setNamed({ setRange: { low: 4, high: 20, count: 2, total: 2 } });
  const cards = [
    priceAt(10),
    ranged,
    blank(),
    unsure({ market_price: 99, price_grid: grid(99) }),
    named(),
    { cardBack: true, abstain: true },
  ];
  const lot = lotEstimate(cards, () => null);
  assert.equal(lot.low, 14);
  assert.equal(lot.high, 30);
  assert.equal(lot.total, 5);
  assert.equal(lot.identified, 3);
  assert.equal(lot.toIdentify, 2);
});

test('lotEstimate follows the first enabled condition for ranges and prices', () => {
  const byCondition = { NM: { low: 4, high: 20, count: 2, total: 2 }, LP: { low: 3, high: 12, count: 2, total: 2 } };
  const ranged = setNamed({ setRange: { ...byCondition.NM, byCondition } });
  const lp = { ...named(), price_grid: { variants: { normal: { market: 9, conditions: { NM: 9, LP: 6 } } } } };
  const lot = lotEstimate([ranged, lp], () => null, ['LP']);
  assert.equal(lot.low, 9);
  assert.equal(lot.high, 18);
});

test('lotEstimate: an unchosen printing contributes its price range', () => {
  const multi = { ...named(), price_grid: { variants: { holo: { conditions: { NM: 8 } }, reverse: { conditions: { NM: 3 } } } } };
  assert.equal(lotEstimate([multi], () => null).low, 3);
  assert.equal(lotEstimate([multi], () => null).high, 8);
  assert.equal(lotEstimate([multi], () => 'holo').low, 8);
});

test('lotValue: a single value, or a span, whenever one real card is there', () => {
  assert.deepEqual(lotValue([priceAt(5), priceAt(7.5), blank()], () => null), {
    value: '$12.50',
    detail: '2 of 3 cards identified · 1 still to identify',
  });
  assert.deepEqual(lotValue([priceAt(5)], () => null), { value: '$5.00', detail: '1 of 1 cards identified' });
  const mixed = [priceAt(5), setNamed({ setRange: { low: 1, high: 3, count: 2, total: 2 } }), blank(), blank()];
  assert.deepEqual(lotValue(mixed, () => null), {
    value: '$6.00–$8.00',
    detail: '2 of 4 cards identified · 2 still to identify',
  });
});

test('lotValue: no value when only card backs or nothing was found', () => {
  assert.deepEqual(lotValue([], () => null), { value: null, detail: '' });
  assert.deepEqual(lotValue([{ cardBack: true, abstain: true }], () => null), { value: null, detail: '' });
});

test('lotValue: no value while nothing is identified, but the detail stays', () => {
  assert.deepEqual(lotValue([blank()], () => null), { value: null, detail: '0 of 1 cards identified · 1 still to identify' });
});

test('lotValue: a card that is only a guess adds $0 and is still to identify', () => {
  for (const extra of [{ abstain: true }, { unsure: true }, { confidence: 0.2 }]) {
    const lot = lotValue([priceAt(5), priceAt(9, extra)], () => null);
    assert.deepEqual(lot, { value: '$5.00', detail: '1 of 2 cards identified · 1 still to identify' });
  }
  assert.equal(lotValue([priceAt(9, { abstain: true, setConfirmed: true })], () => null).value, '$9.00');
});

test('setRangeSpan: the span for the first enabled condition, null when there is none', () => {
  const byCondition = { NM: { low: 4, high: 20, count: 2, total: 2 }, LP: { low: 3, high: 3, count: 1, total: 2 } };
  const range = { ...byCondition.NM, byCondition };
  assert.equal(setRangeSpan(range, ['NM']), '$4.00–$20.00');
  assert.equal(setRangeSpan(range, ['LP']), '$3.00');
  assert.equal(setRangeSpan(range, ['HP']), null);
  assert.equal(setRangeSpan({ low: 2, high: 9, count: 2 }, ['NM']), '$2.00–$9.00');
  assert.equal(setRangeSpan(undefined, ['NM']), null);
});

test('a card from another photo of the listing says which photo', () => {
  assert.equal(photoLabel({ photo: 3 }), 'Photo 3');
  assert.equal(photoLabel({ photo: 1, photos: [1, 4] }), 'Photos 1, 4');
  assert.equal(photoLabel({}), '');
  assert.equal(fromSeveralPhotos([{ photo: 1 }, { photo: 1 }]), false);
  assert.equal(fromSeveralPhotos([{ photo: 1 }, { photo: 2 }]), true);
  assert.equal(fromSeveralPhotos([{ photo: 1, photos: [1, 2] }]), true);
});

test('swapping versions on an unsure row is the user confirming it: the row stays identified', () => {
  const read = versionRead({ unsure: true, lowCertainty: true, confidence: 1 });
  assert.equal(classifyCard(read), 'pick');
  const out = swapVersion(read, 'sv8-57');
  assert.equal(out.unsure, false);
  assert.equal(out.userConfirmed, true);
  assert.equal(classifyCard(out), 'identified');
  assert.equal(out.market_price, 30);
  assert.equal(out.confidence, 1, 'confidence is untouched');
});

test('lotEstimate: an identified card with no price at all is counted as without price, not as $0 value', () => {
  const lot = lotEstimate([priceAt(5), named({ market_price: null, price_grid: null })], () => null);
  assert.equal(lot.identified, 2);
  assert.equal(lot.noPrice, 1);
  assert.equal(lot.high, 5);
});

test('lotEstimate: a card whose price is still loading is not "without price"', () => {
  const lot = lotEstimate([named({ market_price: null, price_grid: null, pricing: true })], () => null);
  assert.equal(lot.noPrice, 0);
});

test('sureNote: the count, then cards without price, then old prices; a tooltip only when some lack a price', () => {
  assert.deepEqual(sureNote({ identified: 3, noPrice: 0, toCheck: 0 }), { text: '(3)', title: '' });
  assert.deepEqual(sureNote({ identified: 3, noPrice: 1, toCheck: 0 }), { text: '(3, 1 without price)', title: '1 confirmed card has no price data' });
  assert.deepEqual(sureNote({ identified: 5, noPrice: 2, toCheck: 1 }), { text: '(5, 2 without price, 1 old price to check)', title: '2 confirmed cards have no price data' });
  assert.deepEqual(sureNote({ identified: 2, noPrice: 0, toCheck: 2 }), { text: '(2, 2 old prices to check)', title: '' });
});
