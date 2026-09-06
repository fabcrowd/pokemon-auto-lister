import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createQueue } from '../src/queue/queue.js';
import { createServer } from '../src/server.js';

function requestJson(server, { method, path: reqPath, body }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          });
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

test('POST /api/mercari/connect starts login and status reports connecting', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mercari-connect-'));
  const publicDir = path.join(dir, 'public');
  writeFileSync(path.join(dir, 'index-placeholder'), '');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<html></html>');

  let connectCalls = 0;
  let resolveConnect;
  const connectGate = new Promise((resolve) => {
    resolveConnect = resolve;
  });

  const mercariSession = {
    getStatus: () => ({ loggedIn: false, browserOpen: true }),
    connect: async () => {
      connectCalls += 1;
      await connectGate;
      return { loggedIn: true, browserOpen: true };
    },
  };

  const queue = createQueue(dir);
  const server = createServer({ queue, dataDir: dir, publicDir, mercariSession });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const started = await requestJson(server, { method: 'POST', path: '/api/mercari/connect' });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.connecting, true);
    assert.equal(connectCalls, 1);

    const status = await requestJson(server, { method: 'GET', path: '/api/mercari/status' });
    assert.equal(status.body.connecting, true);

    resolveConnect();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    resolveConnect?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/ebay/connect probes OAuth via draft client', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ebay-connect-'));
  const publicDir = path.join(dir, 'public');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<html></html>');

  const ebayDraftClient = {
    getStatus: () => ({ configured: true, connected: true, at: 'now' }),
    connect: async () => ({ configured: true, connected: true, at: 'now' }),
  };

  const queue = createQueue(dir);
  const server = createServer({ queue, dataDir: dir, publicDir, ebayDraftClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const result = await requestJson(server, { method: 'POST', path: '/api/ebay/connect' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.connected, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
