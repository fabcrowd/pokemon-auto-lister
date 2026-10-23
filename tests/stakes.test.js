import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HIGH_STAKES_MIN_USD, LOW_STAKES_MAX_USD, demoteCard, isDemotable, priceHighOf, promoteCard, stakesDecision,
} from '../tools/extension-wasm/lib/stakes.js';
import { chooseState } from '../tools/extension-wasm/lib/choose-flow.js';
import { lotEstimate } from '../tools/extension-wasm/lib/card-display.js';

const choose = { state: 'choose', tier: 'low', smallRow: true, priceHigh: 3 };
const confirmed = { state: 'confirmed', tier: 'medium', titleConfirmed: false, priceHigh: 80 };

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

test('promote needs smallRow: a cheap CHOOSE card without it stays a CHOOSE', () => {
  assert.equal(stakesDecision({ ...choose, smallRow: false }), 'keep');
  assert.equal(stakesDecision({ ...choose, smallRow: undefined }), 'keep');
});

test('demote: a picture-confirmed card that is not high and not title-confirmed, at $50 or more', () => {
  assert.equal(stakesDecision(confirmed), 'demote');
  assert.equal(stakesDecision({ ...confirmed, priceHigh: 50 }), 'demote');
  assert.equal(stakesDecision({ ...confirmed, priceHigh: 49.99 }), 'keep');
  assert.equal(stakesDecision({ ...confirmed, tier: 'low' }), 'demote');
});

test('demote never touches a high-tier read, a title-confirmed read or a confirmed card with smallRow lacking a price', () => {
  assert.equal(stakesDecision({ ...confirmed, tier: 'high' }), 'keep');
  assert.equal(stakesDecision({ ...confirmed, titleConfirmed: true }), 'keep');
  assert.equal(stakesDecision({ ...confirmed, priceHigh: 4 }), 'keep', 'cheap confirmed cards stay');
  assert.equal(stakesDecision({ state: 'confirmed', tier: 'medium', smallRow: true, priceHigh: 2 }), 'keep', 'a confirmed card is never promoted');
});

test('a card the user confirmed is never changed', () => {
  assert.equal(stakesDecision({ ...confirmed, userConfirmed: true }), 'keep');
  assert.equal(stakesDecision({ ...choose, userConfirmed: true }), 'keep');
});

test('an unknown price never promotes and never demotes', () => {
  for (const priceHigh of [null, undefined, NaN, '12', Infinity]) {
    assert.equal(stakesDecision({ ...choose, priceHigh }), 'keep', `choose ${String(priceHigh)}`);
    assert.equal(stakesDecision({ ...confirmed, priceHigh }), 'keep', `confirmed ${String(priceHigh)}`);
  }
});

test('a card back is left alone', () => {
  assert.equal(stakesDecision({ state: 'back', tier: 'low', smallRow: true, priceHigh: 1 }), 'keep');
  assert.equal(stakesDecision({ state: 'back', tier: 'low', priceHigh: 500 }), 'keep');
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
