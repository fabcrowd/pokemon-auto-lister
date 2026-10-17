import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { checkCommunityPack, fetchCommunityPack, loadStoredPack, parsePack, signatureUrl, verifySignature } from '../tools/extension-wasm/lib/community-pack.js';
import { referenceHit } from '../tools/extension-wasm/lib/references.js';
import { createShareStore } from '../tools/extension-wasm/lib/share-store.js';
import { sha256Hex } from '../tools/extension-wasm/lib/setup.js';
import { fakeIndexedDB } from './helpers/fake-idb.js';

const MANIFEST_URL = 'https://pack.test/pack/manifest.json';
const DIM = 512;
const EXPECTED = { model: '77538aade655907f', catalog: '2f3c50cec84937ff', crop: 2 };
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

function makePack(cardIds, axes) {
  const header = enc.encode(JSON.stringify({ v: 1, dim: DIM, entries: cardIds.length, cardIds }));
  const out = new Uint8Array(4 + header.length + cardIds.length * DIM);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  axes.forEach((axis, i) => out.set(new Uint8Array(unitRow(axis).buffer), 4 + header.length + i * DIM));
  return out;
}

async function world({ improved = true, manifestOver = {}, packBytes, signWith, sigOver } = {}) {
  const pack = packBytes ?? makePack(['base1-4', 'base1-5'], [3, 9]);
  const manifest = {
    v: 1, ...EXPECTED, entries: 2, dim: DIM, sha256: await sha256Hex(pack), url: 'pack-1.bin',
    exam: { before: 0.71, after: 0.74, n: 400 }, improved, seq: 5, issuedAt: '2026-10-15T03:17:00Z', ...manifestOver,
  };
  const manifestBytes = enc.encode(JSON.stringify(manifest));
  const files = new Map([
    [MANIFEST_URL, manifestBytes],
    ['https://pack.test/pack/manifest.sig', enc.encode(sigOver ?? await sign(manifestBytes, signWith))],
    ['https://pack.test/pack/pack-1.bin', pack],
  ]);
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(url);
    const body = files.get(url);
    return body
      ? { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), text: async () => new TextDecoder().decode(body) }
      : { ok: false, status: 404 };
  };
  return { manifest, fetchFn, requested, files };
}

const options = (w, over = {}) => ({ manifestUrl: MANIFEST_URL, publicKey, expected: EXPECTED, fetchFn: w.fetchFn, now: () => T0, ...over });

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

test('a signed, matching, improved pack is downloaded and checked', async () => {
  const w = await world();
  const result = await fetchCommunityPack(options(w));
  assert.equal(result.status, 'ok');
  assert.equal(result.manifest.improved, true);
  assert.deepEqual(w.requested, [MANIFEST_URL, 'https://pack.test/pack/manifest.sig', 'https://pack.test/pack/pack-1.bin']);
});

test('downloads follow redirects and are checked by sha256, not by the address they end up at', async () => {
  const w = await world();
  const inits = [];
  const fetchFn = async (url, init) => {
    inits.push(init);
    const res = await w.fetchFn(url);
    return res.ok ? { ...res, url: 'https://objects.githubusercontent.com/some/signed/path', redirected: true } : res;
  };
  const result = await fetchCommunityPack(options(w, { fetchFn }));
  assert.equal(result.status, 'ok');
  assert.equal(inits.length, 3);
  for (const init of inits) assert.equal(init.redirect, 'follow');
});

test('inert without a manifest address or a key: nothing is fetched', async () => {
  const w = await world();
  assert.equal((await fetchCommunityPack(options(w, { manifestUrl: '' }))).status, 'inert');
  assert.equal((await fetchCommunityPack(options(w, { publicKey: '' }))).status, 'inert');
  assert.deepEqual(w.requested, []);
});

test('a manifest signed with another key is refused and the pack is never fetched', async () => {
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const w = await world({ signWith: other.privateKey });
  assert.equal((await fetchCommunityPack(options(w))).status, 'signature');
  assert.equal(w.requested.some((u) => u.endsWith('.bin')), false);
});

test('a manifest changed after signing is refused', async () => {
  const w = await world();
  const forged = enc.encode(JSON.stringify({ ...w.manifest, improved: true, entries: 99999 }));
  w.files.set(MANIFEST_URL, forged);
  assert.equal((await fetchCommunityPack(options(w))).status, 'signature');
});

test('a pack for another model, catalog or crop version is not used', async () => {
  for (const over of [{ model: 'ffffffffffffffff' }, { catalog: '0000000000000000' }, { crop: 3 }]) {
    const w = await world({ manifestOver: over });
    assert.equal((await fetchCommunityPack(options(w))).status, 'mismatch', JSON.stringify(over));
    assert.equal(w.requested.some((u) => u.endsWith('.bin')), false);
  }
});

test('improved: false (or anything but true) is not used', async () => {
  for (const improved of [false, 'true', 1, null]) {
    const w = await world({ improved });
    assert.equal((await fetchCommunityPack(options(w))).status, 'not-improved', String(improved));
    assert.equal(w.requested.some((u) => u.endsWith('.bin')), false);
  }
});

test('a pack whose bytes do not match the signed sha256 is refused', async () => {
  const w = await world();
  const tampered = makePack(['base1-4', 'base1-5'], [3, 10]);
  w.files.set('https://pack.test/pack/pack-1.bin', tampered);
  assert.equal((await fetchCommunityPack(options(w))).status, 'sha');
});

test('a pack on another host than the manifest is refused', async () => {
  const w = await world({ manifestOver: { url: 'https://evil.test/pack.bin' } });
  assert.equal((await fetchCommunityPack(options(w))).status, 'format');
  const http = await world({ manifestOver: { url: 'http://pack.test/pack/pack-1.bin' } });
  assert.equal((await fetchCommunityPack(options(http))).status, 'format');
});

test('a damaged pack file is refused even when its hash matches', async () => {
  const good = makePack(['base1-4', 'base1-5'], [3, 9]);
  const w = await world({ packBytes: good.slice(0, good.length - 7) });
  assert.equal((await fetchCommunityPack(options(w))).status, 'format');
  const missing = await world();
  missing.files.delete('https://pack.test/pack/pack-1.bin');
  assert.equal((await fetchCommunityPack(options(missing))).status, 'network');
});

test('a network failure is reported, not thrown', async () => {
  const result = await fetchCommunityPack({ manifestUrl: MANIFEST_URL, publicKey, expected: EXPECTED, fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'network');
});

test('parsePack reads rows as int8 views and enforces the layout', () => {
  const rows = parsePack(makePack(['a', 'b'], [1, 2]), { ...EXPECTED, entries: 2, dim: DIM });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].cardId, 'b');
  assert.equal(rows[1].embedding.length, DIM);
  assert.equal(rows[1].embedding[2], 127);
  assert.equal(rows[1].v, 2);
  assert.throws(() => parsePack(makePack(['a'], [1]), { ...EXPECTED, entries: 2, dim: DIM }), /entries/);
  assert.throws(() => parsePack(new Uint8Array(3), { ...EXPECTED, entries: 1, dim: DIM }), /short/);
  const longHeader = new Uint8Array(8);
  new DataView(longHeader.buffer).setUint32(0, 5000, true);
  assert.throws(() => parsePack(longHeader, { ...EXPECTED, entries: 1, dim: DIM }), /header/);
});

test('pack rows work with referenceHit and the same thresholds as the user\'s own references', async () => {
  const rows = parsePack(makePack(['base1-4', 'base1-5'], [3, 9]), { ...EXPECTED, entries: 2, dim: DIM });
  const query = new Float32Array(DIM);
  query[3] = 1;
  const hit = referenceHit(query, rows, 0.5);
  assert.equal(hit.cardId, 'base1-4');
  assert.ok(Math.abs(hit.score - 1) < 1e-9);
  // A query that matches no row is not a hit.
  const far = new Float32Array(DIM);
  far[100] = 1;
  assert.equal(referenceHit(far, rows, 0.5), null);
  // It must still beat the catalog's own top score by the margin.
  assert.equal(referenceHit(query, rows, 0.99), null);
});

function state() {
  let value = null;
  return { get: async () => value, set: async (v) => { value = v; } };
}

test('checkCommunityPack stores a good pack, checks once a day, and loadStoredPack returns its rows', async () => {
  const w = await world();
  const store = createShareStore(fakeIndexedDB());
  const checks = state();
  let clock = T0;
  const args = () => ({ ...options(w), store, state: checks, now: () => clock });
  assert.equal((await checkCommunityPack(args())).status, 'ok');
  assert.equal(w.requested.length, 3);
  clock += 3600 * 1000;
  assert.equal((await checkCommunityPack(args())).status, 'skipped');
  assert.equal(w.requested.length, 3);
  const rows = await loadStoredPack(store, EXPECTED);
  assert.deepEqual(rows.map((r) => r.cardId), ['base1-4', 'base1-5']);
  clock += 24 * 3600 * 1000;
  assert.equal((await checkCommunityPack(args())).status, 'ok');
});

test('a pack that stops being improved is dropped; one that fails the signature or network is kept', async () => {
  const store = createShareStore(fakeIndexedDB());
  const good = await world();
  let clock = T0;
  const run = (w) => checkCommunityPack({ ...options(w), store, state: state(), now: () => clock });
  await run(good);
  assert.equal((await loadStoredPack(store, EXPECTED)).length, 2);
  const forged = await world({ sigOver: 'AAAA' });
  assert.equal((await run(forged)).status, 'signature');
  assert.equal((await loadStoredPack(store, EXPECTED)).length, 2);
  const worse = await world({ improved: false });
  assert.equal((await run(worse)).status, 'not-improved');
  assert.deepEqual(await loadStoredPack(store, EXPECTED), []);
});

test('a manifest needs seq and issuedAt', async () => {
  for (const over of [{ seq: undefined }, { seq: -1 }, { seq: 1.5 }, { issuedAt: undefined }, { issuedAt: 'yesterday' }]) {
    const result = await fetchCommunityPack(options(await world({ manifestOver: over })));
    assert.equal(result.status, 'format', JSON.stringify(over));
  }
});

test('a manifest older than 30 days, or issued in the future, is stale and the pack is never fetched', async () => {
  const old = await world({ manifestOver: { issuedAt: new Date(T0 - 31 * DAY).toISOString().replace('.000', '') } });
  assert.equal((await fetchCommunityPack(options(old))).status, 'stale');
  assert.equal(old.requested.length, 2);
  const fresh = await world({ manifestOver: { issuedAt: new Date(T0 - 29 * DAY).toISOString().replace('.000', '') } });
  assert.equal((await fetchCommunityPack(options(fresh))).status, 'ok');
  const future = await world({ manifestOver: { issuedAt: new Date(T0 + 2 * DAY).toISOString().replace('.000', '') } });
  assert.equal((await fetchCommunityPack(options(future))).status, 'stale');
});

test('a lower seq than the highest seen is a replay: refused, and the stored pack is kept', async () => {
  const store = createShareStore(fakeIndexedDB());
  const checks = state();
  let clock = T0;
  const run = (w) => checkCommunityPack({ ...options(w), store, state: checks, now: () => clock });
  assert.equal((await run(await world({ manifestOver: { seq: 8 } }))).status, 'ok');
  assert.equal((await checks.get()).seq, 8);
  clock += 2 * DAY;
  const replay = await run(await world({ manifestOver: { seq: 7 } }));
  assert.equal(replay.status, 'stale');
  assert.equal((await loadStoredPack(store, EXPECTED)).length, 2);
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

test('the download stops as soon as it passes the size cap', async () => {
  const w = await world();
  const huge = streamingFetch(Array.from({ length: 50 }, () => new Uint8Array(100)));
  const fetchFn = async (url, init) => (url.endsWith('pack-1.bin') ? huge.fetchFn() : w.fetchFn(url, init));
  const result = await fetchCommunityPack(options(w, { fetchFn, maxPackBytes: 1000 }));
  assert.equal(result.status, 'format');
  assert.match(result.detail, /too large/);
  assert.equal(huge.seen.cancelled, true);
  assert.ok(huge.seen.read <= 11, `read ${huge.seen.read} chunks`);
});

test('a declared content-length over the cap is refused before reading', async () => {
  const w = await world();
  const fetchFn = async (url, init) => {
    const res = await w.fetchFn(url, init);
    return url.endsWith('pack-1.bin') ? { ...res, headers: { get: (n) => (n === 'content-length' ? '999999999' : null) } } : res;
  };
  assert.equal((await fetchCommunityPack(options(w, { fetchFn }))).status, 'format');
});

test('a stored pack for another build is not used', async () => {
  const store = createShareStore(fakeIndexedDB());
  const w = await world();
  await checkCommunityPack({ ...options(w), store, state: state(), now: () => T0 });
  assert.deepEqual(await loadStoredPack(store, { ...EXPECTED, crop: 3 }), []);
  assert.deepEqual(await loadStoredPack(store, EXPECTED), []);
});
