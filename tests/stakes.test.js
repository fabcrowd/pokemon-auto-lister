import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HIGH_STAKES_MIN_USD, LOW_STAKES_MAX_USD, demoteCard, isDemotable, priceHighOf, priceTypicalOf, promoteCard, stakesDecision,
} from '../tools/extension-wasm/lib/stakes.js';
import { chooseState } from '../tools/extension-wasm/lib/choose-flow.js';
import { lotEstimate } from '../tools/extension-wasm/lib/card-display.js';

const choose = { state: 'choose', tier: 'low', smallRow: true, priceHigh: 3, rivalHighs: [] };
const confirmed = { state: 'confirmed', tier: 'medium', titleConfirmed: false, priceTypical: 80 };

test('the price thresholds are the PM numbers', () => {
  assert.equal(LOW_STAKES_MAX_USD, 5);
  assert.equal(HIGH_STAKES_MIN_USD, 50);
});

test('promote: a CHOOSE card with smallRow whose price is at most $5', () => {
  assert.equal(stakesDecision(choose), 'promote');
  assert.equal(stakesDecision({ ...choose, priceHigh: 5 }), 'promote');
  assert.equal(stakesDecision({ ...choose, priceHigh: 0.25 }), 'promote');
  assert.equal(stakesDecision({ ...choose, priceHigh: 5.01 }), 'keep');
  assert.equal(stakesDecision({ ...choose, priceHigh: 400 }), 'keep');
});

test('promote needs every close candidate cheap, not only the top one', () => {
  assert.equal(stakesDecision({ ...choose, rivalHighs: [1, 5] }), 'promote');
  assert.equal(stakesDecision({ ...choose, rivalHighs: [1, 5.01] }), 'keep', 'a pricier runner-up (reprint, promo) blocks it');
  assert.equal(stakesDecision({ ...choose, rivalHighs: [1, null] }), 'keep', 'an unknown rival price blocks it');
  assert.equal(stakesDecision({ ...choose, rivalHighs: [1, NaN] }), 'keep');
  assert.equal(stakesDecision({ ...choose, rivalHighs: undefined }), 'keep', 'rivals not looked at: never promote');
});

test('promote needs smallRow: a cheap CHOOSE card without it stays a CHOOSE', () => {
  assert.equal(stakesDecision({ ...choose, smallRow: false }), 'keep');
  assert.equal(stakesDecision({ ...choose, smallRow: undefined }), 'keep');
});

test('demote: a picture-confirmed card that is not high and not title-confirmed, at $50 or more', () => {
  assert.equal(stakesDecision(confirmed), 'demote');
  assert.equal(stakesDecision({ ...confirmed, priceTypical: 50 }), 'demote');
  assert.equal(stakesDecision({ ...confirmed, priceTypical: 49.99 }), 'keep');
  assert.equal(stakesDecision({ ...confirmed, tier: 'low' }), 'demote');
});

test('demote never touches a high-tier read, a title-confirmed read or a confirmed card with smallRow lacking a price', () => {
  assert.equal(stakesDecision({ ...confirmed, tier: 'high' }), 'keep');
  assert.equal(stakesDecision({ ...confirmed, titleConfirmed: true }), 'keep');
  assert.equal(stakesDecision({ ...confirmed, priceTypical: 4 }), 'keep', 'cheap confirmed cards stay');
  assert.equal(stakesDecision({ state: 'confirmed', tier: 'medium', smallRow: true, priceTypical: 2 }), 'keep', 'a confirmed card is never promoted');
});

test('demote answers to the typical price, not the range high: a rare printing alone does not demote', () => {
  // A Potion with four printings: cheapest $0.21, range high $103.66, median about $5.
  assert.equal(stakesDecision({ ...confirmed, priceHigh: 103.66, priceTypical: 0.5 }), 'keep');
  assert.equal(stakesDecision({ ...confirmed, priceHigh: undefined, priceTypical: 303 }), 'demote');
  assert.equal(stakesDecision({ ...confirmed, priceTypical: undefined, priceHigh: 303 }), 'keep', 'the range high is not a demotion input');
});

test('promotion still uses the conservative range high, not the typical price', () => {
  assert.equal(stakesDecision({ ...choose, priceHigh: 103.66, priceTypical: 0.5 }), 'keep');
  assert.equal(stakesDecision({ ...choose, priceHigh: 4, priceTypical: 400 }), 'promote');
});

test('a card the user confirmed is never changed', () => {
  assert.equal(stakesDecision({ ...confirmed, userConfirmed: true }), 'keep');
  assert.equal(stakesDecision({ ...choose, userConfirmed: true }), 'keep');
});

test('an unknown price never promotes and never demotes', () => {
  for (const priceHigh of [null, undefined, NaN, '12', Infinity]) {
    assert.equal(stakesDecision({ ...choose, priceHigh }), 'keep', `choose ${String(priceHigh)}`);
    assert.equal(stakesDecision({ ...confirmed, priceTypical: priceHigh }), 'keep', `confirmed ${String(priceHigh)}`);
  }
});

test('a card back is left alone', () => {
  assert.equal(stakesDecision({ state: 'back', tier: 'low', smallRow: true, priceHigh: 1 }), 'keep');
  assert.equal(stakesDecision({ state: 'back', tier: 'low', priceTypical: 500 }), 'keep');
});

const grid = (values) => ({ source: 'pokemontcg', variants: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { market: v, conditions: { NM: v } }])) });

test('priceHighOf: the single quote, else the high end of the open range, else null', () => {
  assert.equal(priceHighOf({ identity: { id: 'a', name: 'A' }, setChoices: [], price_grid: grid({ normal: 7 }) }, null), 7);
  assert.equal(priceHighOf({ identity: { id: 'a', name: 'A' }, setChoices: [], price_grid: grid({ normal: 7, holofoil: 90 }) }, null), 90);
  assert.equal(priceHighOf({ identity: { id: 'a', name: 'A' }, setChoices: [], price_grid: grid({ normal: 7, holofoil: 90 }) }, 'normal'), 7);
  const open = { identity: { name: 'A' }, setChoices: [{ id: 'x' }, { id: 'y' }], setRange: { low: 2, high: 60, count: 2, total: 2 }, price_grid: null };
  assert.equal(priceHighOf(open, null), 60);
  assert.equal(priceHighOf({ identity: { id: 'a', name: 'A' }, setChoices: [], price_grid: null, market_price: null }, null), null);
});

const row = (id, name) => ({ id, name, set: 'S', setCode: 's', number: '1' });

const one = (grid_, extra = {}) => ({ identity: { id: 'a', name: 'A' }, setChoices: [], price_grid: grid_, ...extra });

test('two printings: the lower price is typical, so $0.34 and $103.66 is not demoted', () => {
  const two = one(grid({ normal: 0.34, first: 103.66 }));
  assert.equal(priceTypicalOf(two, null), 0.34);
  assert.equal(stakesDecision({ ...confirmed, priceTypical: priceTypicalOf(two, null) }), 'keep');
  const settled = one(grid({ normal: 303 }));
  assert.equal(stakesDecision({ ...confirmed, priceTypical: priceTypicalOf(settled, null) }), 'demote');
  assert.equal(priceTypicalOf(one(grid({ a: 9, b: 1, c: 5, d: 100, e: 2, f: 50 })), null), 5, 'six prices: the 3rd lowest');
});

test('priceTypicalOf: the quote when settled, else the median NM price over the printings, else null', () => {
  // range $0.21-$103.66 over four printings: the lower middle value (2nd lowest)
  const potion = one(grid({ normal: 0.21, reverse: 0.5, holo: 10, first: 103.66 }));
  assert.equal(priceTypicalOf(potion, null), 0.5);
  assert.equal(priceHighOf(potion, null), 103.66);
  // odd count: the middle one
  assert.equal(priceTypicalOf(one(grid({ a: 1, b: 7, c: 200 })), null), 7);
  // a settled printing is quoted
  assert.equal(priceTypicalOf(potion, 'first'), 103.66);
  // one printing: that price
  assert.equal(priceTypicalOf(one(grid({ normal: 303 })), null), 303);
  // printings with no NM price are left out; none at all: no typical price
  const partial = one({ source: 'x', variants: { a: { conditions: { NM: 4 } }, b: { conditions: {} }, c: { conditions: { NM: 8 } } } });
  assert.equal(priceTypicalOf(partial, null), 4, 'two prices: the lower one');
  assert.equal(priceTypicalOf(one({ source: 'x', variants: { a: { conditions: {} } } }), null), null);
  assert.equal(priceTypicalOf(one(null, { market_price: null }), null), null);
  // legacy single market price
  assert.equal(priceTypicalOf(one(null, { market_price: 60 }), null), 60);
  // an open set with only a range row has no per-printing prices: no demotion price
  assert.equal(priceTypicalOf({ identity: { name: 'A' }, setChoices: [{ id: 'x' }, { id: 'y' }], setRange: { low: 2, high: 60, count: 2, total: 2 }, price_grid: null }, null), null);
});

test('promoteCard builds the identified card like a pick, marks autoConfirmed, and is not user-confirmed', () => {
  const a = row('a-1', 'Pidgey');
  const card = { identity: { name: 'Pidgey' }, confidence: 0.49, abstain: false, unsure: true, smallRow: true, smallSource: true, candidates: [a, row('b', 'Rattata')], box: [0, 0, 1, 1] };
  const resp = { identity: a, market_price: 2, price_variant: 'normal', price_grid: grid({ normal: 2 }) };
  assert.equal(chooseState(card), 'choose');
  const next = promoteCard(card, resp);
  assert.equal(chooseState(next), 'confirmed');
  assert.equal(next.autoConfirmed, true);
  assert.equal(next.userConfirmed, undefined);
  assert.equal(next.identity.id, 'a-1');
  assert.equal(next.price_grid.variants.normal.market, 2);
  assert.equal(next.setConfirmed, true);
  assert.deepEqual(next.setChoices, []);
  assert.equal(next.abstain, false);
  assert.equal(next.pricing, false);
  assert.equal(next.candidates.length, 2, 'candidates stay so Wrong card? and search keep working');
  assert.equal(lotEstimate([next], () => null).identified, 1);
});

test('demoteCard turns a confirmed card into a CHOOSE card with its own name preselected and valueCheck', () => {
  const rows = [row('x', 'Charmeleon'), row('c-2', 'Charizard'), row('y', 'Charmander')];
  const card = {
    identity: rows[1], confidence: 0.7, abstain: false, market_price: 80, price_grid: grid({ holofoil: 80 }), candidates: rows,
    setChoices: [], setConfirmed: false, box: [0, 0, 1, 1],
  };
  assert.equal(chooseState(card), 'confirmed');
  const next = demoteCard(card);
  assert.equal(chooseState(next), 'choose');
  assert.equal(next.valueCheck, true);
  assert.equal(next.candidates[0].id, 'c-2');
  assert.deepEqual(next.candidates.map((c) => c.id).sort(), ['c-2', 'x', 'y']);
  assert.equal(lotEstimate([next], () => null).toIdentify, 1);
  assert.ok(next.confidence < 0.5);
});

test('demoteCard adds the current card to the candidates when the list lacks it', () => {
  const card = { identity: row('c-2', 'Charizard'), confidence: 0.7, abstain: false, candidates: [row('x', 'Charmeleon')], setChoices: [] };
  assert.equal(demoteCard(card).candidates[0].id, 'c-2');
});

test('isDemotable: only a named, non-high, not title-confirmed card that is not already a user answer', () => {
  const base = { identity: row('a', 'A'), confidence: 0.7, abstain: false, setChoices: [] };
  assert.equal(isDemotable(base), true);
  assert.equal(isDemotable({ ...base, confidence: 0.9 }), false);
  assert.equal(isDemotable({ ...base, titleConfirmed: true }), false);
  assert.equal(isDemotable({ ...base, userConfirmed: true }), false);
  assert.equal(isDemotable({ ...base, autoConfirmed: true }), false);
  assert.equal(isDemotable({ ...base, cardBack: true }), false);
  assert.equal(isDemotable({ ...base, abstain: true }), false);
  assert.equal(isDemotable({ ...base, numberRead: '5/102' }), false, 'a printed number read is not picture-only evidence');
});

// A card confirmed by the user's own earlier correction (confirmedBy 'correction'): at $50 or more it needs H (0.86).
const byCorrection = { state: 'confirmed', tier: 'medium', titleConfirmed: true, confirmedBy: 'correction', correctionCos: 0.9, priceTypical: 80 };

test('a correction-confirmed card at $50 or more is kept at or above H, demoted below it, whatever the title says', () => {
  assert.equal(stakesDecision(byCorrection), 'keep');
  assert.equal(stakesDecision({ ...byCorrection, correctionCos: 0.86 }), 'keep');
  assert.equal(stakesDecision({ ...byCorrection, correctionCos: 0.859 }), 'demote');
  assert.equal(stakesDecision({ ...byCorrection, correctionCos: undefined }), 'demote');
});

test('a correction-confirmed card under $50 or with no price is kept', () => {
  assert.equal(stakesDecision({ ...byCorrection, correctionCos: 0.84, priceTypical: 49.99 }), 'keep');
  assert.equal(stakesDecision({ ...byCorrection, correctionCos: 0.84, priceTypical: null }), 'keep');
  assert.equal(stakesDecision({ ...byCorrection, correctionCos: 0.84, priceTypical: 50 }), 'demote');
});

test('a user pick is never demoted, even one that was confirmed by a correction before', () => {
  assert.equal(stakesDecision({ ...byCorrection, correctionCos: 0.8, userConfirmed: true }), 'keep');
});

test('isDemotable accepts a correction-confirmed card (title confirmation does not shield it) but not a user pick or a number read', () => {
  const card = { identity: { id: 'a', name: 'A' }, confidence: 0.79, confirmedBy: 'correction', titleConfirmed: true, memory: { cos: 0.84 } };
  assert.equal(isDemotable(card), true);
  assert.equal(isDemotable({ ...card, userConfirmed: true }), false);
  assert.equal(isDemotable({ ...card, numberRead: '4/102' }), false);
  assert.equal(isDemotable({ ...card, confirmedBy: undefined }), false);
});

test('promoteCard marks the why-record as promoted', () => {
  const card = { identity: { name: 'A' }, why: { w: 1, src: 'picture', cos: 0.7 }, candidates: [] };
  const out = promoteCard(card, { identity: { id: 'a', name: 'A' }, market_price: 1 });
  assert.equal(out.why.src, 'promoted');
  assert.equal(out.why.cos, 0.7);
  assert.equal(promoteCard({ identity: {} }, { identity: { id: 'a' } }).why, undefined);
});
