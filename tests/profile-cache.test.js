import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearStaleServiceWorker } from '../scripts/lib/profile-cache.mjs';

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-cache-'));
  return { repo, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

function seed(profile) {
  const sw = path.join(profile, 'Default', 'Service Worker');
  for (const dir of ['ScriptCache', 'Database', 'CacheStorage']) {
    fs.mkdirSync(path.join(sw, dir), { recursive: true });
    fs.writeFileSync(path.join(sw, dir, 'f'), 'x');
  }
  return sw;
}

test('clearStaleServiceWorker removes ScriptCache and Database but keeps CacheStorage', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const profile = path.join(repo, 'data', 'p');
    const sw = seed(profile);
    clearStaleServiceWorker(repo, profile);
    assert.equal(fs.existsSync(path.join(sw, 'ScriptCache')), false);
    assert.equal(fs.existsSync(path.join(sw, 'Database')), false);
    assert.equal(fs.existsSync(path.join(sw, 'CacheStorage', 'f')), true);
  } finally {
    cleanup();
  }
});

test('clearStaleServiceWorker accepts a profile under .tmp', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const profile = path.join(repo, '.tmp', 'p');
    const sw = seed(profile);
    clearStaleServiceWorker(repo, profile);
    assert.equal(fs.existsSync(path.join(sw, 'ScriptCache')), false);
  } finally {
    cleanup();
  }
});

test('clearStaleServiceWorker refuses a profile outside data/ and .tmp/ and deletes nothing', () => {
  const { repo, cleanup } = makeRepo();
  try {
    for (const profile of [path.join(repo, 'elsewhere'), path.join(repo, 'data'), path.join(repo, 'data', '..', 'x')]) {
      const sw = seed(profile);
      assert.throws(() => clearStaleServiceWorker(repo, profile), /inside/);
      assert.equal(fs.existsSync(path.join(sw, 'ScriptCache', 'f')), true);
    }
  } finally {
    cleanup();
  }
});

test('clearStaleServiceWorker is a no-op for a fresh profile', () => {
  const { repo, cleanup } = makeRepo();
  try {
    assert.doesNotThrow(() => clearStaleServiceWorker(repo, path.join(repo, 'data', 'new')));
  } finally {
    cleanup();
  }
});
