import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createShareStore, MAX_QUEUED } from '../tools/extension-wasm/lib/share-store.js';
import { BATCH_SIZE, backoffDelay, createUploader } from '../tools/extension-wasm/lib/upload-queue.js';
import { createSharing } from '../tools/extension-wasm/lib/sharing.js';
import { fakeIndexedDB } from './helpers/fake-idb.js';

const RELAY = 'https://relay.test';
const INSTALL = '3f2b1c9e-8a47-4d65-9b0e-1c2d3e4f5a6b';
const contribution = (n = 0, over = {}) => ({
  v: 1, install: INSTALL, split: 'teach', photoId: '0000000000000001', day: '2026-10-16',
  model: { clip: '77538aade655907f', crop: 2 }, catalog: '2f3c50cec84937ff',
  cards: [{ box: [0, 0, 1, 1], crop: 'QUJD', answer: { cardId: `c${n}` }, scanner: { cardId: null, confidence: 0, stripe: 'none' }, source: 'pick' }],
  ...over,
});

function memoryState() {
  let value = null;
  return { get: async () => value, set: async (v) => { value = v; }, clear: async () => { value = null; } };
}

test('the queue keeps order, hands out a batch and removes what was sent', async () => {
  const store = createShareStore(fakeIndexedDB());
  for (let i = 0; i < 5; i++) await store.enqueue(contribution(i));
  assert.equal(await store.count(), 5);
  const batch = await store.peek(3);
  assert.deepEqual(batch.map((r) => r.item.cards[0].answer.cardId), ['c0', 'c1', 'c2']);
  await store.remove(batch.map((r) => r.seq));
  assert.deepEqual((await store.peek(10)).map((r) => r.item.cards[0].answer.cardId), ['c3', 'c4']);
  await store.clearQueue();
  assert.equal(await store.count(), 0);
});

test('at most 200 stay queued: the oldest are dropped', async () => {
  const store = createShareStore(fakeIndexedDB());
  assert.equal(MAX_QUEUED, 200);
  for (let i = 0; i < 205; i++) await store.enqueue(contribution(i));
  assert.equal(await store.count(), 200);
  assert.equal((await store.peek(1))[0].item.cards[0].answer.cardId, 'c5');
});

test('the pack is kept apart from the queue and clearAll empties the queue only', async () => {
  const store = createShareStore(fakeIndexedDB());
  await store.savePack({ sha256: 'ab', bytes: new Uint8Array([1, 2]).buffer });
  await store.enqueue(contribution());
  await store.clearQueue();
  assert.equal((await store.getPack()).sha256, 'ab');
  await store.clearPack();
  assert.equal(await store.getPack(), undefined);
});

test('batches hold at most 20 and are posted as JSON to the relay', async () => {
  const store = createShareStore(fakeIndexedDB());
  for (let i = 0; i < 45; i++) await store.enqueue(contribution(i));
  const posts = [];
  const uploader = createUploader({
    store, relayUrl: RELAY, backoff: memoryState(), now: () => 1000,
    fetchFn: async (url, init) => { posts.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
  });
  assert.equal(BATCH_SIZE, 20);
  assert.deepEqual(await uploader.flush(), { sent: 45, left: 0 });
  assert.deepEqual(posts.map((p) => p.body.contributions.length), [20, 20, 5]);
  assert.equal(posts[0].url, RELAY);
  assert.equal(posts[0].init.method, 'POST');
  assert.equal(posts[0].init.headers['Content-Type'], 'application/json');
  assert.equal(posts[0].body.v, 1);
  assert.equal(posts[0].init.credentials, 'omit');
});

test('a failed post keeps the batch and waits with growing delays', async () => {
  const store = createShareStore(fakeIndexedDB());
  await store.enqueue(contribution());
  let clock = 0;
  let calls = 0;
  const uploader = createUploader({
    store, relayUrl: RELAY, backoff: memoryState(), now: () => clock,
    fetchFn: async () => { calls += 1; return { ok: false, status: 503 }; },
  });
  assert.deepEqual(await uploader.flush(), { sent: 0, left: 1, waiting: true });
  assert.equal(calls, 1);
  // Too early: no new request.
  clock += backoffDelay(1) - 1;
  assert.deepEqual(await uploader.flush(), { sent: 0, left: 1, waiting: true });
  assert.equal(calls, 1);
  clock += 1;
  await uploader.flush();
  assert.equal(calls, 2);
  assert.ok(backoffDelay(2) > backoffDelay(1));
  assert.ok(backoffDelay(50) <= 6 * 3600 * 1000);
});

test('a network error is retried, and success clears the backoff', async () => {
  const store = createShareStore(fakeIndexedDB());
  await store.enqueue(contribution());
  let clock = 0;
  let fail = true;
  const uploader = createUploader({
    store, relayUrl: RELAY, backoff: memoryState(), now: () => clock,
    fetchFn: async () => { if (fail) throw new Error('offline'); return { ok: true, status: 200 }; },
  });
  assert.equal((await uploader.flush()).left, 1);
  fail = false;
  clock += backoffDelay(1);
  assert.deepEqual(await uploader.flush(), { sent: 1, left: 0 });
  await store.enqueue(contribution(2));
  assert.deepEqual(await uploader.flush(), { sent: 1, left: 0 });
});

test('a batch the relay refuses as invalid is dropped, not retried forever', async () => {
  const store = createShareStore(fakeIndexedDB());
  await store.enqueue(contribution());
  const uploader = createUploader({
    store, relayUrl: RELAY, backoff: memoryState(), now: () => 0,
    fetchFn: async () => ({ ok: false, status: 400 }),
  });
  assert.deepEqual(await uploader.flush(), { sent: 0, left: 0, dropped: 1 });
});

test('429 and 408 are retried like a server error', async () => {
  for (const status of [429, 408]) {
    const store = createShareStore(fakeIndexedDB());
    await store.enqueue(contribution());
    const uploader = createUploader({ store, relayUrl: RELAY, backoff: memoryState(), now: () => 0, fetchFn: async () => ({ ok: false, status }) });
    assert.equal((await uploader.flush()).left, 1, String(status));
  }
});

test('an empty relay URL sends nothing', async () => {
  const store = createShareStore(fakeIndexedDB());
  await store.enqueue(contribution());
  const uploader = createUploader({ store, relayUrl: '', backoff: memoryState(), now: () => 0, fetchFn: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(await uploader.flush(), { sent: 0, left: 1, inert: true });
});

test('overlapping flushes send each batch once', async () => {
  const store = createShareStore(fakeIndexedDB());
  await store.enqueue(contribution());
  let calls = 0;
  const uploader = createUploader({
    store, relayUrl: RELAY, backoff: memoryState(), now: () => 0,
    fetchFn: async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return { ok: true, status: 200 }; },
  });
  await Promise.all([uploader.flush(), uploader.flush()]);
  assert.equal(calls, 1);
});

function sharingParts(relayUrl = RELAY) {
  const data = new Map();
  const storage = {
    get: async (key) => data.get(key),
    set: async (key, value) => { data.set(key, value); },
    remove: async (key) => { data.delete(key); },
  };
  const store = createShareStore(fakeIndexedDB());
  const flushes = [];
  const uploader = { flush: async () => { flushes.push(1); return { sent: 0, left: 0 }; } };
  const sharing = createSharing({ storage, store, uploader, relayUrl, randomUUID: () => INSTALL, now: () => new Date('2026-10-16T10:00:00Z') });
  return { sharing, storage, store, flushes, data };
}

test('sharing is off by default and inert without a relay URL', async () => {
  const { sharing } = sharingParts();
  assert.equal(await sharing.enabled(), false);
  const inert = sharingParts('').sharing;
  assert.equal(inert.available(), false);
  await assert.rejects(() => inert.enable(), /not available/i);
  assert.equal(await inert.enabled(), false);
  assert.equal(await inert.contribute({ photoId: '0000000000000001', cards: [] }), false);
});

test('opting in creates the install id; opting out deletes it and the queue', async () => {
  const { sharing, store, data } = sharingParts();
  assert.equal(data.has('shareInstall'), false);
  await sharing.enable();
  assert.equal(data.get('shareInstall'), INSTALL);
  assert.equal(await sharing.enabled(), true);
  const row = contribution().cards[0];
  assert.equal(await sharing.contribute({ photoId: '0000000000000001', cards: [row] }), true);
  assert.equal(await store.count(), 1);
  await sharing.disable();
  assert.equal(await sharing.enabled(), false);
  assert.equal(data.has('shareInstall'), false);
  assert.equal(data.has('shareEnabled'), false);
  assert.equal(await store.count(), 0);
});

test('installId shows the id only while sharing is on', async () => {
  const { sharing } = sharingParts();
  assert.equal(await sharing.installId(), null);
  await sharing.enable();
  assert.equal(await sharing.installId(), INSTALL);
  await sharing.disable();
  assert.equal(await sharing.installId(), null);
});

test('contribute queues a validated contribution and starts an upload; a bad one throws and queues nothing', async () => {
  const { sharing, store, flushes } = sharingParts();
  await sharing.enable();
  const row = contribution().cards[0];
  await sharing.contribute({ photoId: '0000000000000005', cards: [row] });
  const [{ item }] = await store.peek(1);
  assert.equal(item.split, 'exam');
  assert.equal(item.install, INSTALL);
  assert.equal(item.day, '2026-10-16');
  assert.equal(flushes.length, 1);
  await assert.rejects(() => sharing.contribute({ photoId: '0000000000000005', cards: [{ ...row, source: 'bogus' }] }), /invalid contribution/);
  assert.equal(await store.count(), 1);
});

test('contributing while opted out queues nothing', async () => {
  const { sharing, store } = sharingParts();
  assert.equal(await sharing.contribute({ photoId: '0000000000000001', cards: [contribution().cards[0]] }), false);
  assert.equal(await store.count(), 0);
});

test('a failed upload start never fails the contribution', async () => {
  const parts = sharingParts();
  const throwing = createSharing({
    storage: parts.storage, store: parts.store, uploader: { flush: async () => { throw new Error('boom'); } },
    relayUrl: RELAY, randomUUID: () => INSTALL,
  });
  await throwing.enable();
  assert.equal(await throwing.contribute({ photoId: '0000000000000001', cards: [contribution().cards[0]] }), true);
});
