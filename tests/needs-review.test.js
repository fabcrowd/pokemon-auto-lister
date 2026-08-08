import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { createServer } from '../src/server.js';

function requestJson(server, { method, path: reqPath, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: payload ? { 'Content-Type': 'application/json', ...headers } : headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // leave as raw text
          }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function withServer(fn, { createDraft } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'needs-review-test-data-'));
  const publicDir = mkdtempSync(path.join(tmpdir(), 'needs-review-test-public-'));

  const queue = createQueue(dataDir);
  const server = createServer({ queue, dataDir, publicDir, createDraft });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ server, queue, dataDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  }
}

function needsReviewRecord(queue) {
  const id = queue.enqueue({ title: 'Charizard', mercari: true, ebay: false });
  queue.setPriced(id, {
    identity: { name: 'Charizard' },
    comps: { pokegrade: 100, tcgplayer: 80, ebay: 90 },
    suggested: { mercari: 90, ebay: 90 },
  });
  queue.setStatus(id, 'needs_review');
  return id;
}

test('POST /api/cards/:id/confirm updates the suggested price and moves the card to drafting', async () => {
  const draftCalls = [];
  await withServer(
    async ({ server, queue }) => {
      const id = needsReviewRecord(queue);

      const res = await requestJson(server, {
        method: 'POST',
        path: `/api/cards/${id}/confirm`,
        body: { price: 120 },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'drafting');

      const record = queue.get(id);
      assert.equal(record.status, 'drafting');
      assert.equal(record.pricedCache.suggested.mercari, 120);
      assert.equal(record.pricedCache.suggested.ebay, 120);
    },
    {
      createDraft: async (marketplace, record) => {
        draftCalls.push({ marketplace, id: record.id });
      },
    },
  );

  assert.deepEqual(draftCalls, [{ marketplace: 'mercari', id: draftCalls[0]?.id }]);
});

test('POST /api/cards/:id/confirm rejects an invalid price and leaves the card in needs_review', async () => {
  await withServer(async ({ server, queue }) => {
    const id = needsReviewRecord(queue);

    const res = await requestJson(server, {
      method: 'POST',
      path: `/api/cards/${id}/confirm`,
      body: { price: -5 },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.equal(queue.get(id).status, 'needs_review');
  });
});

test('POST /api/cards/:id/confirm rejects a card that is not awaiting review', async () => {
  await withServer(async ({ server, queue }) => {
    const id = queue.enqueue({ title: 'Squirtle' });

    const res = await requestJson(server, {
      method: 'POST',
      path: `/api/cards/${id}/confirm`,
      body: { price: 50 },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
  });
});

test('POST /api/cards/:id/skip marks the card as error without creating drafts', async () => {
  const draftCalls = [];
  await withServer(
    async ({ server, queue }) => {
      const id = needsReviewRecord(queue);

      const res = await requestJson(server, { method: 'POST', path: `/api/cards/${id}/skip` });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'error');
      assert.equal(queue.get(id).status, 'error');
    },
    { createDraft: async (marketplace, record) => draftCalls.push({ marketplace, id: record.id }) },
  );

  assert.deepEqual(draftCalls, []);
});

test('POST /api/cards/:id/confirm returns 404 for an unknown card', async () => {
  await withServer(async ({ server }) => {
    const res = await requestJson(server, {
      method: 'POST',
      path: '/api/cards/does-not-exist/confirm',
      body: { price: 50 },
    });

    assert.equal(res.statusCode, 404);
    assert.ok(res.body.error);
  });
});
