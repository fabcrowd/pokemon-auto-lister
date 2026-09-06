import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { scanInbox } from '../src/inbox/watcher.js';
import { createDraftDispatcher } from '../src/dispatch/draftDispatch.js';
import {
  findPostedCollision,
  hashImageFile,
  recordPostedPhotos,
  seedPostedLedgerFromQueue,
} from '../src/photos/postedLedger.js';

function withTemp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'posted-photos-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('recordPostedPhotos then findPostedCollision matches by path and hash', async () => {
  await withTemp(async (dir) => {
    const img = path.join(dir, 'card.jpg');
    writeFileSync(img, Buffer.from('unique-card-bytes-abc'));
    recordPostedPhotos(dir, { id: 'card-1', photos: [img], frontImagePath: img });

    assert.equal(findPostedCollision(dir, [img])?.via, 'path');

    const copy = path.join(dir, 'copy.jpg');
    writeFileSync(copy, Buffer.from('unique-card-bytes-abc'));
    const hit = findPostedCollision(dir, [copy]);
    assert.equal(hit?.via, 'hash');
    assert.equal(hit?.cardId, 'card-1');
    assert.equal(hashImageFile(img), hashImageFile(copy));
  });
});

test('markDrafted records photos into the posted ledger', async () => {
  await withTemp(async (dir) => {
    const img = path.join(dir, 'front.jpg');
    writeFileSync(img, 'front-bytes');
    const queue = createQueue(dir);
    const id = queue.enqueue({ title: 'x', photos: [img], frontImagePath: img, mercari: true });
    queue.markDrafted(id, 'mercari', { draftUrl: 'https://example' });
    assert.ok(findPostedCollision(dir, [img]));
  });
});

test('scanInbox skips flat pairs whose photos were already posted', async () => {
  await withTemp(async (dir) => {
    const inbox = path.join(dir, 'inbox');
    mkdirSync(inbox);
    const a = path.join(inbox, 'a.jpg');
    const b = path.join(inbox, 'b.jpg');
    writeFileSync(a, 'photo-a');
    writeFileSync(b, 'photo-b');
    const now = Date.now() / 1000;
    utimesSync(a, now - 10, now - 10);
    utimesSync(b, now - 5, now - 5);

    const queue = createQueue(dir);
    recordPostedPhotos(dir, { id: 'old', photos: [a, b], frontImagePath: a, backImagePath: b });

    const ids = await scanInbox({ inboxDir: inbox, queue, dataDir: dir });
    assert.deepEqual(ids, { enqueued: [], updated: [] });
    assert.equal(queue.listByStatus('queued').length, 0);
  });
});

test('createDraftDispatcher refuses photos already posted on another card', async () => {
  await withTemp(async (dir) => {
    const img = path.join(dir, 'x.jpg');
    writeFileSync(img, ' Mercari-repost-guard ');
    const queue = createQueue(dir);
    const first = queue.enqueue({ title: 'one', photos: [img], frontImagePath: img, mercari: true });
    queue.markDrafted(first, 'mercari', {});

    const second = queue.enqueue({ title: 'two', photos: [img], frontImagePath: img, mercari: true });
    let driverCalls = 0;
    const createDraft = createDraftDispatcher({
      queue,
      dataDir: dir,
      drivers: {
        mercari: async () => {
          driverCalls += 1;
          return { draftUrl: 'https://x' };
        },
      },
    });

    await createDraft('mercari', queue.get(second));
    assert.equal(driverCalls, 0);
    assert.match(queue.get(second).drafts.mercari.error, /Refusing to re-post/);
  });
});

test('seedPostedLedgerFromQueue indexes drafted cards', async () => {
  await withTemp(async (dir) => {
    const img = path.join(dir, 'seed.jpg');
    writeFileSync(img, 'seed-bytes');
    const queue = createQueue(dir);
    // Bypass markDrafted ledger by writing status directly via enqueue + setStatus + drafts
    const id = queue.enqueue({ title: 'seed', photos: [img], frontImagePath: img });
    const record = queue.get(id);
    record.status = 'drafted';
    record.drafts = { mercari: { created: true } };
    writeFileSync(path.join(dir, 'queue', `${id}.json`), JSON.stringify(record, null, 2));

    assert.equal(findPostedCollision(dir, [img]), null);
    seedPostedLedgerFromQueue(dir, queue);
    assert.ok(findPostedCollision(dir, [img]));
  });
});

test('seedPostedLedgerFromQueue includes error cards that already drafted', async () => {
  await withTemp(async (dir) => {
    const img = path.join(dir, 'err.jpg');
    writeFileSync(img, 'error-card-bytes');
    const queue = createQueue(dir);
    const id = queue.enqueue({ title: 'err', photos: [img], frontImagePath: img });
    const record = queue.get(id);
    record.status = 'error';
    record.drafts = { mercari: { created: true } };
    writeFileSync(path.join(dir, 'queue', `${id}.json`), JSON.stringify(record, null, 2));

    seedPostedLedgerFromQueue(dir, queue);
    assert.ok(findPostedCollision(dir, [img]));
  });
});
