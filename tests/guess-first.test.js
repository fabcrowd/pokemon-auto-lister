import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topGuessOf, lotEstimate, quotedPrice, detectedVariant, suggestedVariant, needsEdition, editionVariant, needsPrinting, isIdentified, isSetConfirmed, confirmGuess, readFromSmallCrop } from '../tools/extension-wasm/lib/card-display.js';
import { largerRendition } from '../tools/extension-wasm/lib/full-size.js';

const cand = (id, name) => ({ id, name, set: 'Base Set', setCode: 'base1', number: '58' });

test('a nameless card with candidates gets its closest card as the top guess; named cards and backs do not', () => {
  assert.deepEqual(topGuessOf({ abstain: true, candidates: [cand('base1-58', 'Pikachu'), cand('x', 'Raichu')] }),
    { id: 'base1-58', name: 'Pikachu', set: 'Base Set', setCode: 'base1', number: '58' });
  assert.equal(topGuessOf({ abstain: true, candidates: [] }), null);
  assert.equal(topGuessOf({ identity: { name: 'Mew' }, unsure: true, candidates: [cand('a', 'Mew')] }), null);
  assert.equal(topGuessOf({ cardBack: true, candidates: [cand('a', 'Mew')] }), null);
});

test('small crops are flagged under 150 px; unknown height is not small', () => {
  assert.equal(readFromSmallCrop({ readHeight: 120 }), true);
  assert.equal(readFromSmallCrop({ readHeight: 150 }), false);
  assert.equal(readFromSmallCrop({}), false);
});

const multiGrid = (prices, extra = {}) => ({
  variants: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { market: v, conditions: { NM: v, LP: null, MP: null, HP: null, DMG: null } }])),
  ...extra,
});
const sureRow = (extra = {}) => ({ identity: { id: 'e-1', name: 'Eevee' }, confidence: 0.95, setConfirmed: true, ...extra });

test('an unknown card shows no price and adds nothing to the lot, however priced its guess or name is', () => {
  const sure = sureRow({ market_price: 100, price_grid: multiGrid({ normal: 100 }) });
  const topGuess = { abstain: true, topGuess: { id: 'b', name: 'Pikachu', price: 1.2 } };
  const unpriced = { abstain: true, topGuess: { id: 'c', name: 'Mew', price: null } };
  const asked = { identity: { id: 'd', name: 'Magcargo' }, unsure: true, confidence: 0.3, market_price: 2, price_grid: multiGrid({ normal: 2 }) };
  const back = { cardBack: true };
  const lot = lotEstimate([sure, topGuess, unpriced, asked, back], () => null);
  assert.equal(lot.low, 100);
  assert.equal(lot.high, 100);
  assert.equal(lot.identified, 1);
  assert.equal(lot.toIdentify, 3);
  assert.equal(lot.total, 4);
  assert.equal(isIdentified(asked), false);
});

test('a name that is sure with its printing open is a range, never one auto-picked price', () => {
  const card = sureRow({ price_grid: multiGrid({ normal: 2, holofoil: 10, reverseHolofoil: 4 }) });
  assert.equal(quotedPrice(card, null), null);
  const lot = lotEstimate([card], () => null);
  assert.deepEqual([lot.low, lot.high, lot.identified], [2, 10, 1]);
  const open = sureRow({ setChoices: [{ id: 'a' }, { id: 'b' }], setConfirmed: false, setRange: { low: 3, high: 9, count: 2, total: 2 }, price_grid: null });
  assert.equal(needsPrinting(open), true);
  const openLot = lotEstimate([open], () => null);
  assert.deepEqual([openLot.low, openLot.high], [3, 9]);
});

test('a printing inferred from the picture is only a suggestion until the user confirms it', () => {
  const card = sureRow({
    variant: { edition: 'standard', finish: 'reverse', stamp: 'none' },
    price_grid: multiGrid({ normal: 2, holofoil: 10, reverseHolofoil: 4 }),
  });
  assert.equal(suggestedVariant(card), 'reverseHolofoil');
  assert.equal(detectedVariant(card), null);
  assert.deepEqual([lotEstimate([card], () => detectedVariant(card)).low, lotEstimate([card], () => detectedVariant(card)).high], [2, 10]);
  // The user confirms the suggestion: that choice is now a pick, and it prices.
  assert.equal(quotedPrice(card, suggestedVariant(card)).price, 4);
  assert.equal(lotEstimate([card], () => suggestedVariant(card)).high, 4);
  const first = sureRow({ firstEdition: true, price_grid: multiGrid({ unlimited: 5, '1stEditionNormal': 90 }) });
  assert.equal(suggestedVariant(first), '1stEditionNormal');
  assert.equal(detectedVariant(first), null);
});

test('a picture-only best-guess printing keeps the range until confirmed, then prices', () => {
  const guess = sureRow({
    setConfirmed: false, bestGuess: { source: 'image', reason: 'best guess from the picture' }, confidence: 0.7,
    setChoices: [{ id: 'a' }, { id: 'b' }], setRange: { low: 2, high: 9, count: 2, total: 2 },
    market_price: 800, price_grid: multiGrid({ normal: 800 }),
  });
  assert.equal(isSetConfirmed(guess), false);
  assert.equal(needsPrinting(guess), true);
  assert.equal(quotedPrice(guess, null), null);
  const lot = lotEstimate([guess], () => null);
  assert.deepEqual([lot.low, lot.high], [2, 9]);
  const confirmed = confirmGuess(guess);
  assert.equal(quotedPrice(confirmed, null).price, 800);
  assert.equal(lotEstimate([confirmed], () => null).high, 800);
  // A hint guess comes from the page's own heading and keeps its single price.
  const hint = { ...guess, bestGuess: { source: 'hint', reason: 'x' } };
  assert.equal(isSetConfirmed(hint), true);
  assert.equal(needsPrinting(hint), false);
  assert.equal(quotedPrice(hint, null).price, 800);
});

test('a set borrowed from the other cards on the page is a guess like the picture: range until confirmed', () => {
  const page = sureRow({
    setConfirmed: false, bestGuess: { source: 'page', reason: 'likely B: 2 other cards on this page are from it' }, confidence: 0.7,
    setChoices: [{ id: 'a' }, { id: 'b' }], setRange: { low: 2, high: 9, count: 2, total: 2 },
    market_price: 800, price_grid: multiGrid({ normal: 800 }),
  });
  assert.equal(isSetConfirmed(page), false);
  assert.equal(needsPrinting(page), true);
  assert.equal(quotedPrice(page, null), null);
  const lot = lotEstimate([page], () => null);
  assert.deepEqual([lot.low, lot.high], [2, 9]);
  assert.equal(quotedPrice(confirmGuess(page), null).price, 800);
});

test('a single printing, and a finish read from the printed number, still price directly', () => {
  const single = sureRow({ market_price: 4, price_grid: multiGrid({ normal: 4 }) });
  assert.equal(quotedPrice(single, null).price, 4);
  assert.equal(lotEstimate([single], () => null).high, 4);
  const settled = sureRow({
    finishSure: 'holofoil', variant: { edition: null, finish: 'holofoil', stamp: 'none' },
    price_grid: multiGrid({ normal: 2, holofoil: 10, reverseHolofoil: 4 }),
  });
  assert.equal(detectedVariant(settled), 'holofoil');
  assert.equal(quotedPrice(settled, detectedVariant(settled)).price, 10);
  const viaModelOnly = { ...settled, finishSure: undefined };
  assert.equal(detectedVariant(viaModelOnly), null);
  assert.equal(suggestedVariant(viaModelOnly), 'holofoil');
});

const baseHolo = (extra = {}) => sureRow({
  finishSure: 'holofoil', variant: { edition: null, finish: 'holofoil', stamp: 'none' },
  price_grid: multiGrid({ unlimitedHolofoil: 40, shadowlessHolofoil: 300, '1stEditionHolofoil': 3000 }), ...extra,
});

test('a Base Set card with a number-read finish still shows a range until an edition is chosen', () => {
  const card = baseHolo();
  assert.equal(detectedVariant(card), null);
  assert.equal(needsEdition(card), true);
  assert.equal(quotedPrice(card, null), null);
  const lot = lotEstimate([card], () => null);
  assert.deepEqual([lot.low, lot.high], [40, 3000]);
});

test('the lot edition maps to each row key by its finish; a row without that printing gets none', () => {
  const card = baseHolo();
  assert.equal(editionVariant(card, 'unlimited'), 'unlimitedHolofoil');
  assert.equal(editionVariant(card, 'shadowless'), 'shadowlessHolofoil');
  assert.equal(editionVariant(card, 'first'), '1stEditionHolofoil');
  assert.equal(quotedPrice(card, editionVariant(card, 'first')).price, 3000);
  const jungle = sureRow({ finishSure: 'normal', price_grid: multiGrid({ unlimited: 3, '1stEditionNormal': 90 }) });
  assert.equal(editionVariant(jungle, 'unlimited'), 'unlimited');
  assert.equal(editionVariant(jungle, 'shadowless'), null);
  assert.equal(editionVariant(jungle, 'first'), '1stEditionNormal');
});

test('only a settled, identified card with edition rows and a number-read finish is offered the lot edition', () => {
  assert.equal(needsEdition(baseHolo({ finishSure: undefined })), false);
  assert.equal(needsEdition(baseHolo({ price_grid: multiGrid({ normal: 2, holofoil: 10 }) })), false);
  assert.equal(needsEdition(baseHolo({ setChoices: [{ id: 'a' }, { id: 'b' }], setConfirmed: false })), false);
  assert.equal(needsEdition(baseHolo({ setConfirmed: undefined, confidence: 0.2 })), false);
});

test('a stale-grid price is to check, not summed, however sure the row is', () => {
  const stale = sureRow({ market_price: 9, price_grid: multiGrid({ normal: 9 }, { stale: true }) });
  const fresh = sureRow({ market_price: 4, price_grid: multiGrid({ normal: 4 }) });
  const lot = lotEstimate([stale, fresh], () => null);
  assert.equal(lot.high, 4);
  assert.equal(lot.toCheck, 1);
  assert.equal(lot.identified, 1);
});

test('the lot reports how many cards are still to confirm', () => {
  const cards = [sureRow({ market_price: 3, price_grid: multiGrid({ normal: 3 }) }), { abstain: true, topGuess: { id: 'b', name: 'Pikachu' } }, { abstain: true }, { cardBack: true }];
  assert.equal(lotEstimate(cards, () => null).toIdentify, 2);
});

test('a larger rendition is offered only when it is known to be bigger', () => {
  const base = 'https://example.com/listing';
  const srcset = 'https://cdn.example.com/a-480.jpg 480w, https://cdn.example.com/a-1600.jpg 1600w';
  assert.deepEqual(largerRendition({ src: 'https://cdn.example.com/a-480.jpg', naturalWidth: 480, naturalHeight: 640, srcset, base }),
    { url: 'https://cdn.example.com/a-1600.jpg', side: 2133 });
  assert.equal(largerRendition({ src: 'https://cdn.example.com/a.jpg', naturalWidth: 1600, naturalHeight: 1600, srcset: 'https://cdn.example.com/b.jpg 1700w', base }), null);
  const fb = 'https://scontent.xx.fbcdn.net/v/t39/123456789_n.jpg?stp=dst-jpg&ctp=p600x600&_nc_ht=x';
  const offer = largerRendition({ src: fb, naturalWidth: 600, naturalHeight: 800, base });
  assert.ok(offer && !offer.url.includes('ctp=') && offer.side === null);
  assert.equal(largerRendition({ src: 'https://scontent.xx.fbcdn.net/v/t39/1_n.jpg?stp=dst-jpg', naturalWidth: 600, naturalHeight: 800, base }), null);
});

