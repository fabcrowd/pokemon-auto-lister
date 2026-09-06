import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { scanInbox, pairSequentialPhotos } from '../src/inbox/watcher.js';

async function withTempDirs(fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'inbox-data-'));
  const inboxDir = mkdtempSync(path.join(tmpdir(), 'inbox-drop-'));
  try {
    return await fn({ queue: createQueue(dataDir), inboxDir, dataDir });
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

    const result = await scanInbox({ inboxDir, queue });

    assert.equal(result.enqueued.length, 1);
    assert.equal(result.updated.length, 0);
    const record = queue.get(result.enqueued[0]);
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

    assert.equal(first.enqueued.length, 1);
    assert.equal(second.enqueued.length, 0);
    assert.equal(queue.listByStatus('queued').length, 1);
  });
});

test('scanInbox skips folders with no image files and non-directory entries', async () => {
  await withTempDirs(async ({ queue, inboxDir }) => {
    dropCardFolder(inboxDir, 'empty-folder', []);
    writeFileSync(path.join(inboxDir, 'stray-file.txt'), 'not a folder');

    const result = await scanInbox({ inboxDir, queue });

    assert.deepEqual(result, { enqueued: [], updated: [] });
  });
});

test('scanInbox calls onEnqueue with the new card id so it shares the same pipeline as phone uploads', async () => {
  await withTempDirs(async ({ queue, inboxDir }) => {
    dropCardFolder(inboxDir, 'pikachu-1', ['front.png']);
    const enqueuedIds = [];

    const result = await scanInbox({
      inboxDir,
      queue,
      onEnqueue: async (id) => enqueuedIds.push(id),
    });

    assert.deepEqual(enqueuedIds, result.enqueued);
  });
});

test('scanInbox returns empty lists when the inbox directory does not exist', async () => {
  await withTempDirs(async ({ queue, inboxDir }) => {
    rmSync(inboxDir, { recursive: true, force: true });

    const result = await scanInbox({ inboxDir, queue });

    assert.deepEqual(result, { enqueued: [], updated: [] });
  });
});

test('pairSequentialPhotos groups front then back and leaves a trailing front alone', () => {
  const paired = pairSequentialPhotos(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']);
  assert.equal(paired.length, 3);
  assert.deepEqual(paired[0].photos, ['a.jpg', 'b.jpg']);
  assert.equal(paired[0].frontImagePath, 'a.jpg');
  assert.equal(paired[0].backImagePath, 'b.jpg');
  assert.deepEqual(paired[2].photos, ['e.jpg']);
  assert.equal(paired[2].backImagePath, null);
});

test('scanInbox pairs identified fronts with the next full-card as back and matches closeups', async () => {
  await withTempDirs(async ({ queue, inboxDir, dataDir }) => {
    const names = ['IMG_1001.jpg', 'IMG_1002.jpg', 'IMG_1003.jpg', 'IMG_1004.jpg', 'IMG_1005.jpg'];
    const kinds = {
      'IMG_1001.jpg': { kind: 'full_front', score: 0.8 },
      'IMG_1002.jpg': { kind: 'closeup', score: 0.2 },
      'IMG_1003.jpg': { kind: 'full_back', score: 0.7 },
      'IMG_1004.jpg': { kind: 'full_front', score: 0.75 },
      'IMG_1005.jpg': { kind: 'full_back', score: 0.7 },
    };
    names.forEach((name) => {
      writeFileSync(path.join(inboxDir, name), `bytes-${name}`);
    });

    const result = await scanInbox({
      inboxDir,
      queue,
      dataDir,
      classifyShotFn: async (photoPath) => {
        const base = path.basename(photoPath);
        return { path: photoPath, ...kinds[base] };
      },
      groupShotsFn: async (shots, opts = {}) => {
        const { groupCardPhotos } = await import('../src/photos/groupShots.js');
        return groupCardPhotos(shots, {
          ...opts,
          matchCloseupFn: async (closeupPath, frontPaths) => {
            if (closeupPath.endsWith('IMG_1002.jpg')) {
              return { frontPath: frontPaths.find((p) => p.endsWith('IMG_1001.jpg')), score: 0.9, label: 'tl' };
            }
            return { frontPath: null, score: 0, label: null };
          },
        });
      },
    });

    assert.equal(result.enqueued.length, 2);
    const first = queue.get(result.enqueued[0]);
    assert.ok(first.frontImagePath.endsWith('IMG_1001.jpg'));
    assert.ok(first.backImagePath.endsWith('IMG_1003.jpg'));
    assert.ok(first.photos.some((p) => p.endsWith('IMG_1002.jpg')));

    const second = queue.get(result.enqueued[1]);
    assert.ok(second.frontImagePath.endsWith('IMG_1004.jpg'));
    assert.ok(second.backImagePath.endsWith('IMG_1005.jpg'));
  });
});

test('scanInbox forceRescan updates existing cards and re-runs onEnqueue', async () => {
  await withTempDirs(async ({ queue, inboxDir, dataDir }) => {
    dropCardFolder(inboxDir, 'mew-1', ['front.jpg', 'back.jpg']);
    const first = await scanInbox({ inboxDir, queue, dataDir });
    assert.equal(first.enqueued.length, 1);
    const id = first.enqueued[0];
    queue.setStatus(id, 'needs_review');
    queue.setPriced(id, { reason: 'stale', action: 'needs_review', comps: {} });

    const pipeline = [];
    const second = await scanInbox({
      inboxDir,
      queue,
      dataDir,
      forceRescan: true,
      onEnqueue: async (cardId) => pipeline.push(cardId),
    });

    assert.deepEqual(second.enqueued, []);
    assert.deepEqual(second.updated, [id]);
    assert.deepEqual(pipeline, [id]);
    assert.equal(queue.listAll().length, 1);
    const record = queue.get(id);
    assert.equal(record.status, 'queued');
    assert.equal(record.pricedCache, null);
    assert.ok(record.frontImagePath.endsWith('front.jpg'));
  });
});

test('scanInbox forceRescan leaves listed cards alone', async () => {
  await withTempDirs(async ({ queue, inboxDir, dataDir }) => {
    dropCardFolder(inboxDir, 'listed-1', ['front.jpg']);
    const first = await scanInbox({ inboxDir, queue, dataDir });
    const id = first.enqueued[0];
    queue.markListed(id, 'mercari', { listingUrl: 'https://example.test/1' });

    const pipeline = [];
    const second = await scanInbox({
      inboxDir,
      queue,
      dataDir,
      forceRescan: true,
      onEnqueue: async (cardId) => pipeline.push(cardId),
    });

    assert.deepEqual(second.enqueued, []);
    assert.deepEqual(second.updated, []);
    assert.deepEqual(pipeline, []);
    assert.equal(queue.get(id).status, 'listed');
  });
});
