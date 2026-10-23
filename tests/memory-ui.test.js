import { test } from 'node:test';
import assert from 'node:assert/strict';

import { correctedMark, memoryChipHtml, whyHtml } from '../tools/extension-wasm/lib/memory-ui.js';

const why = { w: 1, src: 'picture', cos: 0.812, lead: 0.05, h: 212, title: 'agree', others: ['Pidgey', 'Rattata'] };

test('a row the user just corrected says "Corrected, remembered", with (x2) the second time', () => {
  assert.match(memoryChipHtml({ corrected: { count: 1, remembered: true } }), />Corrected, remembered</);
  assert.match(memoryChipHtml({ corrected: { count: 2, remembered: true } }), />Corrected, remembered \(x2\)</);
  assert.match(memoryChipHtml({ corrected: { count: 1, remembered: false } }), />Corrected</);
  assert.doesNotMatch(memoryChipHtml({ corrected: { count: 1, remembered: false } }), /remembered/);
});

test('a row confirmed by an earlier correction says "From your correction" (x2 when agreed twice)', () => {
  assert.match(memoryChipHtml({ confirmedBy: 'correction', memory: { level: 'confirm', n: 1 } }), />From your correction</);
  assert.match(memoryChipHtml({ confirmedBy: 'correction', memory: { level: 'confirm', n: 2 } }), />From your correction \(x2\)</);
});

test('a Choose row boosted or demoted by memory says "You corrected this before"', () => {
  assert.match(memoryChipHtml({ memory: { level: 'boost', n: 1 } }, { choose: true }), />You corrected this before</);
  assert.match(memoryChipHtml({ memory: { level: 'negative', n: 1 } }, { choose: true }), />You corrected this before</);
  assert.match(memoryChipHtml({ confirmedBy: 'correction', memory: { level: 'confirm', n: 1 } }, { choose: true }), />You corrected this before</);
});

test('no chip without memory, for the community pack, or for a plain confirmed row', () => {
  assert.equal(memoryChipHtml({}), '');
  assert.equal(memoryChipHtml({ memory: { level: 'boost', pack: true } }, { choose: true }), '');
  assert.equal(memoryChipHtml({ memory: { level: 'boost', n: 1 } }), '');
});

test('correctedMark: only when the user changed the scanner answer, or agreed with a reference', () => {
  assert.deepEqual(correctedMark({ id: 'a' }, 'b', { count: 1, remembered: true }), { count: 1, remembered: true });
  assert.equal(correctedMark({ id: 'a' }, 'a', { count: 1, remembered: true }), null);
  assert.deepEqual(correctedMark({ id: 'a' }, 'a', { count: 2, remembered: true, agreed: true }), { count: 2, remembered: true });
  assert.equal(correctedMark({ id: 'a' }, 'b', null), null);
});

test('whyHtml: a closed row has the button and no text, an open one the plain-words text', () => {
  const closed = whyHtml({ why, identity: { name: 'Charizard' } }, 3, false);
  assert.match(closed, /data-why/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /Why this card\?/);
  assert.doesNotMatch(closed, /Matched by picture/);
  const open = whyHtml({ why, identity: { name: 'Charizard' } }, 3, true);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /Matched by picture: 0\.81 similarity, clearly ahead of the next card, 212 px tall/);
  assert.match(open, /id="why-3"/);
});

test('whyHtml escapes names and is empty without a why-record', () => {
  assert.equal(whyHtml({ identity: { name: 'X' } }, 0, true), '');
  const html = whyHtml({ why: { ...why, src: 'correction', ref: { cos: 0.9, n: 1, ts: 0 } }, identity: { name: '<img src=x onerror=1>' } }, 0, true);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
