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
  // Rattata agrees with the photo's name line, so it is the preselected one and carries both marks.
  assert.ok(html.indexOf('data-pick="b-2"') < html.indexOf('data-pick="a-1"'));
  assert.ok(html.indexOf('Best match') < html.indexOf('data-pick="a-1"'));
  assert.equal((html.match(/pick-agree/g) || []).length, 1);
  assert.ok(html.indexOf('pick-agree') < html.indexOf('data-pick="a-1"'));
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

// ── Preselection and bulk defaults ──
import { CLEAR_GAP } from '../tools/extension-wasm/lib/fusion.js';
import * as flow from '../tools/extension-wasm/lib/choose-flow.js';

const ordered = flow.candidatesOfCard;
const bulkDecisive = (card) => flow.bulkDecisive?.(card);

const ranked = (...pairs) => pairs.map(([id, rank]) => ({ id, rank }));

test('preselection: a candidate whose name agrees with the photo comes first and carries the best tag', () => {
  const card = choose({ titleContradicts: 'Rattata', candidates: [cand('a-1', 'Pidgey'), cand('b-2', 'Rattata'), cand('c-3', 'Zubat')] });
  assert.deepEqual(ordered(card).map((c) => c.id), ['b-2', 'a-1', 'c-3']);
  const html = renderCandidateCards(card, 0);
  assert.ok(html.indexOf('Best match') < html.indexOf('data-pick="a-1"'));
  assert.ok(html.indexOf('data-pick="b-2"') < html.indexOf('data-pick="a-1"'));
  assert.equal((html.match(/class="pick-best"/g) || []).length, 1);
  assert.equal((html.match(/pick-agree/g) || []).length, 1);
  assert.deepEqual(bulkPairs([card]).map((p) => p.candidate.id), ['b-2']);
});

test('preselection: no name agreement or no title evidence keeps the closest-first order', () => {
  assert.deepEqual(ordered(choose()).map((c) => c.id), ['a-1', 'b-2']);
  // Titled confirmed but the confirmed name is not among the candidates: unchanged.
  const none = choose({ identity: cand('z-9', 'Mew'), titleConfirmed: true });
  assert.deepEqual(ordered(none).map((c) => c.id), ['a-1', 'b-2']);
});

test('preselection: a candidate the title contradicts is never first while another exists', () => {
  // The picture said Pidgey, the title spelled Rattata, and Rattata is not offered: Pidgey is contradicted.
  const card = choose({ identity: cand('a-1', 'Pidgey'), titleContradicts: 'Rattata', candidates: [cand('a-1', 'Pidgey'), cand('c-3', 'Zubat')] });
  assert.deepEqual(ordered(card).map((c) => c.id), ['c-3', 'a-1']);
  const lone = choose({ identity: cand('a-1', 'Pidgey'), titleContradicts: 'Rattata', candidates: [cand('a-1', 'Pidgey')] });
  assert.deepEqual(ordered(lone).map((c) => c.id), ['a-1']);
});

test('bulkDecisive: name agreement, or a lead over the next different-name candidate of at least CLEAR_GAP', () => {
  const two = (rows, extra = {}) => choose({ candidates: [cand('a-1', 'Pidgey'), cand('b-2', 'Rattata')], ranked: rows, ...extra });
  assert.equal(bulkDecisive(two(ranked(['a-1', 0.9], ['b-2', 0.9 - CLEAR_GAP]))), true);
  assert.equal(bulkDecisive(two(ranked(['a-1', 0.9], ['b-2', 0.9 - CLEAR_GAP + 0.005]))), false);
  // Another printing of the same name is not a rival.
  const printings = choose({ candidates: [cand('a-1', 'Pidgey'), cand('a-2', 'Pidgey'), cand('b-2', 'Rattata')], ranked: ranked(['a-1', 0.9], ['a-2', 0.89], ['b-2', 0.8]) });
  assert.equal(bulkDecisive(printings), true);
  // Name agreement decides even with no scores.
  assert.equal(bulkDecisive(choose({ titleContradicts: 'Rattata' })), true);
  // No scores to measure a lead: not decisive.
  assert.equal(bulkDecisive(choose()), false);
  assert.equal(bulkDecisive(two(ranked(['a-1', 0.9]))), false);
  // Every candidate shares one name: only the printing is open, and that is the user's pick.
  assert.equal(bulkDecisive(choose({ candidates: [cand('a-1', 'Pidgey'), cand('a-2', 'Pidgey')] })), false);
  assert.equal(bulkDecisive(choose({ candidates: [cand('a-1', 'Pidgey'), cand('a-2', 'Pidgey')], titleConfirmed: true, identity: cand('a-1', 'Pidgey'), ranked: scored(['a-1', 0.9], ['a-2', 0.1]) })), false);
});

const scored = (...pairs) => pairs.map(([id, score]) => ({ id, rank: score - 0.05, score }));

test('bulkDecisive from scores: the lead is measured on the similarity score, exactly CLEAR_GAP is enough', () => {
  const two = (rows) => choose({ candidates: [cand('a-1', 'Pidgey'), cand('b-2', 'Rattata')], ranked: rows });
  assert.equal(bulkDecisive(two(scored(['a-1', 0.9], ['b-2', 0.9 - CLEAR_GAP]))), true);
  assert.equal(bulkDecisive(two(scored(['a-1', 0.9], ['b-2', 0.9 - CLEAR_GAP / 2]))), false);
  assert.equal(bulkDecisive(two(scored(['a-1', 0.9], ['b-2', 0.5]))), true);
  // A same-name rival is ignored even when it scores higher than the different-name one.
  const mixed = choose({ candidates: [cand('a-1', 'Pidgey'), cand('a-2', 'Pidgey'), cand('b-2', 'Rattata')], ranked: scored(['a-1', 0.9], ['a-2', 0.899], ['b-2', 0.7]) });
  assert.equal(bulkDecisive(mixed), true);
  // The score wins over a rank that says otherwise.
  assert.equal(bulkDecisive(two([{ id: 'a-1', rank: 0.9, score: 0.9 }, { id: 'b-2', rank: 0.89, score: 0.5 }])), true);
  // No scores: not decisive unless the name agrees.
  assert.equal(bulkDecisive(two(undefined)), false);
  assert.equal(bulkDecisive(two(scored(['a-1', 0.9]))), false);
});

test('bulkPairs carries the decisive flag for the default tick', () => {
  const pairs = bulkPairs([
    choose({ candidates: [cand('a-1', 'Pidgey'), cand('b-2', 'Rattata')], ranked: ranked(['a-1', 0.9], ['b-2', 0.8]) }),
    choose(),
  ]);
  assert.deepEqual(pairs.map((p) => p.decisive), [true, false]);
});

// ── Review all must not turn a bulk tick into a remembered correction ──

test('bulk confirm remembers only a Check pair the user ticked on its own, never a preselected one', () => {
  const decisive = { idx: 0, candidate: cand('a-1', 'Pidgey'), decisive: true };
  const check = { idx: 1, candidate: cand('b-2', 'Rattata'), decisive: false };
  const checkTickAll = { idx: 2, candidate: cand('c-3', 'Zubat'), decisive: false };
  const kept = [decisive, check, checkTickAll];
  // Pair 1 was ticked by hand; pair 2 only got its tick from Tick all.
  assert.deepEqual(flow.bulkRememberedPairs(kept, new Set([1])).map((p) => p.idx), [1]);
  assert.deepEqual(flow.bulkRememberedPairs(kept, new Set()).map((p) => p.idx), []);
  // A decisive pair is the scanner's own preselection: ticking it by hand does not make it a correction.
  assert.deepEqual(flow.bulkRememberedPairs(kept, new Set([0])).map((p) => p.idx), []);
});
