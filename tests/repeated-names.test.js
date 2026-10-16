import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BELOW_HIGH_CONFIDENCE, REPEATED_NAME_MIN, markRepeatedNames } from '../tools/extension-wasm/lib/fusion.js';
import { classifyCard, confTier } from '../tools/extension-wasm/lib/card-display.js';

const sure = (name, id) => ({ identity: { id, name, set: 'Fossil' }, confidence: 0.9, abstain: false, box: [0, 0, 1, 1], market_price: 4.5 });

test('three boxes with one name keep the name and price, lose "high", and are flagged for a check', () => {
  const lot = [sure('Arbok', 'a1'), sure('Arbok', 'a2'), sure('Magnemite', 'm1'), sure('arbok ', 'a3')];
  const out = markRepeatedNames(lot);
  assert.equal(out.length, lot.length);
  for (const i of [0, 1, 3]) {
    assert.equal(out[i].identity.name, lot[i].identity.name);
    assert.notEqual(out[i].unsure, true, 'no blocking picker');
    assert.equal(out[i].repeatedName, true);
    assert.equal(out[i].confidence, BELOW_HIGH_CONFIDENCE);
    assert.equal(confTier(out[i].confidence), 'medium');
    assert.equal(out[i].market_price, lot[i].market_price);
    assert.equal(classifyCard(out[i]), 'identified');
  }
  assert.equal(out[2], lot[2]);
  assert.equal(lot[0].unsure, undefined, 'the input is not mutated');
});

test('two copies of a card are left alone', () => {
  const lot = [sure('Arbok', 'a1'), sure('Arbok', 'a2'), sure('Magnemite', 'm1')];
  const out = markRepeatedNames(lot);
  assert.deepEqual(out, lot);
  assert.equal(REPEATED_NAME_MIN, 3);
});

test('a low confidence is not raised, and abstains are not counted or changed', () => {
  const unsureOne = { ...sure('Arbok', 'a1'), confidence: 0.3 };
  const abstained = { identity: null, confidence: 0.4, abstain: true };
  const lot = [unsureOne, sure('Arbok', 'a2'), sure('Arbok', 'a3'), abstained, abstained];
  const out = markRepeatedNames(lot);
  assert.equal(out[0].confidence, 0.3);
  assert.equal(out[0].repeatedName, true);
  assert.equal(out[3], abstained);
  const withAbstains = markRepeatedNames([sure('Arbok', 'a1'), sure('Arbok', 'a2'), abstained]);
  assert.equal(withAbstains[0].repeatedName, undefined);
});

test('a name found only through a set menu still counts', () => {
  const menu = (n) => ({ identity: { name: 'Arbok' }, confidence: 0.9, abstain: false, setChoices: [{ id: 'x' }, { id: 'y' }], n });
  const out = markRepeatedNames([menu(1), menu(2), menu(3)]);
  assert.ok(out.every((c) => c.repeatedName === true && c.identity.name === 'Arbok'));
});

test('a bulk lot of many different cards is untouched', () => {
  const lot = ['A', 'B', 'C', 'D', 'E'].map((n, i) => sure(n, 'id' + i));
  assert.deepEqual(markRepeatedNames(lot), lot);
});
