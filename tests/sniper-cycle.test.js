import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSniperState } from '../src/sniper/state.js';
import { processListing, runSniperCycle } from '../src/sniper/cycle.js';
import { isSniperEnabled, loadSniperConfig } from '../src/sniper/start.js';
import { RetryablePokegradeError } from '../src/pokegrade/client.js';

describe('isSniperEnabled', () => {
  it('defaults to false', () => {
    assert.equal(isSniperEnabled({}), false);
  });

  it('accepts true/1/yes/on', () => {
    assert.equal(isSniperEnabled({ SNIPER_ENABLED: 'true' }), true);
    assert.equal(isSniperEnabled({ SNIPER_ENABLED: '1' }), true);
    assert.equal(isSniperEnabled({ SNIPER_ENABLED: 'yes' }), true);
  });
});

describe('loadSniperConfig', () => {
  it('loads strategies and allows interval override', () => {
    const config = loadSniperConfig({ env: { SNIPER_INTERVAL_MS: '5000' } });
    assert.ok(config.strategies.length >= 1);
    assert.equal(config.intervalMs, 5000);
    assert.equal(config.thresholds.heartRatio, 1.25);
  });
});

describe('processListing / runSniperCycle', () => {
  let dataDir;
  let sniperState;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sniper-cycle-'));
    sniperState = createSniperState(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('hearts a clear deal and records hearted before second pass skips', async () => {
    const hearts = [];
    const pokegradeClient = {
      evaluateImageUrl: async () => ({
        value: 100,
        graded: { psa8: 100 },
        identity: { name: 'Pikachu' },
      }),
    };

    const outcome = await processListing({
      listing: { itemId: 'm1', askPrice: 70 },
      strategy: { id: 'g8', mode: 'graded-under', grade: 8 },
      thresholds: { heartRatio: 1.25, worklistMin: 1.15, suspectRatio: 5 },
      sniperState,
      pokegradeClient,
      page: {},
      heartFn: async (_page, itemId) => {
        hearts.push(itemId);
        return { ok: true };
      },
    });

    assert.equal(outcome, 'hearted');
    assert.deepEqual(hearts, ['m1']);
    assert.equal(sniperState.isHearted('m1'), true);

    const second = await processListing({
      listing: { itemId: 'm1', askPrice: 70 },
      strategy: { id: 'g8', mode: 'graded-under', grade: 8 },
      thresholds: { heartRatio: 1.25, worklistMin: 1.15, suspectRatio: 5 },
      sniperState,
      pokegradeClient,
      page: {},
      heartFn: async () => {
        throw new Error('should not heart again');
      },
    });
    assert.equal(second, 'skip');
  });

  it('defers transient pokegrade errors without marking seen', async () => {
    const outcome = await processListing({
      listing: { itemId: 'm2', askPrice: 50 },
      strategy: { id: 'raw', mode: 'raw-crack', grade: 8 },
      thresholds: {},
      sniperState,
      pokegradeClient: {
        evaluateImageUrl: async () => {
          throw new RetryablePokegradeError('503');
        },
      },
      page: {},
    });
    assert.equal(outcome, 'deferred');
    assert.equal(sniperState.isSeen('m2'), false);
  });

  it('flags suspects without hearting', async () => {
    const hearts = [];
    const outcome = await processListing({
      listing: { itemId: 'm3', askPrice: 10 },
      strategy: { id: 'raw', mode: 'raw-crack' },
      thresholds: { heartRatio: 1.25, worklistMin: 1.15, suspectRatio: 5 },
      sniperState,
      pokegradeClient: {
        evaluateImageUrl: async () => ({ value: 100, graded: {} }),
      },
      page: {},
      heartFn: async (_p, id) => {
        hearts.push(id);
        return { ok: true };
      },
    });
    assert.equal(outcome, 'suspect');
    assert.equal(hearts.length, 0);
    assert.equal(sniperState.getStatus().suspectCount, 1);
  });

  it('runSniperCycle uses mercari mutex page and aggregates summary', async () => {
    const pages = [];
    const mercariSession = {
      withMercariPage: async (fn) => {
        const page = { id: 'page-1' };
        pages.push(page);
        return fn(page);
      },
    };

    const summary = await runSniperCycle({
      config: {
        thresholds: { heartRatio: 1.25, worklistMin: 1.15, suspectRatio: 5 },
        strategies: [{ id: 'raw', mode: 'raw-crack', query: 'pokemon psa 8', grade: 8 }],
      },
      mercariSession,
      pokegradeClient: {
        evaluateImageUrl: async () => ({ value: 100, graded: { psa8: 100 } }),
      },
      sniperState,
      scanFn: async () => [{ itemId: 'm9', askPrice: 60, href: '/item/m9/' }],
      heartFn: async () => ({ ok: true }),
    });

    assert.equal(pages.length, 1);
    assert.equal(summary.hearted, 1);
    assert.equal(sniperState.getStatus().lastCycle.hearted, 1);
  });
});
