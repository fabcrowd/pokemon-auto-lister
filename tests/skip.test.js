import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SKIP_ID, UNSKIP_ID, isSkipRow, putBackCard, skipCard, skipDraft, skipHit, skipNote, skippedCount, unskipDraft } from '../tools/extension-wasm/lib/skip.js';
import { applyMemory, EMBEDDING_DIM } from '../tools/extension-wasm/lib/references.js';
import { REFERENCE_BARS, referenceBar } from '../tools/extension-wasm/lib/reference-bars.js';
import { memoryVerdict, skipVerdict } from '../tools/extension-wasm/lib/memory-confirm.js';
import { storeCorrection } from '../tools/extension-wasm/lib/correction-save.js';
import { createCorrectionsStore } from '../tools/extension-wasm/lib/corrections-store.js';
import { chooseState, bulkPairs, chooseIndexes, overlayStateOf } from '../tools/extension-wasm/lib/choose-flow.js';
import { isIdentified, lotEstimate, scanStatus, splitByRecognition } from '../tools/extension-wasm/lib/card-display.js';
import { lotExportLabels, lotExportRows } from '../tools/extension-wasm/lib/lot-export.js';
import { EMBEDDING_VERSION } from '../tools/extension-wasm/lib/embed.js';
import { fakeIndexedDB } from './helpers/fake-idb.js';

const V = EMBEDDING_VERSION;
const NOW = Date.UTC(2026, 9, 24);
const unit = (...head) => {
  const v = new Float32Array(EMBEDDING_DIM);
  head.forEach((x, i) => { v[i] = x; });
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};
const at = (score) => unit(score, Math.sqrt(1 - score * score));
const query = unit(1);
const skipRef = (score, extra = {}) => ({ id: 's:0', cardId: SKIP_ID, ts: NOW, v: V, embedding: at(score), wrongId: null, n: 1, ...extra });

const choose = (over = {}) => ({ identity: null, abstain: true, confidence: 0.3, candidates: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], ...over });
const sure = (over = {}) => ({
  identity: { id: 'base1-58', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' }, confidence: 0.9, abstain: false,
  price_grid: { source: 'pokemontcg', variants: { normal: { market: 5, conditions: { NM: 5 } } } }, ...over,
});
const none = () => null;

test('skipCard marks a card skipped; putBackCard returns it to Choose with its candidates, and neither loses the card data', () => {
  const card = choose();
  const skipped = skipCard(card);
  assert.equal(skipped.skipped, true);
  assert.equal(chooseState(skipped), 'skipped');
  assert.equal(overlayStateOf(skipped), 'skipped');
  const back = putBackCard(skipped);
  assert.equal(back.skipped, undefined);
  assert.equal(chooseState(back), 'choose');
  assert.deepEqual(back.candidates, card.candidates);
});

test('a skipped card is never identified, never shows a price, and is not a Choose row or a bulk pair', () => {
  const skipped = skipCard(choose());
  assert.equal(isIdentified(skipped), false);
  assert.deepEqual(chooseIndexes([skipped, choose()]), [1]);
  assert.equal(bulkPairs([skipped, choose()]).length, 1);
  assert.equal(isIdentified(skipCard(sure())), false);
});

test('counts: skipped cards leave To confirm, the lot estimate and the status line, and have their own count', () => {
  const cards = [sure(), choose(), skipCard(choose()), skipCard(choose())];
  const lot = lotEstimate(cards, none);
  assert.equal(lot.toIdentify, 1);
  assert.equal(lot.total, 2);
  assert.equal(lot.identified, 1);
  assert.equal(skippedCount(cards), 2);
  assert.equal(scanStatus(cards), 'Found 4 cards: 1 identified, 1 needs your pick');
  const split = splitByRecognition(cards);
  assert.deepEqual(split.shown, [0, 1]);
  assert.deepEqual(split.hidden, []);
  assert.deepEqual(split.skipped, [2, 3]);
});

test('export excludes skipped cards and says how many; they are not counted as still to confirm', () => {
  const cards = [sure(), choose(), skipCard(choose()), skipCard(sure())];
  const lot = lotExportRows(cards, none, ['NM'], NOW);
  assert.equal(lot.count, 1);
  assert.equal(lot.notIncluded, 1);
  assert.equal(lot.skipped, 2);
  assert.match(lotExportLabels(lot.count, lot.notIncluded, lot.skipped).tip, /2 skipped cards are not included/);
  assert.match(lotExportLabels(1, 0, 1).tip, /1 skipped card is not included/);
  assert.doesNotMatch(lotExportLabels(1, 0, 0).tip, /skipped/);
  assert.equal(skipNote(0), '');
  assert.equal(skipNote(3), '3 skipped cards are not included');
});

test('the skip draft stores type skip with the scanner why-record and the crop; the put-back draft has no crop', () => {
  const why = { w: 1, src: 'picture', cos: 0.7, h: 240, top5: [['a', 0.7]] };
  const draft = skipDraft({ ts: NOW, scanId: 's', index: 0, pageUrl: 'https://x.test/a?b=1', guess: { id: null, confidence: 0.3, abstain: true }, crop: 'data:image/jpeg;base64,AA', extVersion: '3.1.0', why });
  assert.equal(draft.type, 'skip');
  assert.equal(draft.pickedId, SKIP_ID);
  assert.equal(draft.via, 'skip');
  assert.equal(draft.id, 's:0');
  assert.equal(draft.why.h, 240);
  assert.equal(draft.crop, 'data:image/jpeg;base64,AA');
  assert.equal(draft.pageUrl, 'https://x.test/a');
  const undo = unskipDraft({ ts: NOW + 1, scanId: 's', index: 0, extVersion: '3.1.0' });
  assert.equal(undo.pickedId, UNSKIP_ID);
  assert.equal(undo.crop, null);
  assert.equal(isSkipRow(draft), true);
  assert.equal(isSkipRow(undo), false);
  assert.equal(isSkipRow({ pickedId: 'base1-58' }), false);
});

test('skip then put back keeps the skip in history; skipping again keeps both', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  const base = { scanId: 's', index: 0, extVersion: '3.1.0' };
  const why = { w: 1, src: 'picture' };
  await storeCorrection(store, skipDraft({ ...base, ts: NOW, crop: 'data:image/jpeg;base64,AA', why }), { now: NOW });
  await store.saveReference(skipRef(0.9));
  const undone = await storeCorrection(store, unskipDraft({ ...base, ts: NOW + 1 }), { now: NOW });
  assert.equal(undone.pickedId, UNSKIP_ID);
  assert.deepEqual(undone.history.map((h) => [h.pickedId, h.why?.src]), [[SKIP_ID, 'picture']]);
  assert.equal(await store.countReferences(), 0);
  const again = await storeCorrection(store, skipDraft({ ...base, ts: NOW + 2, crop: 'data:image/jpeg;base64,AA', why }), { now: NOW });
  assert.equal(again.pickedId, SKIP_ID);
  assert.equal(again.history.length, 2);
  assert.equal((await store.all()).length, 1);
});

test('skip rows share the cap: an old unprotected skip is evicted with its reference, a repeated correction is kept', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  const old = skipDraft({ ts: NOW - 100 * 86400000, scanId: 'o', index: 0, crop: 'data:image/jpeg;base64,AA' });
  await store.save({ ...old, count: 1, history: [] });
  await store.saveReference(skipRef(0.9, { id: 'o:0', ts: old.ts }));
  await store.save({ id: 'x2', ts: NOW - 300 * 86400000, pickedId: 'a', count: 2 });
  await storeCorrection(store, skipDraft({ ts: NOW, scanId: 'n', index: 0, crop: 'data:image/jpeg;base64,AA' }), { max: 2, now: NOW });
  assert.deepEqual((await store.all()).map((r) => r.id).sort(), ['n:0', 'x2']);
  assert.equal(await store.countReferences(), 0);
});

test('old correction rows (no type) are not skip rows', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.save({ id: 'old', ts: NOW, pickedId: 'base1-58', count: 1 });
  const [head] = await store.correctionHeads();
  assert.equal(head.pickedId, 'base1-58');
  assert.equal(isSkipRow(head), false);
});

for (const bar of REFERENCE_BARS) {
  test(`negative memory at the ${bar.minHeight}px band: a skipped crop at exactly the boost bar (${bar.boost}) fires, just below does not`, () => {
    const h = bar.minHeight + 5;
    assert.equal(skipHit(query, [skipRef(bar.boost)], { height: h })?.refId, 's:0');
    assert.equal(skipHit(query, [skipRef(bar.boost - 0.001)], { height: h }), null);
    assert.ok(skipHit(query, [skipRef(0.999)], { height: h }));
  });
}

test('negative memory: unknown height uses the 200px band, under 100px never fires, other references are ignored', () => {
  const b200 = referenceBar(200).boost;
  assert.ok(skipHit(query, [skipRef(b200)], { height: 0 }));
  assert.equal(skipHit(query, [skipRef(0.999)], { height: 99 }), null);
  assert.equal(skipHit(query, [skipRef(0.999, { cardId: 'base1-58' })], { height: 240 }), null);
  assert.equal(skipHit(query, [skipRef(0.999, { v: 1 })], { height: 240 }), null);
  assert.equal(skipHit(query, [], { height: 240 }), null);
});

test('applyMemory reports a skip hit and never lets a skip row act as a card reference', () => {
  const meta = [{ id: 'base1-58' }, { id: 'base1-4' }];
  const hits = [{ index: 0, score: 0.5 }, { index: 1, score: 0.4 }];
  const out = applyMemory(query, [skipRef(0.95)], hits, 0.5, meta, { height: 240 });
  assert.equal(out.memory, null);
  assert.equal(out.hits, hits);
  assert.equal(out.skip?.refId, 's:0');
  const without = applyMemory(query, [], hits, 0.5, meta, { height: 240 });
  assert.equal(without.skip, undefined);
});

test('a skip beside a card correction: the correction memory still works and the skip is still reported', () => {
  const meta = [{ id: 'base1-58' }, { id: 'base1-4' }];
  const hits = [{ index: 0, score: 0.5 }, { index: 1, score: 0.4 }];
  const ref = { id: 'c:0', cardId: 'base1-4', ts: NOW, v: V, embedding: at(0.99), n: 1 };
  const out = applyMemory(query, [skipRef(0.9), ref], hits, 0.5, meta, { height: 240 });
  assert.equal(out.memory?.cardId, 'base1-4');
  assert.ok(out.skip);
});

test('skipVerdict demotes a confirmed read to Choose and clears the correction confirm; a read that was already Choose stays', () => {
  const confirmed = { identity: { id: 'a', name: 'A' }, confidence: 0.95, abstain: false, reason: 'confirmed' };
  const v = skipVerdict({ fused: confirmed, confirmedBy: 'correction', negative: false, printingExact: true });
  assert.equal(v.fused.choose, true);
  assert.equal(v.fused.reason, 'choose');
  assert.ok(v.fused.confidence < 0.9);
  assert.equal(v.confirmedBy, null);
  assert.equal(v.printingExact, false);
  const abstained = { identity: null, confidence: 0.2, abstain: true };
  assert.equal(skipVerdict({ fused: abstained, confirmedBy: null, negative: false, printingExact: false }).fused, abstained);
  assert.equal(memoryVerdict(confirmed, null, { hits: [], meta: [] }).fused, confirmed);
});

test('a card read after a skip is never identified until the user confirms it', () => {
  const read = sure({ skippedBefore: true });
  assert.equal(isIdentified(read), false);
  assert.equal(chooseState(read), 'choose');
  assert.equal(isIdentified({ ...read, userConfirmed: true }), true);
  assert.equal(chooseState({ ...read, pricing: true }), 'confirmed');
});

test('privacy: the skip actions in the background never touch shared learning', () => {
  const source = fs.readFileSync(new URL('../tools/extension-wasm/background.js', import.meta.url), 'utf8');
  for (const name of ['saveSkip', 'unskip']) {
    const start = source.indexOf(`  ${name}: async`);
    assert.ok(start > 0, `${name} handler exists`);
    const end = source.indexOf('\n  },', start);
    const body = source.slice(start, end);
    assert.doesNotMatch(body, /_sharing|contribute|holdExamPick|teachRow/, `${name} must not share anything`);
  }
  assert.match(fs.readFileSync(new URL('../docs/store/privacy-policy.md', import.meta.url), 'utf8'), /skip/i);
});

test('the Choose row button and the Skipped group are accessible, collapsed by default, and name no card', async () => {
  const { renderSkipButton, renderSkippedGroup, renderSkippedRow } = await import('../tools/extension-wasm/lib/choose-flow.js');
  const { memoryChipHtml } = await import('../tools/extension-wasm/lib/memory-ui.js');
  const button = renderSkipButton(2, true);
  assert.match(button, /aria-label="Skip this card: I can&#39;t price it \(not English, not a card\)"/);
  assert.match(button, /skip-btn-hot/);
  assert.doesNotMatch(renderSkipButton(2), /skip-btn-hot/);
  const group = renderSkippedGroup(renderSkippedRow(2, 'data:image/jpeg;base64,AA'), 1, false);
  assert.match(group, /Skipped \(1\)/);
  assert.match(group, /aria-expanded="false"/);
  assert.match(group, / hidden>/);
  assert.match(group, /Put back/);
  assert.doesNotMatch(group, /\$|price/i);
  assert.equal(renderSkippedGroup('', 0, false), '');
  assert.match(memoryChipHtml({ skippedBefore: true }, { choose: true }), /You skipped this before/);
  assert.equal(memoryChipHtml({}, { choose: true }), '');
});
