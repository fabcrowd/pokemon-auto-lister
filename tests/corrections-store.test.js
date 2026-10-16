import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCorrectionsStore } from '../tools/extension-wasm/lib/corrections-store.js';

// Just enough of IndexedDB: requests answer on a later microtask and a transaction
// completes once every request it made, including ones made from callbacks, is done.
function fakeIndexedDB({ failOpen = false, invalidStateOnce = false } = {}) {
  const stores = new Map();
  const opened = [];
  const dbs = [];
  let invalidState = invalidStateOnce;
  const later = (fn) => Promise.resolve().then(fn);

  function makeStore(name, tx) {
    const entry = stores.get(name);
    const request = (compute) => {
      const req = { result: undefined, onsuccess: null };
      tx.pending += 1;
      later(() => {
        req.result = compute();
        req.onsuccess?.({ target: req });
        tx.pending -= 1;
        if (tx.pending === 0) later(() => tx.oncomplete?.());
      });
      return req;
    };
    const put = (value) => request(() => {
      const key = value[entry.options.keyPath] ?? entry.next++;
      entry.rows.set(key, { ...value, [entry.options.keyPath]: key });
      return key;
    });
    return {
      add: put,
      put,
      get: (key) => request(() => entry.rows.get(key)),
      delete: (key) => request(() => { entry.rows.delete(key); }),
      getAll: () => request(() => [...entry.rows.values()].map((r) => ({ ...r }))),
      count: () => request(() => entry.rows.size),
      clear: () => request(() => { entry.rows.clear(); }),
    };
  }

  return {
    opened,
    stores,
    dbs,
    open(name, version) {
      opened.push({ name, version });
      const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        if (failOpen) {
          req.error = new Error('blocked');
          req.onerror?.({ target: req });
          return;
        }
        const db = {
          onclose: null,
          onversionchange: null,
          closed: false,
          close() { this.closed = true; },
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n, options) => { stores.set(n, { rows: new Map(), options, next: 1 }); },
          transaction: (n) => {
            if (invalidState) {
              invalidState = false;
              throw Object.assign(new Error('closing'), { name: 'InvalidStateError' });
            }
            const tx = { oncomplete: null, pending: 0 };
            tx.objectStore = () => makeStore(n, tx);
            return tx;
          },
        };
        dbs.push(db);
        req.result = db;
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

const scan = (scanId, ts) => ({ scanId, ts, pageUrl: 'https://x.test/p', crops: ['data:image/jpeg;base64,AA', null] });

test('saves, counts, lists and clears corrections in the corrections store of card-scanner', async () => {
  const idb = fakeIndexedDB();
  const store = createCorrectionsStore(idb);
  assert.equal(await store.count(), 0);
  await store.save({ ts: 1, pickedId: 'a' });
  await store.save({ ts: 2, pickedId: 'b' });
  assert.equal(await store.count(), 2);
  assert.deepEqual((await store.all()).map((r) => r.pickedId), ['a', 'b']);
  assert.equal(idb.opened[0].name, 'card-scanner');
  assert.equal(idb.stores.has('corrections'), true);
  await store.clear();
  assert.equal(await store.count(), 0);
  assert.deepEqual(await store.all(), []);
});

test('a second answer for the same scan crop replaces the first', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.save({ id: 's1:0', ts: 1, pickedId: 'a' });
  await store.save({ id: 's1:1', ts: 2, pickedId: 'c' });
  await store.save({ id: 's1:0', ts: 3, pickedId: 'b' });
  const all = await store.all();
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.id === 's1:0').pickedId, 'b');
});

test('keeps the pictures of the last two scans only', async () => {
  const store = createCorrectionsStore(fakeIndexedDB());
  await store.saveScan(scan('s1', 1));
  await store.saveScan(scan('s2', 2));
  await store.saveScan(scan('s3', 3));
  assert.equal(await store.getScan('s1'), undefined);
  assert.equal((await store.getScan('s2')).pageUrl, 'https://x.test/p');
  assert.deepEqual((await store.getScan('s3')).crops, ['data:image/jpeg;base64,AA', null]);
});

test('opens the database once per store', async () => {
  const idb = fakeIndexedDB();
  const store = createCorrectionsStore(idb);
  await Promise.all([store.count(), store.count(), store.save({ ts: 1, pickedId: 'a' })]);
  assert.equal(idb.opened.length, 1);
});

test('a failed open rejects and the next call tries again', async () => {
  const idb = fakeIndexedDB({ failOpen: true });
  const store = createCorrectionsStore(idb);
  await assert.rejects(store.count(), /blocked/);
  await assert.rejects(store.count(), /blocked/);
  assert.equal(idb.opened.length, 2);
});

test('a closed or upgraded-away database is reopened on the next call', async () => {
  const idb = fakeIndexedDB();
  const store = createCorrectionsStore(idb);
  await store.count();
  idb.dbs[0].onclose();
  await store.count();
  assert.equal(idb.opened.length, 2);
  idb.dbs[1].onversionchange();
  assert.equal(idb.dbs[1].closed, true);
  await store.count();
  assert.equal(idb.opened.length, 3);
});

test('an InvalidStateError from a dying connection is retried once on a fresh one', async () => {
  const idb = fakeIndexedDB({ invalidStateOnce: true });
  const store = createCorrectionsStore(idb);
  assert.equal(await store.count(), 0);
  assert.equal(idb.opened.length, 2);
});

test('no IndexedDB at all is a clear error', async () => {
  const store = createCorrectionsStore(null);
  await assert.rejects(store.count(), /IndexedDB/);
});
