import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WHY_SOURCES, leadOf, sanitizeWhy, userWhy, whyOf, withVerdicts } from '../tools/extension-wasm/lib/why.js';
import { whyText } from '../tools/extension-wasm/lib/why-text.js';
import { confirmRowFor } from '../tools/extension-wasm/lib/fusion.js';

const meta = [
  { id: 'sv3-125', name: 'Charizard ex' },
  { id: 'sv3-126', name: 'Charizard ex' },
  { id: 'base1-4', name: 'Charizard' },
  { id: 'swsh1-1', name: 'Celebi' },
  { id: 'sv1-9', name: 'Pidgey' },
  { id: 'sv1-10', name: 'Rattata' },
];
const hits = [0.742, 0.741, 0.701, 0.66, 0.655, 0.6].map((score, index) => ({ index, score }));
const ranked = hits.map((h) => ({ id: meta[h.index].id, rank: h.score, score: h.score }));
const tags = { clip: 'abcd', crop: 3, catalog: 'ef01' };

test('confirmRowFor gives the CONFIRM row for a height', () => {
  assert.deepEqual(confirmRowFor(238), { minHeight: 200, minSim: 0.68, minGap: 0.03 });
  assert.equal(confirmRowFor(120), null);
  assert.equal(confirmRowFor(0).minHeight, 200);
});

test('leadOf measures the lead over the best card with another name', () => {
  const out = leadOf(hits, meta);
  assert.equal(out.cos, 0.742);
  assert.ok(Math.abs(out.lead - 0.041) < 1e-9);
  assert.equal(out.rival, 'base1-4');
  assert.equal(out.rivalName, 'Charizard');
});

test('whyOf builds the picture record', () => {
  const why = whyOf({ src: 'picture', hits, ranked, meta, height: 238, tags });
  assert.equal(why.w, 1);
  assert.equal(why.src, 'picture');
  assert.equal(why.cos, 0.742);
  assert.equal(why.lead, 0.041);
  assert.equal(why.h, 238);
  assert.deepEqual(why.row, { h: 200, T: 0.68, G: 0.03 });
  assert.equal(why.top5.length, 5);
  assert.deepEqual(why.top5[0], ['sv3-125', 0.742]);
  assert.deepEqual(why.others, ['Charizard', 'Celebi']);
  assert.equal(why.rivalName, 'Charizard');
  assert.deepEqual([why.model, why.crop, why.cat], ['abcd', 3, 'ef01']);
});

test('whyOf for a correction records the reference and the band, not a picture row', () => {
  const why = whyOf({ src: 'correction', hits, ranked, meta, height: 238, tags, ref: { id: 's:1', cos: 0.8712, n: 2, ts: 1700000000000, bar: 0.86 } });
  assert.equal(why.src, 'correction');
  assert.equal(why.row, null);
  assert.deepEqual(why.ref, { id: 's:1', cos: 0.871, n: 2, ts: 1700000000000, bar: 0.86 });
});

test('whyOf stays small', () => {
  const why = whyOf({ src: 'picture', hits, ranked, meta, height: 238, tags });
  assert.ok(JSON.stringify(why).length < 600, String(JSON.stringify(why).length));
});

test('every source in the schema is accepted and others are not', () => {
  assert.deepEqual(WHY_SOURCES, ['picture', 'number', 'setHint', 'stamp', 'promoted', 'correction', 'user']);
  for (const src of WHY_SOURCES) assert.equal(sanitizeWhy({ w: 1, src }).src, src);
  assert.equal(sanitizeWhy({ w: 1, src: 'hacker' }), null);
  assert.equal(sanitizeWhy(null), null);
  assert.equal(sanitizeWhy('x'), null);
});

test('sanitizeWhy drops unknown keys, bounds strings and arrays, and keeps the schema', () => {
  const why = whyOf({ src: 'picture', hits, ranked, meta, height: 238, tags });
  const dirty = { ...why, evil: 'x', cat: 'y'.repeat(500), top5: Array.from({ length: 20 }, (_, i) => [`id${i}`, 0.5]), price: 12.4, title: 'agree', tier: 'medium' };
  const clean = sanitizeWhy(dirty);
  assert.equal(clean.evil, undefined);
  assert.ok(clean.cat.length <= 40);
  assert.equal(clean.top5.length, 5);
  assert.equal(clean.price, 12.4);
  assert.equal(clean.title, 'agree');
  assert.equal(sanitizeWhy({ w: 1, src: 'picture', title: 'weird' }).title, undefined);
  assert.ok(JSON.stringify(clean).length < 700);
});

test('withVerdicts adds the title verdict and the stripe and a number read changes the source', () => {
  const base = whyOf({ src: 'picture', hits, ranked, meta, height: 238, tags });
  assert.equal(withVerdicts(base, { confidence: 0.7, titleConfirmed: true }).title, 'agree');
  assert.equal(withVerdicts(base, { confidence: 0.7, titleContradicts: 'Celebi' }).title, 'contradict');
  assert.equal(withVerdicts(base, { confidence: 0.7 }).title, 'silent');
  assert.equal(withVerdicts(base, { confidence: 0.7 }).tier, 'medium');
  assert.equal(withVerdicts(base, { confidence: 0.9, numberRead: '4/102' }).src, 'number');
  assert.equal(withVerdicts({ ...base, src: 'correction' }, { confidence: 0.79, numberRead: '4/102' }).src, 'number');
  assert.equal(withVerdicts(base, { confidence: 0.7, setEvidence: 'code' }).src, 'setHint');
  assert.equal(withVerdicts(null, {}), null);
});

test('userWhy turns a record into the "you chose this" record and keeps what the picture said', () => {
  const base = whyOf({ src: 'picture', hits, ranked, meta, height: 238, tags });
  const out = userWhy(base);
  assert.equal(out.src, 'user');
  assert.equal(out.cos, base.cos);
  assert.equal(userWhy(undefined), undefined);
});

test('whyText: picture', () => {
  const why = { ...whyOf({ src: 'picture', hits, ranked, meta, height: 212, tags }), title: 'agree' };
  const text = whyText(why, { name: 'Charizard ex' });
  assert.match(text, /Matched by picture: 0\.74 similarity/);
  assert.match(text, /212 px tall/);
  assert.match(text, /title line agrees/i);
  assert.match(text, /Closest others: Charizard, Celebi/);
});

test('whyText: a small lead is called close, not clear', () => {
  const close = whyOf({ src: 'picture', hits: hits.map((h, i) => (i === 2 ? { ...h, score: 0.74 } : h)), ranked, meta, height: 212, tags });
  assert.match(whyText(close, {}), /close to the next card/);
  assert.match(whyText(whyOf({ src: 'picture', hits, ranked, meta, height: 212, tags }), {}), /clearly ahead of the next card/);
});

test('whyText: correction, number, setHint, stamp, promoted, user', () => {
  const base = whyOf({ src: 'correction', hits, ranked, meta, height: 212, tags, ref: { id: 'a', cos: 0.87, n: 1, ts: Date.UTC(2026, 9, 20), bar: 0.86 } });
  const correction = whyText(base, { name: 'Charizard ex' });
  assert.match(correction, /From your earlier correction/);
  assert.match(correction, /2026-10-20/);
  assert.match(correction, /Charizard ex/);
  assert.match(correction, /0\.87/);
  assert.match(whyText({ ...base, src: 'number' }, {}), /printed number/);
  assert.match(whyText({ ...base, src: 'setHint' }, {}), /set/i);
  assert.match(whyText({ ...base, src: 'stamp' }, {}), /1st Edition/);
  assert.match(whyText({ ...base, src: 'promoted', price: 3.5 }, {}), /\$3\.50/);
  assert.match(whyText({ ...base, src: 'user' }, { name: 'Charizard ex' }), /You chose this/);
});

test('whyText is plain text without markup from the names it was given', () => {
  const why = whyOf({ src: 'picture', hits, ranked, meta, height: 212, tags });
  assert.equal(whyText(null, {}), '');
  assert.equal(typeof whyText(why, { name: '<b>x</b>' }), 'string');
});
