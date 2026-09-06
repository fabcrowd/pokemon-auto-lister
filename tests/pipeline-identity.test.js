import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { processCard } from '../src/pipeline/processCard.js';
import { createIdentityResolver } from '../src/identify/resolver.js';
import { createMockVellumAiClient } from '../src/identify/vellumAi.js';

const IDENTITY = { name: 'Charizard', set: 'Base Set', setCode: 'base1', number: '4' };
const OTHER = { name: 'Blastoise', set: 'Base Set', setCode: 'base1', number: '2' };

async function withTempQueue(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pipeline-id-'));
  try {
    return await fn(createQueue(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('processCard dual conflict forces needs_review', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'x', frontImagePath: '/tmp/front.jpg', mercari: true });
    let draftCalled = false;
    const identityResolver = createIdentityResolver({
      mode: 'dual',
      vellumEnabled: true,
      pokegradeClient: {
        evaluateFrontImage: async () => ({ identity: IDENTITY, value: 100, confidence: 'high' }),
      },
      vellumClient: createMockVellumAiClient(async () => ({ identity: OTHER, confidence: 'high' })),
    });
    const record = await processCard(id, {
      queue,
      identityResolver,
      tcgplayerClient: { getMarketPrice: async () => ({ market: 102 }) },
      ebaySoldsClient: { getRecentSolds: async () => ({ median: 101 }) },
      createDraft: async () => {
        draftCalled = true;
      },
    });
    assert.equal(record.status, 'needs_review');
    assert.equal(record.pricedCache.identityConflict, true);
    assert.equal(draftCalled, false);
  });
});

test('processCard solo prices without PokeGrade value when VellumAI accepts', async () => {
  await withTempQueue(async (queue) => {
    const id = queue.enqueue({ title: 'x', frontImagePath: '/tmp/front.jpg', mercari: true });
    const identityResolver = createIdentityResolver({
      mode: 'local-only',
      vellumEnabled: true,
      pokegradeClient: {
        evaluateFrontImage: async () => {
          throw new Error('PG should not run');
        },
      },
      vellumClient: createMockVellumAiClient(async () => ({
        identity: IDENTITY,
        confidence: 'high',
      })),
    });
    const record = await processCard(id, {
      queue,
      identityResolver,
      tcgplayerClient: { getMarketPrice: async () => ({ market: 102 }) },
      ebaySoldsClient: { getRecentSolds: async () => ({ median: 101 }) },
      collectrClient: { getMarketPrice: () => ({ market: 100 }) },
    });
    assert.equal(record.pricedCache.idSource, 'vellum-ai-solo');
    assert.equal(record.pricedCache.comps.pokegrade, null);
    assert.equal(record.pricedCache.comps.collectr, 100);
    assert.ok(['drafting', 'needs_review'].includes(record.status));
  });
});
