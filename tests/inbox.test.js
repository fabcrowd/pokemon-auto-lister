import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { scanInbox } from '../src/inbox/watcher.js';

function withTempDirs(fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'inbox-data-'));
  const inboxDir = mkdtempSync(path.join(tmpdir(), 'inbox-drop-'));
  try {
    return fn({ queue: createQueue(dataDir), inboxDir });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
  }
}

function dropCardFolder(inboxDir, name, files) {
  const folderPath = path.join(inboxDir, name);
  mkdirSync(folderPath, { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(folderPath, file), 'fake-image-bytes');
  }
  return folderPath;
}

test('scanInbox enqueues a new card folder with its photos and a picked front image', async () => {
  await withTempDirs(async ({ queue, inboxDir }) => {
    dropCardFolder(inboxDir, 'charizard-1', ['back.jpg', 'front.jpg', 'side.jpg']);

    const ids = await scanInbox({ inboxDir, queue });

    assert.equal(ids.length, 1);
    const record = queue.get(ids[0]);
    assert.equal(record.title, 'charizard-1');
    assert.equal(record.photos.length, 3);
    assert.ok(record.frontImagePath.endsWith('front.jpg'));
    assert.equal(record.mercari, true);
    assert.equal(record.ebay, true);
  });
});

test('scanInbox does not duplicate a folder it already enqueued', async () => {
  await withTempDirs(async ({ queue, inboxDir }) => {
    dropCardFolder(inboxDir, 'blastoise-1', ['front.jpg']);

    const first = await scanInbox({ inboxDir, queue });
    const second = await scanInbox({ inboxDir, queue });

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(queue.listByStatus('queued').length, 1);
  });
});

test('scanInbox skips folders with no image files and non-directory entries', async () => {
  await withTempDirs(async ({ queue, inboxDir }) => {
    dropCardFolder(inboxDir, 'empty-folder', []);
    writeFileSync(path.join(inboxDir, 'stray-file.txt'), 'not a folder');

    const ids = await scanInbox({ inboxDir, queue });

    assert.deepEqual(ids, []);
  });
});

test('scanInbox calls onEnqueue with the new card id so it shares the same pipeline as phone uploads', async () => {
  await withTempDirs(async ({ queue, inboxDir }) => {
    dropCardFolder(inboxDir, 'pikachu-1', ['front.png']);
    const enqueuedIds = [];

    const ids = await scanInbox({ inboxDir, queue, onEnqueue: async (id) => enqueuedIds.push(id) });

    assert.deepEqual(enqueuedIds, ids);
  });
});

test('scanInbox returns an empty array when the inbox directory does not exist', async () => {
  await withTempDirs(async ({ queue, inboxDir }) => {
    rmSync(inboxDir, { recursive: true, force: true });

    const ids = await scanInbox({ inboxDir, queue });

    assert.deepEqual(ids, []);
  });
});
