import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { createDraftDispatcher } from '../src/dispatch/draftDispatch.js';

function withTempQueue(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-test-'));
  try {
    return fn(createQueue(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('createDraftDispatcher routes to the driver matching the marketplace only', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'Charizard', mercari: true, ebay: false });
    const record = queue.get(id);
    const mercariCalls = [];
    const ebayCalls = [];
    const createDraft = createDraftDispatcher({
      queue,
      drivers: {
        mercari: async (card) => {
          mercariCalls.push(card.id);
          return { draftUrl: 'https://mercari.example/draft' };
        },
        ebay: async (card) => {
          ebayCalls.push(card.id);
          return { offerId: 'offer-1' };
        },
      },
    });

    await createDraft('mercari', record);

    assert.deepEqual(mercariCalls, [id]);
    assert.deepEqual(ebayCalls, []);
    assert.equal(queue.get(id).drafts.mercari.created, true);
    assert.equal(queue.get(id).drafts.mercari.draftUrl, 'https://mercari.example/draft');
  });
});

test('createDraftDispatcher records a driver failure without throwing', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'Blastoise', mercari: false, ebay: true });
    const record = queue.get(id);
    const createDraft = createDraftDispatcher({
      queue,
      drivers: {
        ebay: async () => {
          throw new Error('eBay offer create failed: 500');
        },
      },
    });

    await createDraft('ebay', record);

    const updated = queue.get(id);
    assert.equal(updated.drafts.ebay.created, false);
    assert.equal(updated.drafts.ebay.error, 'eBay offer create failed: 500');
  });
});

test('partial success: one marketplace drafts while the other fails independently', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'Venusaur', mercari: true, ebay: true });
    const record = queue.get(id);
    const createDraft = createDraftDispatcher({
      queue,
      drivers: {
        mercari: async () => ({ draftUrl: 'https://mercari.example/draft' }),
        ebay: async () => {
          throw new Error('eBay offer create failed: 503');
        },
      },
    });

    await createDraft('mercari', record);
    await createDraft('ebay', record);

    const updated = queue.get(id);
    assert.equal(updated.drafts.mercari.created, true);
    assert.equal(updated.drafts.ebay.created, false);
    assert.equal(updated.drafts.ebay.error, 'eBay offer create failed: 503');
  });
});

test('createDraftDispatcher throws a clear error when no driver is configured for a marketplace', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'Pikachu', mercari: true, ebay: false });
    const record = queue.get(id);
    const createDraft = createDraftDispatcher({ queue, drivers: {} });

    await assert.rejects(() => createDraft('mercari', record), /No draft driver configured for marketplace: mercari/);
  });
});
