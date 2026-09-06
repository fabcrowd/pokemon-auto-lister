import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createQueue } from '../src/queue/queue.js';
import { createServer } from '../src/server.js';
import { createPokegradeCircuit } from '../src/pokegrade/circuit.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(port);
    });
  });
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(body || '{}') });
      });
    }).on('error', reject);
  });
}

function postJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST' },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: JSON.parse(body || '{}') });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/identity-status and circuit reset', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'id-status-'));
  try {
    const queue = createQueue(dir);
    const circuit = createPokegradeCircuit({ dataDir: dir, ttlHours: 1 });
    circuit.open('quota-test');
    const server = createServer({ queue, dataDir: dir, pokegradeCircuit: circuit });
    const port = await listen(server);
    const status = await getJson(port, '/api/identity-status');
    assert.equal(status.status, 200);
    assert.equal(status.body.solo, true);
    assert.equal(status.body.circuit.open, true);
    const reset = await postJson(port, '/api/pokegrade-circuit/reset');
    assert.equal(reset.body.ok, true);
    assert.equal(reset.body.circuit.open, false);
    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
