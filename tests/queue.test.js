import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';

function withTempQueue(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'queue-test-'));
  try {
    return fn(createQueue(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('enqueue persists a card under data/queue and returns an id', () => {
  withTempQueue((queue, dir) => {
    const id = queue.enqueue({ title: 'Charizard' });
    assert.ok(typeof id === 'string' && id.length > 0);
    const record = queue.get(id);
    assert.equal(record.title, 'Charizard');
    assert.equal(record.status, 'queued');
    assert.ok(existsSync(path.join(dir, 'queue', `${id}.json`)));
  });
});

test('setStatus transitions through all defined states', () => {
  withTempQueue((queue) => {
    const id = queue.enqueue({ title: 'Blastoise' });
    for (const status of ['pricing', 'needs_review', 'drafting', 'drafted', 'listed', 'error']) {
      const record = queue.setStatus(id, status);
      assert.equal(record.status, status);
    }
    assert.throws(() => queue.setStatus(id, 'not_a_real_status'));
  });
});

test('markDrafted is idempotent per marketplace', () => {
  withTempQueue((queue) => {
    const id = queue.enqueue({ title: 'Venusaur' });
    const first = queue.markDrafted(id, 'mercari', { draftId: 'abc123' });
    assert.equal(first.drafts.mercari.created, true);
    assert.equal(first.drafts.mercari.draftId, 'abc123');

    const second = queue.markDrafted(id, 'mercari', { draftId: 'should-not-apply' });
    assert.equal(second.drafts.mercari.draftId, 'abc123');
  });
});

test('markListed records listingUrl and sets status listed', () => {
  withTempQueue((queue) => {
    const id = queue.enqueue({ title: 'Mewtwo' });
    const listed = queue.markListed(id, 'mercari', {
      listingUrl: 'https://www.mercari.com/item/m123/',
    });
    assert.equal(listed.status, 'listed');
    assert.equal(listed.drafts.mercari.created, true);
    assert.equal(listed.drafts.mercari.listingUrl, 'https://www.mercari.com/item/m123/');
    assert.ok(listed.drafts.mercari.listedAt);
  });
});

test('crash mid-draft leaves the card retryable without losing priced cache', () => {
  withTempQueue((queue, dir) => {
    const id = queue.enqueue({ title: 'Pikachu' });
    queue.setPriced(id, { pg: 10, tcg: 12, ebay: 11 });
    queue.setStatus(id, 'drafting');

    const reopened = createQueue(dir);
    const record = reopened.get(id);
    assert.deepEqual(record.pricedCache, { pg: 10, tcg: 12, ebay: 11 });
    assert.equal(record.status, 'drafting');

    const afterDraft = reopened.markDrafted(id, 'ebay', { draftId: 'ebay-1' });
    assert.deepEqual(afterDraft.pricedCache, { pg: 10, tcg: 12, ebay: 11 });
  });
});

test('listByStatus filters correctly for dashboard stats', () => {
  withTempQueue((queue) => {
    const queuedId = queue.enqueue({ title: 'Squirtle' });
    const reviewId = queue.enqueue({ title: 'Bulbasaur' });
    queue.setStatus(reviewId, 'needs_review');

    const queued = queue.listByStatus('queued');
    const needsReview = queue.listByStatus('needs_review');

    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, queuedId);
    assert.equal(needsReview.length, 1);
    assert.equal(needsReview[0].id, reviewId);
  });
});
