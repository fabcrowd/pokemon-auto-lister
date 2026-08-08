import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { createServer, resolveListenOptions } from '../src/server.js';

const BOUNDARY = 'test-boundary-1234';

function buildMultipartBody({ fields = {}, files = [] }) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'binary'),
    );
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        'binary',
      ),
    );
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n', 'binary'));
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'binary'));
  return Buffer.concat(parts);
}

function requestJson(server, { method, path: reqPath, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // leave as raw text (e.g. static HTML)
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function withServer(fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'server-test-data-'));
  const publicDir = mkdtempSync(path.join(tmpdir(), 'server-test-public-'));
  writeFileSync(path.join(publicDir, 'index.html'), '<html><body>dashboard</body></html>');

  const queue = createQueue(dataDir);
  const server = createServer({ queue, dataDir, publicDir });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ server, queue, dataDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  }
}

test('resolveListenOptions defaults to 0.0.0.0 and 3000', () => {
  assert.deepEqual(resolveListenOptions({}), { host: '0.0.0.0', port: 3000 });
});

test('resolveListenOptions honors HOST/PORT env overrides', () => {
  assert.deepEqual(resolveListenOptions({ HOST: '127.0.0.1', PORT: '4000' }), { host: '127.0.0.1', port: 4000 });
});

test('POST /api/cards enqueues a card from multipart photos and returns its id', async () => {
  await withServer(async ({ server, queue, dataDir }) => {
    const body = buildMultipartBody({
      fields: { frontIndex: '0', mercari: 'true', ebay: 'false' },
      files: [
        { fieldName: 'photos', filename: 'front.jpg', contentType: 'image/jpeg', buffer: Buffer.from('front-bytes') },
        { fieldName: 'photos', filename: 'back.jpg', contentType: 'image/jpeg', buffer: Buffer.from('back-bytes') },
      ],
    });

    const res = await requestJson(server, {
      method: 'POST',
      path: '/api/cards',
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
        'Content-Length': body.length,
      },
    });

    assert.equal(res.statusCode, 201);
    assert.ok(typeof res.body.id === 'string' && res.body.id.length > 0);

    const record = queue.get(res.body.id);
    assert.equal(record.status, 'queued');
    assert.equal(record.mercari, true);
    assert.equal(record.ebay, false);
    assert.ok(existsSync(record.frontImagePath));

    const uploadsDir = path.join(dataDir, 'uploads');
    assert.ok(existsSync(uploadsDir));
  });
});

test('POST /api/cards rejects zero photos', async () => {
  await withServer(async ({ server }) => {
    const body = buildMultipartBody({ fields: { frontIndex: '0' }, files: [] });
    const res = await requestJson(server, {
      method: 'POST',
      path: '/api/cards',
      body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
  });
});

test('POST /api/cards rejects a missing frontIndex', async () => {
  await withServer(async ({ server }) => {
    const body = buildMultipartBody({
      fields: {},
      files: [{ fieldName: 'photos', filename: 'front.jpg', contentType: 'image/jpeg', buffer: Buffer.from('x') }],
    });
    const res = await requestJson(server, {
      method: 'POST',
      path: '/api/cards',
      body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
  });
});

test('POST /api/cards fires onEnqueue with the new card id', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'server-test-data-'));
  const publicDir = mkdtempSync(path.join(tmpdir(), 'server-test-public-'));
  try {
    const queue = createQueue(dataDir);
    let enqueuedId = null;
    let resolveCalled;
    const called = new Promise((resolve) => {
      resolveCalled = resolve;
    });
    const server = createServer({
      queue,
      dataDir,
      publicDir,
      onEnqueue: async (id) => {
        enqueuedId = id;
        resolveCalled();
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const body = buildMultipartBody({
      fields: { frontIndex: '0' },
      files: [{ fieldName: 'photos', filename: 'front.jpg', contentType: 'image/jpeg', buffer: Buffer.from('x') }],
    });
    const res = await requestJson(server, {
      method: 'POST',
      path: '/api/cards',
      body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
    });

    await called;
    assert.equal(enqueuedId, res.body.id);

    await new Promise((resolve) => server.close(resolve));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  }
});

test('GET /api/stats aggregates queue, needsReview, errors, drafts, allTime, totalListValue', async () => {
  await withServer(async ({ server, queue }) => {
    const queuedId = queue.enqueue({ title: 'Squirtle' });
    void queuedId;

    const reviewId = queue.enqueue({ title: 'Bulbasaur' });
    queue.setStatus(reviewId, 'needs_review');

    const errorId = queue.enqueue({ title: 'Charmander' });
    queue.setStatus(errorId, 'error');

    const draftedId = queue.enqueue({ title: 'Pikachu' });
    queue.setPriced(draftedId, { identity: {}, comps: {}, suggested: { mercari: 40, ebay: 45 } });
    queue.setStatus(draftedId, 'drafted');

    const res = await requestJson(server, { method: 'GET', path: '/api/stats' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.queue, 1);
    assert.equal(res.body.needsReview, 1);
    assert.equal(res.body.errors, 1);
    assert.equal(res.body.drafts, 1);
    assert.equal(res.body.allTime, 4);
    assert.equal(res.body.totalListValue, 45);
  });
});

test('GET /api/cards supports status filter', async () => {
  await withServer(async ({ server, queue }) => {
    const queuedId = queue.enqueue({ title: 'Squirtle' });
    const reviewId = queue.enqueue({ title: 'Bulbasaur' });
    queue.setStatus(reviewId, 'needs_review');

    const all = await requestJson(server, { method: 'GET', path: '/api/cards' });
    assert.equal(all.body.length, 2);

    const filtered = await requestJson(server, { method: 'GET', path: '/api/cards?status=needs_review' });
    assert.equal(filtered.body.length, 1);
    assert.equal(filtered.body[0].id, reviewId);

    const queued = await requestJson(server, { method: 'GET', path: '/api/cards?status=queued' });
    assert.equal(queued.body.length, 1);
    assert.equal(queued.body[0].id, queuedId);
  });
});

test('serves static files from the configured public directory', async () => {
  await withServer(async ({ server }) => {
    const res = await requestJson(server, { method: 'GET', path: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /dashboard/);
  });
});

test('unknown API route returns 404', async () => {
  await withServer(async ({ server }) => {
    const res = await requestJson(server, { method: 'GET', path: '/api/does-not-exist' });
    assert.equal(res.statusCode, 404);
  });
});
