import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { RetryablePokegradeError } from '../src/pokegrade/client.js';
import { processCard } from '../src/pipeline/processCard.js';

async function withTempQueue(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pipeline-test-'));
  try {
    return await fn(createQueue(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const IDENTITY = { name: 'Charizard', set: 'Base Set', number: '4' };

function agreeingClients() {
  return {
    pokegradeClient: {
      evaluateFrontImage: async () => ({ identity: IDENTITY, value: 100, confidence: 'high' }),
    },
    tcgplayerClient: { getMarketPrice: async () => ({ market: 102, mid: 105 }) },
    ebaySoldsClient: { getRecentSolds: async () => ({ prices: [98, 101, 103], median: 101 }) },
  };
}

test('processCard: high-confidence agreement stores comps and drafts selected marketplaces', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'Charizard', frontImagePath: '/tmp/front.jpg', mercari: true, ebay: false });
    const draftCalls = [];
    const record = await processCard(id, {
      queue,
      ...agreeingClients(),
      createDraft: async (marketplace, card) => {
        draftCalls.push({ marketplace, id: card.id });
      },
    });

    assert.equal(record.status, 'drafting');
    assert.deepEqual(record.pricedCache.identity, IDENTITY);
    assert.equal(record.pricedCache.comps.pokegrade, 100);
    assert.equal(record.pricedCache.comps.tcgplayer, 102);
    assert.equal(record.pricedCache.comps.ebay, 101);
    assert.ok(record.pricedCache.suggested.mercari > 0);
    assert.deepEqual(draftCalls, [{ marketplace: 'mercari', id }]);
  });
});

test('processCard: disagreement sets needs_review and does not call marketplace drivers', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'Blastoise', frontImagePath: '/tmp/front.jpg', mercari: true, ebay: true });
    let draftCalled = false;
    const record = await processCard(id, {
      queue,
      pokegradeClient: {
        evaluateFrontImage: async () => ({ identity: IDENTITY, value: 100, confidence: 'high' }),
      },
      tcgplayerClient: { getMarketPrice: async () => ({ market: 200, mid: 205 }) },
      ebaySoldsClient: { getRecentSolds: async () => ({ prices: [98, 101, 103], median: 101 }) },
      createDraft: async () => {
        draftCalled = true;
      },
    });

    assert.equal(record.status, 'needs_review');
    assert.equal(draftCalled, false);
  });
});

test('processCard: transient PokeGrade failure leaves card queued and retryable without burning cache', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'Venusaur', frontImagePath: '/tmp/front.jpg', mercari: true, ebay: false });
    const record = await processCard(id, {
      queue,
      pokegradeClient: {
        evaluateFrontImage: async () => {
          throw new RetryablePokegradeError('PokeGrade transient error: 503');
        },
      },
      tcgplayerClient: { getMarketPrice: async () => { throw new Error('should not be called'); } },
      ebaySoldsClient: { getRecentSolds: async () => { throw new Error('should not be called'); } },
      createDraft: async () => { throw new Error('should not be called'); },
    });

    assert.equal(record.status, 'queued');
    assert.equal(record.pricedCache, null);
  });
});
