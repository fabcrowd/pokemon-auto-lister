import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSniperState } from '../src/sniper/state.js';

describe('createSniperState', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sniper-state-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps seen and hearted separate', () => {
    const state = createSniperState(dataDir);
    state.markSeen('item-1', { action: 'skip' });
    assert.equal(state.isSeen('item-1'), true);
    assert.equal(state.isHearted('item-1'), false);
  });

  it('markHearted also marks seen and recentHearts', () => {
    const state = createSniperState(dataDir);
    state.markHearted('item-2', { ask: 50, market: 80, ratio: 1.6 });
    assert.equal(state.isHearted('item-2'), true);
    assert.equal(state.isSeen('item-2'), true);
    const status = state.getStatus();
    assert.equal(status.heartedCount, 1);
    assert.equal(status.recentHearts[0].itemId, 'item-2');
  });

  it('persists across instances', () => {
    const a = createSniperState(dataDir);
    a.markHearted('item-3', { ask: 10 });
    const b = createSniperState(dataDir);
    assert.equal(b.isHearted('item-3'), true);
  });

  it('records worklist and suspects as seen', () => {
    const state = createSniperState(dataDir);
    state.addWorklist('w1', { ratio: 1.2 });
    state.addSuspect('s1', { ratio: 6 });
    assert.equal(state.isSeen('w1'), true);
    assert.equal(state.isSeen('s1'), true);
    assert.equal(state.isHearted('w1'), false);
    const status = state.getStatus();
    assert.equal(status.worklistCount, 1);
    assert.equal(status.suspectCount, 1);
    assert.equal(status.suspects[0].itemId, 's1');
  });
});
