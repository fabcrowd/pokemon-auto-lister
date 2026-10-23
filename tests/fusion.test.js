import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capUnconfirmedSet, fuseResults, UNCONFIRMED_SET_CONFIDENCE_CAP } from '../tools/extension-wasm/lib/fusion.js';
import { confTier } from '../tools/extension-wasm/lib/card-display.js';

// The confirm rule (confirm-rule.test.js) decides first; these tests exercise the fallback gate that names a CHOOSE,
// at 200 px where the different-name gap G is 0.03, so a near-tie is not confirmed.
const AT_200 = { height: 200 };

test('a name that leads a near-tie beats one lookalike', () => {
  const meta = [
    { name: 'Exeggutor δ', set: 'A' },
    { name: 'Sunflora', set: 'B' },
    { name: 'Sunflora', set: 'C' },
  ];
  const result = fuseResults([
    { index: 0, score: 0.799 },
    { index: 1, score: 0.798 },
    { index: 2, score: 0.791 },
  ], null, meta, [], AT_200);
  assert.equal(result.abstain, false);
  assert.equal(result.choose, true);
  assert.equal(result.identity.name, 'Sunflora');
  assert.equal(result.identity.set, 'B');
});

test('later repeats of a lookalike do not outvote the top of the list', () => {
  const meta = [
    { name: 'PokéNav' },
    { name: 'Poké Blower +' },
    { name: 'Switch' },
    { name: 'PokéNav' },
    { name: 'PokéNav' },
  ];
  const result = fuseResults([
    { index: 0, score: 0.792 },
    { index: 1, score: 0.792 },
    { index: 2, score: 0.789 },
    { index: 3, score: 0.780 },
    { index: 4, score: 0.775 },
  ], null, meta, [], AT_200);
  assert.equal(result.abstain, true);
});

test('a tie between different names still abstains', () => {
  const meta = [
    { name: 'Wynaut' },
    { name: 'Squirtle' },
    { name: 'Gible' },
  ];
  const result = fuseResults([
    { index: 0, score: 0.841 },
    { index: 1, score: 0.836 },
    { index: 2, score: 0.831 },
  ], null, meta, [], AT_200);
  assert.equal(result.abstain, true);
  assert.equal(result.reason, 'ambiguous');
});

test('rank decides who leads and how far ahead in the fallback gate; the confirm rule judges the cosine', () => {
  const meta = [{ name: 'Onix' }, { name: 'Seel' }];
  // Onix has the higher cosine but a hub penalty put Seel first: the gap is measured on rank.
  const clear = fuseResults([
    { index: 1, score: 0.78, rank: 0.8 },
    { index: 0, score: 0.79, rank: 0.7 },
  ], null, meta, []);
  // Onix's cosine is higher, so the rule does not confirm Seel; the gate still names it (on rank) as a CHOOSE.
  assert.equal(clear.identity.name, 'Seel');
  assert.equal(clear.reason, 'choose');
  assert.equal(clear.choose, true);
  assert.equal(clear.confidence, 0.49);
  const ranked = fuseResults([
    { index: 1, score: 0.85, rank: 0.85 },
    { index: 0, score: 0.7, rank: 0.7 },
  ], null, meta, []);
  assert.equal(ranked.reason, 'confirmed');
  assert.equal(ranked.confidence, 0.85);

  const tooClose = fuseResults([
    { index: 1, score: 0.78, rank: 0.8 },
    { index: 0, score: 0.79, rank: 0.79 },
  ], null, meta, []);
  assert.equal(tooClose.abstain, true);

  const low = fuseResults([
    { index: 1, score: 0.7, rank: 0.9 },
    { index: 0, score: 0.5, rank: 0.5 },
  ], null, meta, []);
  assert.equal(low.reason, 'low_sim');
});

const pair = (names, scores) => ({
  meta: names.map((name) => ({ name })),
  hits: scores.map((score, index) => ({ index, score })),
});

test('a confirmed read with a lead of 0.022 is accepted; only the high tier needs more', () => {
  const { meta, hits } = pair(['Lugia', 'Gyarados'], [0.84, 0.818]);
  const result = fuseResults(hits, null, meta, []);
  assert.equal(result.abstain, false);
  assert.equal(result.reason, 'confirmed');
  assert.equal(confTier(result.confidence), 'medium');
});

test('high needs a lead of 0.025 and a similarity of 0.82; the same read below either is medium', () => {
  const sure = pair(['Charizard', 'Charmeleon'], [0.84, 0.81]);
  assert.equal(confTier(fuseResults(sure.hits, null, sure.meta, []).confidence), 'high');
  const smallLead = pair(['Charizard', 'Charmeleon'], [0.84, 0.82]);
  assert.equal(confTier(fuseResults(smallLead.hits, null, smallLead.meta, []).confidence), 'medium');
  const lowSim = pair(['Charizard', 'Charmeleon'], [0.81, 0.77]);
  const low = fuseResults(lowSim.hits, null, lowSim.meta, []);
  assert.equal(low.abstain, false);
  assert.equal(confTier(low.confidence), 'medium');
  assert.equal(low.confidence, 0.79);
});

test('a lower confidence is not raised, and a near-tie is never high', () => {
  const weak = pair(['Wartortle', 'Squirtle'], [0.74, 0.5]);
  assert.equal(fuseResults(weak.hits, null, weak.meta, []).confidence, 0.74);
  const sameName = pair(['Blastoise', 'Blastoise'], [0.93, 0.925]);
  const named = fuseResults(sameName.hits, null, sameName.meta, []);
  assert.equal(named.reason, 'confirmed');
  assert.notEqual(confTier(named.confidence), 'high');
  const tie = pair(['Eevee', 'Shellder'], [0.99, 0.985]);
  const highSim = fuseResults(tie.hits, null, tie.meta, []);
  assert.equal(highSim.reason, 'confirmed');
  assert.notEqual(confTier(highSim.confidence), 'high');
});

const reprintRead = (over = {}) => ({
  identity: { name: 'Blastoise' },
  confidence: 0.9,
  abstain: false,
  setChoices: [
    { id: 'base1-2', name: 'Blastoise', setCode: 'base1', number: '2' },
    { id: 'base4-2', name: 'Blastoise', setCode: 'base4', number: '2' },
  ],
  ...over,
});

test('reprints with the same art keep the name but are never shown as high', () => {
  const read = reprintRead();
  const out = capUnconfirmedSet(read);
  assert.equal(out.identity.name, 'Blastoise');
  assert.equal(out.abstain, false);
  assert.equal(out.setChoices.length, 2);
  assert.equal(out.confidence, UNCONFIRMED_SET_CONFIDENCE_CAP);
  assert.notEqual(confTier(out.confidence), 'high');
  assert.equal(confTier(out.confidence), 'medium');
  assert.equal(read.confidence, 0.9, 'the input is not mutated');
});

test('a set confirmed by number, symbol or stamp has no choices left and keeps its confidence', () => {
  const confirmed = reprintRead({ identity: { id: 'base1-2', name: 'Blastoise', setCode: 'base1' }, setChoices: undefined });
  assert.equal(capUnconfirmedSet(confirmed), confirmed);
  assert.equal(confTier(capUnconfirmedSet(confirmed).confidence), 'high');
});

test('a card with a single printing in reach and a read that already is lower are left alone', () => {
  const single = reprintRead({ setChoices: [{ id: 'base1-2' }] });
  assert.equal(capUnconfirmedSet(single), single);
  const low = reprintRead({ confidence: 0.6 });
  assert.equal(capUnconfirmedSet(low), low);
  const abstained = reprintRead({ abstain: true, confidence: 0.4 });
  assert.equal(capUnconfirmedSet(abstained), abstained);
  assert.equal(capUnconfirmedSet(null), null);
});

test('a printing picked only by how the picture looks is capped when other sets print the card, and kept when a read settled it', () => {
  const lookOnly = { identity: { id: 'base4-2', name: 'Blastoise', setCode: 'base4' }, confidence: 0.89, abstain: false, setUnconfirmed: true };
  const out = capUnconfirmedSet(lookOnly);
  assert.equal(out.confidence, UNCONFIRMED_SET_CONFIDENCE_CAP);
  assert.equal(out.confidenceBeforeSetCap, 0.89);
  assert.equal(out.identity.id, 'base4-2');
  assert.notEqual(confTier(out.confidence), 'high');
  const settled = { ...lookOnly, setUnconfirmed: false };
  assert.equal(capUnconfirmedSet(settled), settled);
  const read = { ...lookOnly };
  delete read.setUnconfirmed;
  assert.equal(capUnconfirmedSet(read), read, 'number, symbol and rules reads never carry the flag');
});

test('another version within reach keeps the name and the price but is never shown as high', () => {
  const read = { identity: { id: 'swsh4-43', name: 'Pikachu V' }, confidence: 0.9, abstain: false, versionChoices: [{ id: 'sv8-57', name: 'Pikachu ex' }] };
  const out = capUnconfirmedSet(read);
  assert.equal(out.confidence, UNCONFIRMED_SET_CONFIDENCE_CAP);
  assert.equal(confTier(out.confidence), 'medium');
  assert.equal(out.identity.id, 'swsh4-43');
  const none = { ...read, versionChoices: [] };
  assert.equal(capUnconfirmedSet(none), none);
});
