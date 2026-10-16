import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_NAME, pruneOldCaches } from '../tools/extension-wasm/lib/setup.js';

test('caches left by earlier builds are deleted, so unverified files are downloaded and hashed again', async () => {
  const names = ['cardscanner-models-v2.1', 'cardscanner-models-v2.0', CACHE_NAME, 'someone-elses-cache'];
  const deleted = [];
  globalThis.caches = { keys: async () => names, delete: async (name) => { deleted.push(name); return true; } };
  await pruneOldCaches();
  assert.deepEqual(deleted.sort(), ['cardscanner-models-v2.0', 'cardscanner-models-v2.1']);
  assert.notEqual(CACHE_NAME, 'cardscanner-models-v2.1');
});
