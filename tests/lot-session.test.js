import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { saveLot, loadLot, clearLot, lotKey, LOT_TTL_MS, LOT_CAP_BYTES } from '../tools/extension-wasm/lib/lot-session.js';

function fakeArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => ({ [key]: data[key] }),
    set: async (obj) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
  };
}
const state = (n = 2, extra = '') => ({ cards: Array.from({ length: n }, (_, i) => ({ i, extra })), srcWidth: 10, srcHeight: 10 });
const URL_A = 'https://shop.example/lot/1';

test('key ignores the hash and is per page', () => {
  assert.equal(lotKey('https://a.example/x#top'), lotKey('https://a.example/x'));
  assert.notEqual(lotKey('https://a.example/x'), lotKey('https://a.example/y'));
  assert.equal(lotKey(''), null);
  assert.equal(lotKey(undefined), null);
});

test('save then load returns the state and its age', async () => {
  const area = fakeArea();
  assert.equal(await saveLot(area, URL_A, state(), 1000), true);
  const got = await loadLot(area, URL_A, 1000 + 5 * 60000);
  assert.equal(got.state.cards.length, 2);
  assert.equal(got.savedAt, 1000);
});

test('a different url never restores another lot', async () => {
  const area = fakeArea();
  await saveLot(area, URL_A, state(), 1000);
  assert.equal(await loadLot(area, 'https://shop.example/lot/2', 1001), null);
});

test('expired after 24 h and the record is dropped', async () => {
  const area = fakeArea();
  await saveLot(area, URL_A, state(), 1000);
  assert.equal(await loadLot(area, URL_A, 1000 + LOT_TTL_MS + 1), null);
  assert.deepEqual(Object.keys((await area.get('lotSessions')).lotSessions.lots), []);
});

test('clear wipes one lot only', async () => {
  const area = fakeArea();
  await saveLot(area, URL_A, state(), 1000);
  await saveLot(area, 'https://b.example/', state(), 1001);
  await clearLot(area, URL_A);
  assert.equal(await loadLot(area, URL_A, 1002), null);
  assert.ok(await loadLot(area, 'https://b.example/', 1002));
});

test('total size cap evicts the oldest lot first', async () => {
  const area = fakeArea();
  const big = state(1, 'x'.repeat(Math.floor(LOT_CAP_BYTES * 0.4)));
  await saveLot(area, 'https://1.example/', big, 1);
  await saveLot(area, 'https://2.example/', big, 2);
  await saveLot(area, 'https://3.example/', big, 3);
  assert.equal(await loadLot(area, 'https://1.example/', 4), null);
  assert.ok(await loadLot(area, 'https://2.example/', 4));
  assert.ok(await loadLot(area, 'https://3.example/', 4));
});

test('a single lot over the cap is not stored and does not throw', async () => {
  const area = fakeArea();
  assert.equal(await saveLot(area, URL_A, state(1, 'x'.repeat(LOT_CAP_BYTES)), 1), false);
  assert.equal(await loadLot(area, URL_A, 2), null);
});

test('corrupt storage degrades to nothing and never throws', async () => {
  for (const bad of ['junk', 7, null, { v: 1 }, { v: 1, lots: 'x' }, { v: 1, lots: { [lotKey(URL_A)]: { savedAt: 1, state: { cards: 'no' } } } }, { v: 99, lots: {} }]) {
    const area = fakeArea({ lotSessions: bad });
    assert.equal(await loadLot(area, URL_A, 5), null);
    assert.equal(await saveLot(area, URL_A, state(), 6), true);
    assert.ok(await loadLot(area, URL_A, 7));
  }
  const throwing = { get: async () => { throw new Error('boom'); }, set: async () => { throw new Error('boom'); } };
  assert.equal(await loadLot(throwing, URL_A, 1), null);
  assert.equal(await saveLot(throwing, URL_A, state(), 1), false);
  await clearLot(throwing, URL_A);
  assert.equal(await loadLot(undefined, URL_A, 1), null);
});

test('privacy: lot session code never touches sharing and the policy says it', () => {
  for (const f of ['lib/lot-session.js', 'popup.js']) {
    const src = fs.readFileSync(new URL(`../tools/extension-wasm/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?:saveLot|clearLot)[^\n]*/g)) assert.doesNotMatch(m[0], /_sharing|contribute|teachRow/);
  }
  const lib = fs.readFileSync(new URL('../tools/extension-wasm/lib/lot-session.js', import.meta.url), 'utf8');
  assert.doesNotMatch(lib, /sharing|contribute|fetch\(|sendMessage/);
  assert.match(fs.readFileSync(new URL('../docs/store/privacy-policy.md', import.meta.url), 'utf8'), /24 hours/);
});
