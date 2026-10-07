import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.js';
import { RetryablePokegradeError } from '../src/pokegrade/client.js';

const BOUNDARY = 'api-branches-boundary';

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

function request(server, { method, path: reqPath, body, headers = {} }) {
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
            // keep raw
          }
          resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
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

async function withServer(handlers, fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'server-api-'));
  const publicDir = path.join(dataDir, 'public');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<html></html>');
  const server = createServer({ dataDir, publicDir, ...handlers });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ server, dataDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// POST /api/scan

test('POST /api/scan returns 503 when scanner is not configured', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, { method: 'POST', path: '/api/scan', body: Buffer.from('') });
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /not configured/i);
  });
});

test('POST /api/scan validates multipart and photos', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({ ok: true, identity: null }),
    },
    async ({ server }) => {
      const noBoundary = await request(server, {
        method: 'POST',
        path: '/api/scan',
        body: Buffer.from('x'),
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(noBoundary.statusCode, 400);

      const empty = buildMultipartBody({ fields: { frontIndex: '0' }, files: [] });
      const noPhotos = await request(server, {
        method: 'POST',
        path: '/api/scan',
        body: empty,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': empty.length,
        },
      });
      assert.equal(noPhotos.statusCode, 400);
    },
  );
});

test('POST /api/scan maps retryable and hard identity failures', async () => {
  await withServer(
    {
      scanAndPrice: async () => {
        throw new RetryablePokegradeError('quota');
      },
    },
    async ({ server }) => {
      const body = buildMultipartBody({
        files: [
          {
            fieldName: 'photos',
            filename: 'front.jpg',
            contentType: 'image/jpeg',
            buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          },
        ],
      });
      const retryable = await request(server, {
        method: 'POST',
        path: '/api/scan',
        body,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': body.length,
        },
      });
      assert.equal(retryable.statusCode, 503);
      assert.equal(retryable.body.retryable, true);
    },
  );

  await withServer(
    {
      scanAndPrice: async () => {
        throw new Error('hard fail');
      },
    },
    async ({ server }) => {
      const body = buildMultipartBody({
        files: [
          {
            fieldName: 'photos',
            filename: 'front.jpg',
            contentType: 'image/jpeg',
            buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          },
        ],
      });
      const hard = await request(server, {
        method: 'POST',
        path: '/api/scan',
        body,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': body.length,
        },
      });
      assert.equal(hard.statusCode, 500);
      assert.match(hard.body.error, /hard fail/);
    },
  );
});

test('POST /api/scan returns scan result on success', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        identity: { name: 'Pikachu', set: 'Base Set' },
        comps: {},
        suggested: { tcgplayer: 10 },
      }),
    },
    async ({ server }) => {
      const body = buildMultipartBody({
        fields: { frontIndex: '0' },
        files: [
          {
            fieldName: 'photos',
            filename: 'front.jpg',
            contentType: 'image/jpeg',
            buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          },
        ],
      });
      const res = await request(server, {
        method: 'POST',
        path: '/api/scan',
        body,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Content-Length': body.length,
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.identity.name, 'Pikachu');
      assert.equal(res.body.frontIndex, 0);
      assert.equal(res.body.photoCount, 1);
      assert.ok(typeof res.body.scanDir === 'string');
    },
  );
});

// GET /api/collectr-status

test('GET /api/collectr-status returns defaults when collectrClient is absent', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, { method: 'GET', path: '/api/collectr-status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.exists, false);
    assert.equal(res.body.stale, true);
    assert.equal(res.body.rowCount, 0);
  });
});

test('GET /api/collectr-status returns client stats when provided', async () => {
  await withServer(
    {
      collectrClient: { stats: () => ({ exists: true, stale: false, rowCount: 42 }) },
    },
    async ({ server }) => {
      const res = await request(server, { method: 'GET', path: '/api/collectr-status' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.rowCount, 42);
      assert.equal(res.body.stale, false);
    },
  );
});

// GET /api/identity-status

test('GET /api/identity-status returns circuit and mode defaults', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, { method: 'GET', path: '/api/identity-status' });
    assert.equal(res.statusCode, 200);
    assert.ok('circuit' in res.body);
    assert.ok('mode' in res.body);
    assert.equal(res.body.circuit.open, false);
  });
});

// POST /api/pokegrade-circuit/reset

test('POST /api/pokegrade-circuit/reset returns ok and calls reset', async () => {
  let resetCalled = false;
  await withServer(
    {
      pokegradeCircuit: {
        reset: () => {
          resetCalled = true;
        },
        status: () => ({ open: false }),
      },
    },
    async ({ server }) => {
      const res = await request(server, { method: 'POST', path: '/api/pokegrade-circuit/reset' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(resetCalled, true);
    },
  );
});

// GET /api/scan-photo

test('GET /api/scan-photo returns 400 for invalid dir', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, { method: 'GET', path: '/api/scan-photo?dir=../../etc&index=0' });
    assert.equal(res.statusCode, 400);
  });
});

test('GET /api/scan-photo returns 404 when scan dir does not exist', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, { method: 'GET', path: '/api/scan-photo?dir=nonexistent-uuid&index=0' });
    assert.equal(res.statusCode, 404);
  });
});

test('GET /api/scan-photo serves saved photo by index', async () => {
  await withServer({}, async ({ server, dataDir }) => {
    const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs');
    const scanDir = path.join(dataDir, 'scans', 'test-scan-dir');
    mkdir(scanDir, { recursive: true });
    write(path.join(scanDir, '0-front.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const res = await request(server, { method: 'GET', path: '/api/scan-photo?dir=test-scan-dir&index=0' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /image\/jpeg/);
  });
});

// Static serving

test('GET / serves index.html', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, { method: 'GET', path: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
  });
});

test('unknown route returns 404', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, { method: 'GET', path: '/api/does-not-exist' });
    assert.equal(res.statusCode, 404);
  });
});

// GET /health

test('GET /health returns ok', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, { method: 'GET', path: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  });
});

// POST /detect

test('POST /detect returns 503 when scanner is not configured', async () => {
  await withServer({}, async ({ server }) => {
    const res = await request(server, {
      method: 'POST',
      path: '/detect',
      body: Buffer.from(JSON.stringify({ image_b64: 'aGVsbG8=' })),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.statusCode, 503);
  });
});

test('POST /detect returns 400 for missing image_b64', async () => {
  await withServer(
    { scanAndPrice: async () => ({ ok: true, identity: null }) },
    async ({ server }) => {
      const res = await request(server, {
        method: 'POST',
        path: '/detect',
        body: Buffer.from(JSON.stringify({})),
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.statusCode, 400);
    },
  );
});

test('POST /detect returns single card for frame when no multi-card splitter', async () => {
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const image_b64 = jpegBuffer.toString('base64');
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu', setCode: 'BS', set: 'Base Set', number: '58' },
        suggested: { tcgplayer: 12.5 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await request(server, {
        method: 'POST',
        path: '/detect',
        body: Buffer.from(JSON.stringify({ image_b64 })),
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(res.body.cards));
      assert.equal(res.body.cards.length, 1);
      const card = res.body.cards[0];
      assert.equal(card.identity.name, 'Pikachu');
      assert.equal(card.market_price, 12.5);
      assert.equal(card.price_variant, 'tcgplayer');
      assert.equal(card.confidence, 0.9);
      assert.equal(card.abstain, false);
      assert.deepEqual(card.box, [0, 0, 640, 480]);
    },
  );
});

test('POST /detect uses multiCardSplitter boxes when available', async () => {
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const image_b64 = jpegBuffer.toString('base64');
  const cropB64 = jpegBuffer.toString('base64');
  const multiCardSplitter = {
    detectRaw: async () => [
      { box: [10, 20, 110, 170], crop_b64: cropB64, index: 0 },
      { box: [120, 20, 220, 170], crop_b64: cropB64, index: 1 },
    ],
  };
  await withServer(
    {
      multiCardSplitter,
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Charizard', setCode: 'BS', set: 'Base Set', number: '4' },
        suggested: { pokegrade: 250 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await request(server, {
        method: 'POST',
        path: '/detect',
        body: Buffer.from(JSON.stringify({ image_b64 })),
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards.length, 2);
      assert.deepEqual(res.body.cards[0].box, [10, 20, 110, 170]);
      assert.deepEqual(res.body.cards[1].box, [120, 20, 220, 170]);
      assert.equal(res.body.cards[0].identity.name, 'Charizard');
      assert.equal(res.body.cards[0].market_price, 250);
    },
  );
});
