import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptedRows, cardProbability, checkBundle, fetchBundle, liveParts, loadStoredBundle, mergeExtra, parseAdapter, parseCatalogExtra, parseCheck,
  parsePack, signatureUrl, verifySignature,
} from '../tools/extension-wasm/lib/bundle.js';
import { adaptVector } from '../tools/extension-wasm/lib/adapter.js';
import { referenceHit } from '../tools/extension-wasm/lib/references.js';
import { createShareStore } from '../tools/extension-wasm/lib/share-store.js';
import { sha256Hex } from '../tools/extension-wasm/lib/setup.js';
import { fakeIndexedDB } from './helpers/fake-idb.js';

const MANIFEST_URL = 'https://pack.test/pack/manifest.json';
const BASE = 'https://pack.test/pack/';
const DIM = 512;
const EXPECTED = { model: '77538aade655907f', crop: 2 };
const T0 = Date.parse('2026-10-15T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const enc = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

let keys;
let publicKey;
before(async () => {
  keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  publicKey = b64(await crypto.subtle.exportKey('spki', keys.publicKey));
});

const sign = async (bytes, key = keys.privateKey) => b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes));

// The int8 row of a unit vector that is 1 at `axis`.
const unitRow = (axis) => Int8Array.from({ length: DIM }, (_, i) => (i === axis ? 127 : 0));

function withHeader(header, body) {
  const head = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out;
}

function rowsBody(axes) {
  const body = new Uint8Array(axes.length * DIM);
  axes.forEach((axis, i) => body.set(new Uint8Array(unitRow(axis).buffer), i * DIM));
  return body;
}

const makePack = (cardIds, axes) => withHeader({ v: 1, dim: DIM, entries: cardIds.length, cardIds }, rowsBody(axes));

const CARDS = [
  { id: 'sv9-1', name: 'Pikachu', set: 'sv9', setName: 'Journey Together', number: '1', image: 'https://assets.tcgdex.net/en/sv/sv9/1/high.webp' },
  { id: 'sv9-2', name: 'Raichu', set: 'sv9', setName: 'Journey Together', number: '2', image: 'https://assets.tcgdex.net/en/sv/sv9/2/high.webp' },
];
const makeExtra = (cards = CARDS, axes = [20, 21]) => withHeader({ v: 1, dim: DIM, entries: cards.length, cardIds: cards.map((c) => c.id), cards }, rowsBody(axes));

// Rank 1: U column 0 is e0 and V column 0 is e0 (127 * scale 1/127 = 1).
function makeAdapter({ rank = 1, scale = 1 / 127, u, v } = {}) {
  const U = u ?? new Int8Array(DIM * rank).map((_, i) => (i === 0 ? 127 : 0));
  const V = v ?? new Int8Array(DIM * rank).map((_, i) => (i === 0 ? 127 : 0));
  const body = new Uint8Array(U.length + V.length);
  body.set(new Uint8Array(U.buffer), 0);
  body.set(new Uint8Array(V.buffer), U.length);
  return withHeader({ v: 1, dim: DIM, rank, scale }, body);
}

function makeCheck({ weights, bias = -1, threshold = 0.5 } = {}) {
  const w = weights ?? Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 2 : 0));
  return withHeader({ v: 1, dim: DIM, bias, threshold }, new Uint8Array(w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength)));
}

const FILES = () => ({
  memory: makePack(['base1-4', 'base1-5'], [3, 9]),
  adapter: makeAdapter(),
  check: makeCheck(),
  catalogExtra: makeExtra(),
});

// `files` maps asset name -> bytes. Each asset is published at <name>-1.bin.
async function world({ improved = true, manifestOver = {}, files = FILES(), signWith, sigOver, assetOver = {} } = {}) {
  const assets = {};
  const served = new Map();
  for (const [name, bytes] of Object.entries(files)) {
    const file = `${name}-1.bin`;
    assets[name] = { url: file, sha256: await sha256Hex(bytes), bytes: bytes.length, ...(assetOver[name] ?? {}) };
    served.set(new URL(file, MANIFEST_URL).href, bytes);
  }
  const manifest = {
    v: 2, ...EXPECTED, assets, exam: { before: 0.71, after: 0.74, n: 400 }, regression: { before: 0.8, after: 0.8, n: 50 },
    improved, seq: 5, issuedAt: '2026-10-15T03:17:00Z', ...manifestOver,
  };
  const manifestBytes = enc.encode(JSON.stringify(manifest));
  const published = new Map([
    [MANIFEST_URL, manifestBytes],
    [`${BASE}manifest.sig`, enc.encode(sigOver ?? await sign(manifestBytes, signWith))],
    ...served,
  ]);
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(url);
    const body = published.get(url);
    return body
      ? { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), text: async () => new TextDecoder().decode(body) }
      : { ok: false, status: 404 };
  };
  return { manifest, fetchFn, requested, published };
}

const options = (w, over = {}) => ({ manifestUrl: MANIFEST_URL, publicKey, expected: EXPECTED, fetchFn: w.fetchFn, now: () => T0, ...over });
const assetRequests = (w) => w.requested.filter((u) => u.endsWith('.bin'));

test('the signature lives next to the manifest', () => {
  assert.equal(signatureUrl('https://pack.test/pack/manifest.json'), 'https://pack.test/pack/manifest.sig');
});

test('a valid signature verifies; changed bytes, another key, garbage and a bad key do not', async () => {
  const data = enc.encode('{"a":1}');
  const sig = await sign(data);
  assert.equal(await verifySignature(data, sig, publicKey), true);
  assert.equal(await verifySignature(enc.encode('{"a":2}'), sig, publicKey), false);
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  assert.equal(await verifySignature(data, await sign(data, other.privateKey), publicKey), false);
  assert.equal(await verifySignature(data, '!!!', publicKey), false);
  assert.equal(await verifySignature(data, sig, 'AAAA'), false);
});

test('a signed, matching, improved bundle is downloaded and checked, every asset', async () => {
  const w = await world();
  const result = await fetchBundle(options(w));
  assert.equal(result.status, 'ok');
  assert.equal(result.manifest.improved, true);
  assert.deepEqual(Object.keys(result.assets).sort(), ['adapter', 'catalogExtra', 'check', 'memory']);
  assert.deepEqual(w.requested.slice(0, 2), [MANIFEST_URL, `${BASE}manifest.sig`]);
  assert.equal(assetRequests(w).length, 4);
});

test('an asset whose sha256 is already stored is not downloaded again', async () => {
  const w = await world();
  const known = new Set([w.manifest.assets.memory.sha256, w.manifest.assets.check.sha256]);
  const result = await fetchBundle(options(w, { has: async (sha) => known.has(sha) }));
  assert.equal(result.status, 'ok');
  assert.equal(result.assets.memory, null);
  assert.equal(result.assets.check, null);
  assert.ok(result.assets.adapter instanceof Uint8Array);
  assert.deepEqual(assetRequests(w).map((u) => u.split('/').pop()).sort(), ['adapter-1.bin', 'catalogExtra-1.bin']);
});

test('downloads follow redirects and are checked by sha256, not by the address they end up at', async () => {
  const w = await world();
  const inits = [];
  const fetchFn = async (url, init) => {
    inits.push(init);
    const res = await w.fetchFn(url);
    return res.ok ? { ...res, url: 'https://objects.githubusercontent.com/some/signed/path', redirected: true } : res;
  };
  const result = await fetchBundle(options(w, { fetchFn }));
  assert.equal(result.status, 'ok');
  assert.equal(inits.length, 6);
  for (const init of inits) assert.equal(init.redirect, 'follow');
});

test('inert without a manifest address or a key: nothing is fetched', async () => {
  const w = await world();
  assert.equal((await fetchBundle(options(w, { manifestUrl: '' }))).status, 'inert');
  assert.equal((await fetchBundle(options(w, { publicKey: '' }))).status, 'inert');
  assert.deepEqual(w.requested, []);
});

test('a manifest signed with another key is refused and no asset is fetched', async () => {
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const w = await world({ signWith: other.privateKey });
  assert.equal((await fetchBundle(options(w))).status, 'signature');
  assert.equal(assetRequests(w).length, 0);
});

test('a manifest changed after signing is refused', async () => {
  const w = await world();
  w.published.set(MANIFEST_URL, enc.encode(JSON.stringify({ ...w.manifest, improved: true, seq: 99999 })));
  assert.equal((await fetchBundle(options(w))).status, 'signature');
});

test('a bundle for another model or crop version is not used', async () => {
  for (const over of [{ model: 'ffffffffffffffff' }, { crop: 3 }]) {
    const w = await world({ manifestOver: over });
    assert.equal((await fetchBundle(options(w))).status, 'mismatch', JSON.stringify(over));
    assert.equal(assetRequests(w).length, 0);
  }
});

test('the catalog does not matter: a bundle is keyed to model and crop only', async () => {
  const w = await world({ manifestOver: { catalog: '0000000000000000' } });
  assert.equal((await fetchBundle(options(w))).status, 'ok');
});

test('a v1 manifest is not a bundle', async () => {
  const w = await world({ manifestOver: { v: 1 } });
  assert.equal((await fetchBundle(options(w))).status, 'format');
});

test('improved: false (or anything but true) is not used', async () => {
  for (const improved of [false, 'true', 1, null]) {
    const w = await world({ improved });
    assert.equal((await fetchBundle(options(w))).status, 'not-improved', String(improved));
    assert.equal(assetRequests(w).length, 0);
  }
});

test('an asset whose bytes do not match the signed sha256 is refused', async () => {
  const w = await world();
  w.published.set(`${BASE}adapter-1.bin`, makeAdapter({ scale: 2 / 127 }));
  assert.equal((await fetchBundle(options(w))).status, 'sha');
});

test('an asset on another host than the manifest, or over http, is refused', async () => {
  for (const url of ['https://evil.test/a.bin', 'http://pack.test/pack/a.bin']) {
    const w = await world({ assetOver: { check: { url } } });
    assert.equal((await fetchBundle(options(w))).status, 'format', url);
  }
});

test('an asset that is not the size the manifest says, or is damaged, is refused', async () => {
  const lying = await world({ assetOver: { memory: { bytes: 10 } } });
  assert.equal((await fetchBundle(options(lying))).status, 'format');
  const good = makePack(['base1-4', 'base1-5'], [3, 9]);
  const damaged = await world({ files: { memory: good.slice(0, good.length - 7) } });
  assert.equal((await fetchBundle(options(damaged))).status, 'format');
  const missing = await world();
  missing.published.delete(`${BASE}memory-1.bin`);
  assert.equal((await fetchBundle(options(missing))).status, 'network');
});

test('a manifest with unknown assets, no assets, or a bad asset entry is refused', async () => {
  const hex = 'a'.repeat(64);
  for (const assets of [{}, { evil: { url: 'x.bin', sha256: hex, bytes: 1 } }, { memory: { url: 'x.bin', sha256: 'zz', bytes: 1 } }, { memory: { url: 'x.bin', sha256: hex, bytes: 0 } }, 'nope']) {
    const w = await world({ manifestOver: { assets } });
    assert.equal((await fetchBundle(options(w))).status, 'format', JSON.stringify(assets));
  }
});

test('a network failure is reported, not thrown', async () => {
  const result = await fetchBundle({ manifestUrl: MANIFEST_URL, publicKey, expected: EXPECTED, fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'network');
});

test('each asset is optional on its own', async () => {
  const w = await world({ files: { adapter: makeAdapter() } });
  const result = await fetchBundle(options(w));
  assert.equal(result.status, 'ok');
  assert.deepEqual(Object.keys(result.assets), ['adapter']);
});

test('parsePack reads rows as int8 views and enforces the layout', () => {
  const rows = parsePack(makePack(['a', 'b'], [1, 2]), { ...EXPECTED, entries: 2, dim: DIM });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].cardId, 'b');
  assert.equal(rows[1].embedding.length, DIM);
  assert.equal(rows[1].embedding[2], 127);
  assert.equal(rows[1].v, 2);
  assert.equal(parsePack(makePack(['a'], [1]), { crop: 2 }).length, 1);
  assert.throws(() => parsePack(makePack(['a'], [1]), { ...EXPECTED, entries: 2, dim: DIM }), /entries/);
  assert.throws(() => parsePack(new Uint8Array(3), EXPECTED), /short/);
  const longHeader = new Uint8Array(8);
  new DataView(longHeader.buffer).setUint32(0, 5000, true);
  assert.throws(() => parsePack(longHeader, EXPECTED), /header/);
});

test('pack rows work with referenceHit and the same thresholds as the user\'s own references', () => {
  const rows = parsePack(makePack(['base1-4', 'base1-5'], [3, 9]), EXPECTED);
  const query = new Float32Array(DIM);
  query[3] = 1;
  const hit = referenceHit(query, rows, 0.5);
  assert.equal(hit.cardId, 'base1-4');
  assert.ok(Math.abs(hit.score - 1) < 1e-9);
  const far = new Float32Array(DIM);
  far[100] = 1;
  assert.equal(referenceHit(far, rows, 0.5), null);
  assert.equal(referenceHit(query, rows, 0.99), null);
});

test('parseAdapter reads rank, scale and both int8 matrices; bad layouts throw', () => {
  const adapter = parseAdapter(makeAdapter({ rank: 2, scale: 0.5 / 127 }));
  assert.equal(adapter.rank, 2);
  assert.equal(adapter.u.length, DIM * 2);
  assert.equal(adapter.v.length, DIM * 2);
  assert.ok(Math.abs(adapter.u[0] - 0.5) < 1e-6);
  const bad = (header, body = new Uint8Array(0)) => withHeader({ v: 1, dim: DIM, rank: 1, scale: 0.01, ...header }, body);
  assert.throws(() => parseAdapter(bad({ rank: 65 }, new Uint8Array(65 * DIM * 2))), /rank/);
  assert.throws(() => parseAdapter(bad({ rank: 0 })), /rank/);
  assert.throws(() => parseAdapter(bad({ scale: -1 }, new Uint8Array(DIM * 2))), /scale/);
  assert.throws(() => parseAdapter(bad({}, new Uint8Array(DIM * 2 - 1))), /size/);
  assert.throws(() => parseAdapter(bad({ dim: 256 }, new Uint8Array(512))), /build/);
});

test('adaptVector applies normalize(e + U(Vt e)) and keeps unit length', () => {
  const adapter = parseAdapter(makeAdapter());
  const e = new Float32Array(DIM);
  e[0] = 1;
  e[1] = 1;
  const out = adaptVector(e, adapter);
  const norm = Math.hypot(2, 1);
  assert.ok(Math.abs(out[0] - 2 / norm) < 1e-6);
  assert.ok(Math.abs(out[1] - 1 / norm) < 1e-6);
  assert.ok(Math.abs(Math.hypot(...out) - 1) < 1e-5);
});

test('parseCheck reads weights, bias and threshold; cardProbability is sigmoid(w.e + b) on the given embedding', () => {
  const check = parseCheck(makeCheck());
  assert.equal(check.weights.length, DIM);
  assert.equal(check.threshold, 0.5);
  const e = new Float32Array(DIM);
  e[0] = 1;
  assert.ok(Math.abs(cardProbability(e, check) - 1 / (1 + Math.exp(-1))) < 1e-6);
  const other = new Float32Array(DIM);
  other[5] = 1;
  assert.ok(cardProbability(other, check) < 0.5);
  assert.throws(() => parseCheck(makeCheck({ threshold: 1.5 })), /threshold/);
  assert.throws(() => parseCheck(makeCheck({ bias: null })), /bias/);
  assert.throws(() => parseCheck(makeCheck().slice(0, 100)), /size|header/);
  const nan = Float32Array.from({ length: DIM }, () => NaN);
  assert.throws(() => parseCheck(makeCheck({ weights: nan })), /finite/);
});

test('parseCatalogExtra gives unit float rows and meta in the catalog\'s own shape', () => {
  const extra = parseCatalogExtra(makeExtra());
  assert.equal(extra.rows.length, 2 * DIM);
  assert.ok(Math.abs(extra.rows[20] - 1) < 1e-6);
  assert.ok(Math.abs(extra.rows[DIM + 21] - 1) < 1e-6);
  assert.deepEqual(extra.meta[0], { id: 'sv9-1', name: 'Pikachu', set: 'Journey Together', setCode: 'sv9', number: '1', game: 'pokemon', imageUrl: CARDS[0].image });
  const one = (cards) => withHeader({ v: 1, dim: DIM, entries: 1, cardIds: ['sv9-1'], ...(cards ? { cards } : {}) }, rowsBody([1]));
  assert.throws(() => parseCatalogExtra(one([{ ...CARDS[0], id: 'y' }])), /cards/);
  assert.throws(() => parseCatalogExtra(one([{ id: 'sv9-1', name: 3 }])), /cards/);
  assert.throws(() => parseCatalogExtra(one(null)), /cards/);
});

test('mergeExtra drops extra cards the base catalog already has, keeping rows and meta aligned', () => {
  const extra = parseCatalogExtra(makeExtra());
  const merged = mergeExtra([{ id: 'sv9-1' }, { id: 'base1-1' }], extra);
  assert.deepEqual(merged.meta.map((m) => m.id), ['sv9-2']);
  assert.equal(merged.rows.length, DIM);
  assert.ok(Math.abs(merged.rows[21] - 1) < 1e-6);
  assert.equal(mergeExtra([{ id: 'sv9-1' }, { id: 'sv9-2' }], extra), null);
});

function state() {
  let value = null;
  return { get: async () => value, set: async (v) => { value = v; } };
}

test('checkBundle stores a good bundle, checks once a day, and loadStoredBundle returns every part', async () => {
  const w = await world();
  const store = createShareStore(fakeIndexedDB());
  const checks = state();
  let clock = T0;
  const args = () => ({ ...options(w), store, state: checks, now: () => clock });
  assert.equal((await checkBundle(args())).status, 'ok');
  assert.equal(w.requested.length, 6);
  clock += 3600 * 1000;
  assert.equal((await checkBundle(args())).status, 'skipped');
  assert.equal(w.requested.length, 6);
  const bundle = await loadStoredBundle(store, EXPECTED);
  assert.deepEqual(bundle.memory.map((r) => r.cardId), ['base1-4', 'base1-5']);
  assert.equal(bundle.adapter.rank, 1);
  assert.equal(bundle.check.threshold, 0.5);
  assert.equal(bundle.extra.meta.length, 2);
  clock += DAY;
  assert.equal((await checkBundle(args())).status, 'ok');
});

test('the next day only the assets whose sha changed are downloaded', async () => {
  const store = createShareStore(fakeIndexedDB());
  const checks = state();
  let clock = T0;
  const run = (w) => checkBundle({ ...options(w), store, state: checks, now: () => clock });
  assert.equal((await run(await world())).status, 'ok');
  clock += DAY;
  const next = await world({ files: { ...FILES(), adapter: makeAdapter({ scale: 2 / 127 }) }, manifestOver: { seq: 6 } });
  assert.equal((await run(next)).status, 'ok');
  assert.deepEqual(assetRequests(next).map((u) => u.split('/').pop()), ['adapter-1.bin']);
  const bundle = await loadStoredBundle(store, EXPECTED);
  assert.ok(Math.abs(bundle.adapter.u[0] - 2) < 1e-6);
  assert.equal(bundle.memory.length, 2);
});

test('any failure leaves the previous live bundle in place and the seq floor where it was', async () => {
  const store = createShareStore(fakeIndexedDB());
  const checks = state();
  let clock = T0;
  const run = (w) => checkBundle({ ...options(w), store, state: checks, now: () => clock });
  await run(await world());
  const before = await store.getPack();
  clock += DAY;
  const broken = await world({ files: { ...FILES(), adapter: makeAdapter({ scale: 3 / 127 }) }, manifestOver: { seq: 9 } });
  broken.published.set(`${BASE}adapter-1.bin`, makeAdapter({ scale: 4 / 127 }));
  assert.equal((await run(broken)).status, 'sha');
  assert.deepEqual(await store.getPack(), before);
  assert.equal((await checks.get()).seq, 5);
  assert.ok((await loadStoredBundle(store, EXPECTED)).adapter);
  clock += DAY;
  assert.equal((await run(await world({ sigOver: 'AAAA' }))).status, 'signature');
  assert.equal((await loadStoredBundle(store, EXPECTED)).memory.length, 2);
});

test('a candidate that is not improved leaves the live bundle alone', async () => {
  const store = createShareStore(fakeIndexedDB());
  let clock = T0;
  const run = (w) => checkBundle({ ...options(w), store, state: state(), now: () => clock });
  await run(await world());
  clock += DAY;
  assert.equal((await run(await world({ improved: false, manifestOver: { seq: 6 } }))).status, 'not-improved');
  assert.equal((await loadStoredBundle(store, EXPECTED)).memory.length, 2);
});

test('a bundle that drops an asset removes it from the live bundle', async () => {
  const store = createShareStore(fakeIndexedDB());
  let clock = T0;
  const run = (w) => checkBundle({ ...options(w), store, state: state(), now: () => clock });
  await run(await world());
  clock += DAY;
  const rest = FILES();
  delete rest.adapter;
  await run(await world({ files: rest, manifestOver: { seq: 6 } }));
  const bundle = await loadStoredBundle(store, EXPECTED);
  assert.equal(bundle.adapter, null);
  assert.equal(bundle.memory.length, 2);
});

test('a stored bundle for another build is not used and is cleared', async () => {
  const store = createShareStore(fakeIndexedDB());
  await checkBundle({ ...options(await world()), store, state: state(), now: () => T0 });
  assert.equal(await loadStoredBundle(store, { ...EXPECTED, crop: 3 }), null);
  assert.equal(await loadStoredBundle(store, EXPECTED), null);
});

test('a stored asset that no longer parses is skipped, the others still load', async () => {
  const store = createShareStore(fakeIndexedDB());
  const w = await world();
  await checkBundle({ ...options(w), store, state: state(), now: () => T0 });
  await store.putAsset(w.manifest.assets.check.sha256, new Uint8Array([1, 2, 3]).buffer);
  const bundle = await loadStoredBundle(store, EXPECTED);
  assert.equal(bundle.check, null);
  assert.equal(bundle.memory.length, 2);
});

test('a manifest needs seq and issuedAt', async () => {
  for (const over of [{ seq: undefined }, { seq: -1 }, { seq: 1.5 }, { issuedAt: undefined }, { issuedAt: 'yesterday' }]) {
    const result = await fetchBundle(options(await world({ manifestOver: over })));
    assert.equal(result.status, 'format', JSON.stringify(over));
  }
});

test('a manifest older than 30 days, or issued in the future, is stale and no asset is fetched', async () => {
  const old = await world({ manifestOver: { issuedAt: new Date(T0 - 31 * DAY).toISOString().replace('.000', '') } });
  assert.equal((await fetchBundle(options(old))).status, 'stale');
  assert.equal(old.requested.length, 2);
  const fresh = await world({ manifestOver: { issuedAt: new Date(T0 - 29 * DAY).toISOString().replace('.000', '') } });
  assert.equal((await fetchBundle(options(fresh))).status, 'ok');
  const future = await world({ manifestOver: { issuedAt: new Date(T0 + 2 * DAY).toISOString().replace('.000', '') } });
  assert.equal((await fetchBundle(options(future))).status, 'stale');
});

test('a lower seq than the highest seen is a replay: refused, and the stored bundle is kept', async () => {
  const store = createShareStore(fakeIndexedDB());
  const checks = state();
  let clock = T0;
  const run = (w) => checkBundle({ ...options(w), store, state: checks, now: () => clock });
  assert.equal((await run(await world({ manifestOver: { seq: 8 } }))).status, 'ok');
  assert.equal((await checks.get()).seq, 8);
  clock += 2 * DAY;
  assert.equal((await run(await world({ manifestOver: { seq: 7 } }))).status, 'stale');
  assert.equal((await loadStoredBundle(store, EXPECTED)).memory.length, 2);
  clock += 2 * DAY;
  assert.equal((await run(await world({ manifestOver: { seq: 8 } }))).status, 'ok');
  clock += 2 * DAY;
  assert.equal((await run(await world({ manifestOver: { seq: 9 } }))).status, 'ok');
  assert.equal((await checks.get()).seq, 9);
});

function streamingFetch(chunks) {
  const seen = { read: 0, cancelled: false };
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => (seen.read < chunks.length ? { done: false, value: chunks[seen.read++] } : { done: true }),
        cancel: async () => { seen.cancelled = true; },
      }),
    },
  });
  return { fetchFn, seen };
}

test('an asset download stops as soon as it passes the size the manifest declared', async () => {
  const w = await world({ files: { memory: makePack(['a'], [1]) }, assetOver: { memory: { bytes: 1000 } } });
  const huge = streamingFetch(Array.from({ length: 50 }, () => new Uint8Array(100)));
  const fetchFn = async (url, init) => (url.endsWith('memory-1.bin') ? huge.fetchFn() : w.fetchFn(url, init));
  const result = await fetchBundle(options(w, { fetchFn }));
  assert.equal(result.status, 'format');
  assert.match(result.detail, /too large/);
  assert.equal(huge.seen.cancelled, true);
  assert.ok(huge.seen.read <= 11, `read ${huge.seen.read} chunks`);
});

test('a declared size over the per-asset cap is refused before any download', async () => {
  const w = await world({ files: { check: makeCheck() }, assetOver: { check: { bytes: 10 * 1024 * 1024 } } });
  const result = await fetchBundle(options(w));
  assert.equal(result.status, 'format');
  assert.equal(assetRequests(w).length, 0);
});

test('adaptedRows computes once per key and then serves the stored copy', async () => {
  const store = createShareStore(fakeIndexedDB());
  const adapter = parseAdapter(makeAdapter());
  const rows = new Float32Array(2 * DIM);
  rows[0] = 1;
  rows[1] = 1;
  rows[DIM + 5] = 1;
  const first = await adaptedRows({ store, key: 'k1', rows, adapter });
  assert.equal(first.length, rows.length);
  assert.ok(Math.abs(first[0] - 2 / Math.hypot(2, 1)) < 1e-6);
  assert.ok(Math.abs(first[DIM + 5] - 1) < 1e-6);
  const again = await adaptedRows({ store, key: 'k1', rows: new Float32Array(2 * DIM), adapter });
  assert.deepEqual(Array.from(again.subarray(0, 4)), Array.from(first.subarray(0, 4)));
  const other = await adaptedRows({ store, key: 'k2', rows: new Float32Array(2 * DIM), adapter });
  assert.equal(other[0], 0);
});

test('liveParts names only the parts that carry something, so an empty memory is not "live"', () => {
  assert.equal(liveParts(null), 'none');
  assert.equal(liveParts({ memory: [], check: null }, { adapter: null, extra: null }), 'nothing usable');
  assert.equal(liveParts({ memory: [{}], check: {} }, { adapter: {}, extra: { meta: [] } }), 'memory, adapter, check, new cards');
  assert.equal(liveParts({ memory: [], check: null }, { adapter: {}, extra: null }), 'adapter');
});
