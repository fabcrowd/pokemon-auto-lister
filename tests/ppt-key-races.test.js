import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearPptKey, getPptKey, savePptKey } from '../tools/extension-wasm/lib/ppt-key.js';

function fakeArea(initial = {}, { failSet = false, delayMs = 0 } = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return key in data ? { [key]: data[key] } : {};
    },
    set: async (items) => {
      if (failSet) throw new Error('quota');
      Object.assign(data, items);
    },
    remove: async (key) => { delete data[key]; },
  };
}

test('clearing while the migration is still running leaves no key in either area', async () => {
  const storage = { sync: fakeArea({ pptApiKey: 'abc' }, { delayMs: 20 }), local: fakeArea() };
  const reading = getPptKey(storage);
  await clearPptKey(storage);
  await reading;
  assert.equal('pptApiKey' in storage.sync.data, false);
  assert.equal('pptApiKey' in storage.local.data, false);
});

test('saving while the migration is still running keeps the new key', async () => {
  const storage = { sync: fakeArea({ pptApiKey: 'old' }, { delayMs: 20 }), local: fakeArea() };
  const reading = getPptKey(storage);
  await savePptKey('new', storage);
  await reading;
  assert.equal(storage.local.data.pptApiKey, 'new');
});

test('when the migration cannot run, the key still in sync is read for that call', async () => {
  const sync = fakeArea({ pptApiKey: 'legacy' });
  const storage = { sync, local: fakeArea({}, { failSet: true }) };
  assert.equal(await getPptKey(storage), 'legacy');
  assert.equal(sync.data.pptApiKey, 'legacy');
});
