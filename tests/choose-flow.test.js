import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bulkPairs,
  candidateView,
  chooseHeading,
  chooseIndexes,
  chooseState,
  confirmLabel,
  nameAgreesWithPhoto,
  overlayStateOf,
  renderCandidateCards,
  renderChooseGroup,
} from '../tools/extension-wasm/lib/choose-flow.js';

const cand = (id, name, extra = {}) => ({ id, name, set: 'Base Set', setCode: 'base1', number: '58', ...extra });
const grid = { source: 'pokemontcg', variants: { normal: { market: 5, conditions: { NM: 5 } } } };
const sure = (extra = {}) => ({ identity: cand('base1-58', 'Pikachu'), confidence: 0.9, abstain: false, price_grid: grid, ...extra });
const choose = (extra = {}) => ({ identity: null, confidence: 0.3, abstain: true, candidates: [cand('a-1', 'Pidgey'), cand('b-2', 'Rattata')], ...extra });

test('chooseState: confirmed or choose, never a guess tier; card backs are their own state', () => {
  assert.equal(chooseState(sure()), 'confirmed');
  assert.equal(chooseState(choose()), 'choose');
  assert.equal(chooseState(choose({ candidates: [] })), 'choose');
  // A named but unsure read is still a choice: no name is asserted.
  assert.equal(chooseState({ identity: cand('x', 'Mew'), unsure: true, confidence: 0.3, candidates: [cand('x', 'Mew')] }), 'choose');
  assert.equal(chooseState({ cardBack: true }), 'back');
  assert.equal(chooseState(null), 'back');
  // The user just picked it and the price is loading: it is already confirmed.
  assert.equal(chooseState({ ...choose(), identity: cand('a-1', 'Pidgey'), unsure: true, pricing: true }), 'confirmed');
});

test('overlayStateOf: choose for every card to confirm, none for backs, identified or printing otherwise', () => {
  assert.equal(overlayStateOf(choose()), 'choose');
  assert.equal(overlayStateOf({ identity: cand('x', 'Mew'), unsure: true, topGuess: { name: 'Mew' } }), 'choose');
  assert.equal(overlayStateOf({ cardBack: true }), 'none');
  assert.equal(overlayStateOf(sure()), 'identified');
  const open = sure({ setChoices: [{ id: 'a' }, { id: 'b' }], setConfirmed: false, setRange: { low: 3, high: 9, count: 2, total: 2 }, price_grid: null });
  assert.equal(overlayStateOf(open), 'printing');
});

test('nameAgreesWithPhoto uses the title verdict the scan already carries, and nothing else', () => {
  const pidgey = cand('a-1', 'Pidgey');
  const rattata = cand('b-2', 'Rattata');
  // The title line named a different catalog card than the picture did.
  assert.equal(nameAgreesWithPhoto(choose({ titleContradicts: 'Rattata' }), rattata), true);
  assert.equal(nameAgreesWithPhoto(choose({ titleContradicts: 'Rattata' }), pidgey), false);
  // The title line confirmed the picture's name, or the card was re-ranked to the name the title spells.
  assert.equal(nameAgreesWithPhoto({ ...choose(), identity: pidgey, titleConfirmed: true }, pidgey), true);
  assert.equal(nameAgreesWithPhoto({ ...choose(), identity: pidgey, titleReranked: true }, cand('z-9', 'Pidgey')), true);
  assert.equal(nameAgreesWithPhoto({ ...choose(), identity: pidgey, titleReranked: true }, rattata), false);
  // No verdict, no mark.
  assert.equal(nameAgreesWithPhoto(choose(), pidgey), false);
  assert.equal(nameAgreesWithPhoto(null, pidgey), false);
});

test('candidateView: art, name, set, number and printing for one candidate, best flagged', () => {
  const art = 'https://assets.tcgdex.net/en/base/base1/58/high.webp';
  const view = candidateView(choose({ titleContradicts: 'Pidgey' }), cand('a-1', 'Pidgey', { imageUrl: art, printing: 'Holofoil' }), { best: true });
  assert.equal(view.id, 'a-1');
  assert.equal(view.name, 'Pidgey');
  assert.equal(view.art, art);
  assert.equal(view.set, 'Base Set');
  assert.equal(view.number, '58');
  assert.equal(view.printing, 'Holofoil');
  assert.equal(view.agrees, true);
  assert.equal(view.best, true);
  assert.match(view.label, /Pidgey, Base Set, number 58, Holofoil/);
  assert.match(view.label, /name matches the photo/);
  assert.match(view.label, /best match/i);
  const plain = candidateView(choose(), cand('b-2', 'Rattata'));
  assert.equal(plain.printing, null);
  assert.equal(plain.agrees, false);
  assert.equal(plain.best, false);
  // No catalog image: the pokemontcg.io one, else none.
  assert.equal(plain.art, 'https://images.pokemontcg.io/base1/58.png');
  assert.equal(candidateView(choose(), { id: 'q', name: 'Q' }).art, null);
});

test('chooseIndexes and bulkPairs: only cards to choose, only those with a candidate, best first', () => {
  const cards = [sure(), choose(), { cardBack: true }, choose({ candidates: [] }), choose({ candidates: [cand('c-3', 'Zubat')] })];
  assert.deepEqual(chooseIndexes(cards), [1, 3, 4]);
  const pairs = bulkPairs(cards);
  assert.deepEqual(pairs.map((p) => [p.idx, p.candidate.id]), [[1, 'a-1'], [4, 'c-3']]);
});

test('headings and counts read plainly', () => {
  assert.equal(chooseHeading(3), 'To confirm (3)');
  assert.equal(confirmLabel(4), 'Confirm 4');
  assert.equal(confirmLabel(0), 'Confirm 0');
});

test('renderCandidateCards: art next to name, set, number, printing; best preselected; agreement marked; escaped', () => {
  const card = choose({ titleContradicts: 'Rattata', candidates: [cand('a-1', 'Pid<gey>', { imageUrl: 'https://x.test/a.png' }), cand('b-2', 'Rattata')] });
  const html = renderCandidateCards(card, 7);
  assert.equal((html.match(/data-pick=/g) || []).length, 2);
  assert.match(html, /data-pick="a-1" data-idx="7"/);
  assert.equal((html.match(/class="pick-best"/g) || []).length, 1);
  assert.ok(html.indexOf('Best match') < html.indexOf('data-pick="b-2"'));
  assert.equal((html.match(/pick-agree/g) || []).length, 1);
  assert.ok(html.indexOf('pick-agree') > html.indexOf('data-pick="b-2"'));
  assert.match(html, /<img src="https:\/\/x\.test\/a\.png"/);
  assert.match(html, /Pid&lt;gey&gt;/);
  assert.doesNotMatch(html, /Pid<gey>/);
  assert.equal(renderCandidateCards(choose({ candidates: [] }), 0), '');
});

test('renderChooseGroup: a disclosure over the rows, counted, empty when nothing to choose', () => {
  assert.equal(renderChooseGroup('<div></div>', 0, true), '');
  const open = renderChooseGroup('<div class="row"></div>', 2, true);
  assert.match(open, /To confirm \(2\)/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /data-choose-toggle/);
  assert.doesNotMatch(open, / hidden>/);
  assert.match(renderChooseGroup('<div></div>', 2, false), /aria-expanded="false"/);
  assert.match(renderChooseGroup('<div></div>', 2, false), /hidden/);
});

test('candidatesOfCard: the closest candidates, else the sets the name is printed in, else none', async () => {
  const { candidatesOfCard } = await import('../tools/extension-wasm/lib/choose-flow.js');
  assert.deepEqual(candidatesOfCard(choose()).map((c) => c.id), ['a-1', 'b-2']);
  const sets = [cand('s-1', 'Eevee'), cand('s-2', 'Eevee')];
  assert.deepEqual(candidatesOfCard({ identity: { name: 'Eevee' }, setChoices: sets, candidates: [] }).map((c) => c.id), ['s-1', 's-2']);
  assert.deepEqual(candidatesOfCard({ abstain: true }), []);
  // A picture-only best-guess set with nothing to quote is still a choice among its sets.
  const open = { identity: { name: 'Eevee' }, confidence: 0.9, setChoices: sets, setConfirmed: false, bestGuess: { source: 'image' } };
  assert.equal(chooseState(open), 'choose');
  assert.deepEqual(bulkPairs([open]).map((p) => p.candidate.id), ['s-1']);
});
