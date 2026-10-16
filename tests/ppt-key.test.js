import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearPptKey, getPptKey, migratePptKey, savePptKey } from '../tools/extension-wasm/lib/ppt-key.js';

function fakeArea(initial = {}, { failSet = false } = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => {
      if (failSet) throw new Error('quota');
      Object.assign(data, items);
    },
    remove: async (key) => { delete data[key]; },
  };
}

test('a key in sync is copied to local and removed from sync', async () => {
  const sync = fakeArea({ pptApiKey: 'abc' });
  const local = fakeArea();
  assert.deepEqual(await migratePptKey(sync, local), { migrated: true });
  assert.equal(local.data.pptApiKey, 'abc');
  assert.equal('pptApiKey' in sync.data, false);
});

test('with no key in sync nothing is written', async () => {
  const sync = fakeArea();
  const local = fakeArea();
  assert.deepEqual(await migratePptKey(sync, local), { migrated: false });
  assert.deepEqual(local.data, {});
});

test('a key already in local wins, and the sync copy is still removed', async () => {
  const sync = fakeArea({ pptApiKey: 'old' });
  const local = fakeArea({ pptApiKey: 'new' });
  await migratePptKey(sync, local);
  assert.equal(local.data.pptApiKey, 'new');
  assert.equal('pptApiKey' in sync.data, false);
});

test('if the local write fails the sync copy is kept', async () => {
  const sync = fakeArea({ pptApiKey: 'abc' });
  const local = fakeArea({}, { failSet: true });
  await assert.rejects(migratePptKey(sync, local), /quota/);
  assert.equal(sync.data.pptApiKey, 'abc');
});

test('migrating twice is harmless', async () => {
  const sync = fakeArea({ pptApiKey: 'abc' });
  const local = fakeArea();
  await migratePptKey(sync, local);
  assert.deepEqual(await migratePptKey(sync, local), { migrated: false });
  assert.equal(local.data.pptApiKey, 'abc');
});

test('reading the key migrates first, then reads local', async () => {
  const storage = { sync: fakeArea({ pptApiKey: 'abc' }), local: fakeArea() };
  assert.equal(await getPptKey(storage), 'abc');
  assert.equal('pptApiKey' in storage.sync.data, false);
});

test('a sync area that throws does not hide the local key', async () => {
  const storage = {
    sync: { get: async () => { throw new Error('sync off'); }, remove: async () => {}, set: async () => {} },
    local: fakeArea({ pptApiKey: 'kept' }),
  };
  assert.equal(await getPptKey(storage), 'kept');
});

test('save writes to local only; clear removes it everywhere', async () => {
  const storage = { sync: fakeArea({ pptApiKey: 'stale' }), local: fakeArea() };
  await savePptKey('fresh', storage);
  assert.equal(storage.local.data.pptApiKey, 'fresh');
  assert.equal('pptApiKey' in storage.sync.data, false);
  await clearPptKey(storage);
  assert.equal(await getPptKey(storage), null);
});
