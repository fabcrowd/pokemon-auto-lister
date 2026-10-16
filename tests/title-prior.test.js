import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTitlePrior,
  cleanListingTitle,
  listingTitles,
  nameFromTitle,
  parseListingTitle,
  rerankByTitle,
} from '../tools/extension-wasm/lib/title-prior.js';

const base = { id: 'base1-4', name: 'Charizard', set: 'Base', setCode: 'base1', number: '4' };
const blast = { id: 'base1-2', name: 'Blastoise', set: 'Base', setCode: 'base1', number: '2' };
const venu = { id: 'base1-15', name: 'Venusaur', set: 'Base', setCode: 'base1', number: '15' };
const ids = (rows) => rows.map((row) => row.id);

test('a title naming the 2nd candidate moves it first, rest stay in order', () => {
  const out = rerankByTitle([blast, base, venu], parseListingTitle('Charizard 4/102 Base Set Holo PSA 9'));
  assert.deepEqual(ids(out), ['base1-4', 'base1-2', 'base1-15']);
});

test('candidates are only reordered: same objects, same confidence fields', () => {
  const input = [{ ...blast, confidence: 0.4 }, { ...base, confidence: 0.3 }];
  const out = rerankByTitle(input, parseListingTitle('Charizard holo'));
  assert.equal(out.length, 2);
  assert.equal(out[0], input[1]);
  assert.equal(out[0].confidence, 0.3);
  assert.deepEqual(ids(input), ['base1-2', 'base1-4']);
});

test('a title naming a card not among the candidates changes nothing', () => {
  const rows = [blast, venu];
  assert.deepEqual(ids(rerankByTitle(rows, parseListingTitle('Charizard 4/102 Base Set'))), ['base1-2', 'base1-15']);
});

test('a lot title naming several cards changes nothing', () => {
  const rows = [blast, base, venu];
  const parsed = parseListingTitle('Lot of 50 Base Set Charizard Blastoise Venusaur');
  assert.deepEqual(ids(rerankByTitle(rows, parsed)), ['base1-2', 'base1-4', 'base1-15']);
});

test('a lot title naming one candidate still changes nothing', () => {
  const rows = [blast, base];
  assert.deepEqual(ids(rerankByTitle(rows, parseListingTitle('Lot of 20 Pokemon cards incl Charizard'))), ['base1-2', 'base1-4']);
});

test('two cards named in the title (one outside the candidates) changes nothing when known names are given', () => {
  const rows = [blast, base];
  const out = rerankByTitle(rows, parseListingTitle('Charizard and Mewtwo holo pair'), ['Mewtwo', 'Charizard']);
  assert.deepEqual(ids(out), ['base1-2', 'base1-4']);
});

test('number disambiguates two printings of the same name', () => {
  const a = { id: 'a', name: 'Charizard', set: 'Base Set 2', setCode: 'base4', number: '4' };
  const b = { id: 'b', name: 'Charizard', set: 'Legendary Collection', setCode: 'base6', number: '3' };
  assert.deepEqual(ids(rerankByTitle([a, b], parseListingTitle('Charizard 3/110 Holo'))), ['b', 'a']);
  assert.deepEqual(ids(rerankByTitle([b, a], parseListingTitle('Charizard #4 Holo'))), ['a', 'b']);
  assert.deepEqual(ids(rerankByTitle([b, a], parseListingTitle('Charizard 004/130'))), ['a', 'b']);
});

test('promo codes and leading zeros compare as numbers', () => {
  const a = { id: 'a', name: 'Pikachu', set: 'Sword & Shield Promos', number: 'SWSH161' };
  const b = { id: 'b', name: 'Pikachu', set: 'Sword & Shield Promos', number: 'SWSH039' };
  assert.deepEqual(ids(rerankByTitle([b, a], parseListingTitle('Pikachu SWSH161 promo'))), ['a', 'b']);
  assert.equal(parseListingTitle('Pikachu SWSH161 promo').number, 'swsh161');
});

test('set name breaks a tie when the number does not', () => {
  const a = { id: 'a', name: 'Charizard', set: 'Jungle', number: '4' };
  const b = { id: 'b', name: 'Charizard', set: 'Base', number: '4' };
  assert.deepEqual(ids(rerankByTitle([a, b], parseListingTitle('Charizard Base Set holo'))), ['b', 'a']);
});

test('a name inside a longer word or another card name does not count', () => {
  const ex = { id: 'ex', name: 'Charizard ex', set: 'X', number: '1' };
  const plain = { id: 'plain', name: 'Charizard', set: 'X', number: '2' };
  assert.deepEqual(ids(rerankByTitle([plain, ex], parseListingTitle('Charizard ex 1/10'))), ['ex', 'plain']);
  assert.deepEqual(ids(rerankByTitle([blast, { ...venu, name: 'Mew' }], parseListingTitle('Mewtwo card'))), ['base1-2', 'base1-15']);
});

test('site suffixes and banner headings are cleaned away', () => {
  assert.equal(cleanListingTitle('Charizard 4/102 Base Set Holo PSA 9 | eBay'), 'Charizard 4/102 Base Set Holo PSA 9');
  assert.equal(cleanListingTitle('Charizard 4/102 for sale online | eBay'), 'Charizard 4/102');
  assert.equal(cleanListingTitle('Charizard 4/102 - Mercari'), 'Charizard 4/102');
  assert.equal(cleanListingTitle('Privacy settings'), '');
  assert.equal(cleanListingTitle('We use cookies'), '');
  assert.equal(cleanListingTitle(null), '');
  assert.deepEqual(
    listingTitles({ h1: 'Privacy settings', ogTitle: 'Blastoise PSA 8 | eBay', title: 'Blastoise PSA 8 | eBay' }),
    ['Blastoise PSA 8'],
  );
  assert.deepEqual(parseListingTitle('Charizard 4/102 | eBay').tokens, ['charizard', '4', '102']);
});

test('parse reads number and total', () => {
  const p = parseListingTitle('Charizard 4/102 Base Set Holo PSA 9');
  assert.equal(p.number, '4');
  assert.equal(p.total, '102');
  assert.equal(p.lot, false);
  assert.equal(parseListingTitle('Lot of 50 Base Set cards').lot, true);
});

test('Japanese titles with no English name match change nothing', () => {
  const rows = [blast, base];
  assert.deepEqual(ids(rerankByTitle(rows, parseListingTitle('リザードン 4/102 旧裏 初版'))), ['base1-2', 'base1-4']);
  assert.deepEqual(ids(rerankByTitle(rows, parseListingTitle('リザードン Charizard 4/102 旧裏'))), ['base1-4', 'base1-2']);
});

test('nameFromTitle finds the one longest catalog name', () => {
  const names = ['Charizard', 'Charizard ex', 'Mew', 'Blastoise'];
  assert.equal(nameFromTitle(parseListingTitle('Charizard ex 4/102'), names), 'Charizard ex');
  assert.equal(nameFromTitle(parseListingTitle('Charizard Blastoise lot'), names), null);
  assert.equal(nameFromTitle(parseListingTitle('Mewtwo'), names), null);
});

test('applyTitlePrior only acts on listing pages', () => {
  const card = { identity: { name: 'Charizard' }, confidence: 0.4, setChoices: [blast, base] };
  const page = { title: 'Charizard 4/102 | eBay' };
  for (const kind of ['grid', 'unknown', undefined]) {
    const logs = [];
    const out = applyTitlePrior([card], { kind, page, log: (m) => logs.push(m) });
    assert.equal(out[0], card, String(kind));
    assert.equal(logs.length, 0);
  }
});

test('applyTitlePrior reorders setChoices without touching confidence or identity, and logs', () => {
  const card = { identity: { name: 'Charizard' }, confidence: 0.4, abstain: false, setChoices: [blast, base, venu] };
  const logs = [];
  const [out] = applyTitlePrior([card], { kind: 'listing', page: { h1: 'Privacy settings', title: 'Charizard 4/102 | eBay' }, log: (m) => logs.push(m) });
  assert.deepEqual(ids(out.setChoices), ['base1-4', 'base1-2', 'base1-15']);
  assert.equal(out.confidence, 0.4);
  assert.equal(out.abstain, false);
  assert.equal(out.identity, card.identity);
  assert.equal(out.setConfirmed, undefined);
  assert.deepEqual(logs, ['title prior: moved Charizard to front']);
});

test('applyTitlePrior leaves a sure single-printing row alone', () => {
  const card = { identity: base, confidence: 0.9 };
  const [out] = applyTitlePrior([card], { kind: 'listing', page: { title: 'Charizard 4/102' }, log: () => {} });
  assert.equal(out, card);
});

test('applyTitlePrior prefills the search box only for unsure rows', () => {
  const unsure = { identity: { name: 'Charizard' }, confidence: 0.3, setChoices: [blast, base] };
  const sure = { identity: base, confidence: 0.95 };
  const [u, s] = applyTitlePrior([unsure, sure], {
    kind: 'listing', page: { title: 'Charizard 4/102 Base Set' }, knownNames: ['Charizard', 'Blastoise'], log: () => {},
  });
  assert.equal(u.titleQuery, 'Charizard 4/102');
  assert.equal(s.titleQuery, undefined);
});

test('applyTitlePrior leaves a lot page alone, prefill included', () => {
  const card = { identity: { name: 'Charizard' }, confidence: 0.3, setChoices: [blast, base] };
  const [out] = applyTitlePrior([card], {
    kind: 'listing', page: { title: 'Lot of 50 Base Set Charizard Blastoise Venusaur' }, knownNames: ['Charizard', 'Blastoise', 'Venusaur'], log: () => {},
  });
  assert.equal(out, card);
});

const capped = (identity, over = {}) => ({ identity, confidence: 0.79, confidenceBeforeSetCap: 0.9, setUnconfirmed: true, abstain: false, ...over });
const charizard = { id: 'base1-4', name: 'Charizard', set: 'Base Set', setCode: 'base1', number: '4' };
const listing = (h1) => ({ kind: 'listing', page: { h1 } });

test('a title with the card name, number and set confirms the printing and restores the confidence', () => {
  const [out] = applyTitlePrior([capped(charizard)], listing('Charizard 4/102 Base Set Holo PSA 9'));
  assert.equal(out.confidence, 0.9);
  assert.equal(out.setUnconfirmed, false);
  assert.equal(out.identity.id, 'base1-4');
});

test('a number alone, another set or a lot title does not confirm the printing', () => {
  for (const h1 of ['Charizard #4', 'Charizard 4/102 Legendary Collection', 'Charizard 4/102 Base Set 2', 'Lot of 10 Base Set cards Charizard 4/102 Base Set', 'Blastoise 4/102 Base Set']) {
    const [out] = applyTitlePrior([capped(charizard)], listing(h1));
    assert.equal(out.confidence, 0.79, h1);
    assert.equal(out.setUnconfirmed, true, h1);
  }
});

test('the title never lifts a read that something else lowered further', () => {
  const small = capped(charizard, { confidence: 0.49, smallSource: true });
  const [out] = applyTitlePrior([small], listing('Charizard 4/102 Base Set'));
  assert.equal(out.confidence, 0.49);
});

const pikaV = { id: 'swsh4-43', name: 'Pikachu V', set: 'Vivid Voltage', setCode: 'swsh4', number: '43' };
const pikaEx = { id: 'sv8-57', name: 'Pikachu ex', set: 'Surging Sparks', setCode: 'sv8', number: '57' };
const versionCard = (over = {}) => ({
  identity: pikaV, market_price: 2.1, price_grid: null, confidence: 0.79, abstain: false,
  versionChoices: [{ ...pikaEx, market_price: 30, price_grid: null }], ...over,
});
const apply = (card, h1, knownNames = ['Pikachu', 'Pikachu V', 'Pikachu ex', 'Charizard ex']) =>
  applyTitlePrior([card], { kind: 'listing', page: { h1 }, knownNames, log: () => {} })[0];

test('a title naming the other version swaps to it with its price; confidence does not rise', () => {
  const out = apply(versionCard(), 'Pokemon Pikachu ex Surging Sparks Holo');
  assert.equal(out.identity.id, 'sv8-57');
  assert.equal(out.market_price, 30);
  assert.deepEqual(out.versionChoices.map((c) => c.id), ['swsh4-43']);
  assert.equal(out.confidence, 0.79);
});

test('a title naming the top version, no version, or both leaves the row as it was', () => {
  const card = versionCard();
  for (const h1 of ['Pikachu V Vivid Voltage', 'Pikachu Holo Pokemon Card', 'Pikachu V and Pikachu ex lot pair', 'Charizard ex']) {
    assert.equal(apply(card, h1), card, h1);
  }
});

test('a plain title picks the plain card over its Dark version', () => {
  const dark = { id: 'n-1', name: 'Dark Jolteon', set: 'Team Rocket', setCode: 'base5', number: '38' };
  const plain = { id: 'n-2', name: 'Jolteon', set: 'Jungle', setCode: 'base2', number: '4' };
  const card = { identity: dark, confidence: 0.79, abstain: false, versionChoices: [plain] };
  assert.equal(apply(card, 'Jolteon 4/64 Jungle', ['Jolteon', 'Dark Jolteon']).identity.id, 'n-2');
  assert.equal(apply(card, 'Dark Jolteon 38/82', ['Jolteon', 'Dark Jolteon']), card);
});
