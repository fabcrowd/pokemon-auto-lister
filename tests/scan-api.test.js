import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQueue } from '../src/queue/queue.js';
import { createServer } from '../src/server.js';
import { listPricingSources, scanAndPrice } from '../src/scan/scanAndPrice.js';

const BOUNDARY = 'scan-boundary';

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
          resolve({ statusCode: res.statusCode, body: parsed });
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

test('listPricingSources picks numeric comps', () => {
  assert.deepEqual(
    listPricingSources(
      { pokegrade: 10, justtcg: 11, collectr: null, ebay: 9.5 },
      { value: 10 },
    ),
    ['pokegrade', 'ebay', 'justtcg'],
  );
});

test('listPricingSources fills pokegrade from result and accepts object markets', () => {
  assert.deepEqual(
    listPricingSources(
      { collectr: { market: 8 }, tcgplayer: { mid: 7.5 }, rapidapi: { price: 6 }, pokewallet: { usd: 5 } },
      { value: 9 },
    ),
    ['pokegrade', 'collectr', 'tcgplayer', 'rapidapi', 'pokewallet'],
  );
  assert.deepEqual(listPricingSources(null), []);
  assert.deepEqual(listPricingSources({ ebay: { nonsense: true } }), []);
});

test('scanAndPrice returns identity + comps from clients', async () => {
  const identity = { name: 'Pikachu', setCode: 'base1', number: '58' };
  const result = await scanAndPrice({
    frontImagePath: '/tmp/front.jpg',
    pokegradeClient: {
      evaluateFrontImage: async () => ({
        identity,
        value: 12,
        confidence: 'high',
        grading: null,
      }),
    },
    justTcgClient: {
      getMarketPrice: async () => ({ market: 11.5 }),
    },
    collectrClient: {
      getMarketPrice: async () => ({ market: 12.2 }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.identity.name, 'Pikachu');
  assert.equal(result.comps.justtcg, 11.5);
  assert.equal(result.comps.collectr, 12.2);
  assert.ok(result.pricingSources.includes('justtcg'));
  assert.ok(result.suggested?.mercari);
});

test('scanAndPrice rejects missing front and missing identity client', async () => {
  const missingFront = await scanAndPrice({});
  assert.equal(missingFront.ok, false);
  assert.match(missingFront.reason, /no full-card photo/);

  const missingClient = await scanAndPrice({ frontImagePath: '/tmp/front.jpg' });
  assert.equal(missingClient.ok, false);
  assert.match(missingClient.reason, /no identity client/);
});

test('scanAndPrice uses identityResolver local-only and forces review on conflict', async () => {
  const identity = { name: 'Charizard', setCode: 'base1', number: '4' };
  const solo = await scanAndPrice({
    frontImagePath: '/tmp/front.jpg',
    identityResolver: {
      evaluateFrontImage: async () => ({
        mode: 'local-only',
        identity,
        pokegrade: null,
        vellum: { identity, grading: { overall: 8 } },
        identities: { vellum: identity },
        identityConflict: false,
        localAbstained: false,
        pokegradeSkipped: true,
        reason: null,
      }),
    },
    justTcgClient: { getMarketPrice: async () => ({ market: 400 }) },
  });
  assert.equal(solo.ok, true);
  assert.equal(solo.idSource, 'vellum-ai-solo');
  assert.equal(solo.grading?.overall, 8);

  const conflict = await scanAndPrice({
    frontImagePath: '/tmp/front.jpg',
    identityResolver: {
      evaluateFrontImage: async () => ({
        mode: 'dual',
        identity,
        pokegrade: { identity, value: 10 },
        vellum: { identity: { name: 'Blastoise', setCode: 'base1', number: '2' } },
        identities: { pokegrade: identity },
        identityConflict: true,
        localAbstained: false,
        pokegradeSkipped: false,
        reason: 'identity sources disagree',
      }),
    },
    collectrClient: { getMarketPrice: async () => ({ market: 10 }) },
  });
  assert.equal(conflict.action, 'needs_review');
  assert.match(conflict.reason, /disagree/i);
  assert.equal(conflict.idSource, 'dual');
});

test('scanAndPrice notes Vellum abstain and swallows comps errors', async () => {
  const identity = { name: 'Mew', setCode: 'promo', number: '1' };
  const result = await scanAndPrice({
    frontImagePath: '/tmp/front.jpg',
    identityResolver: {
      evaluateFrontImage: async () => ({
        mode: 'dual',
        identity,
        pokegrade: { identity, value: 20, grading: null },
        vellum: null,
        identities: { pokegrade: identity },
        identityConflict: false,
        localAbstained: true,
        pokegradeSkipped: false,
        reason: null,
      }),
    },
    collectrClient: { getMarketPrice: async () => ({ market: 20 }) },
    tcgplayerClient: {
      getMarketPrice: async () => {
        throw new Error('tcg down');
      },
    },
    ebaySoldsClient: {
      getRecentSolds: async () => {
        throw new Error('ebay down');
      },
    },
    rapidPokemonTcgClient: {
      getMarketPrice: async () => {
        throw new Error('rapid down');
      },
    },
    justTcgClient: {
      getMarketPrice: async () => {
        throw new Error('just down');
      },
    },
    pokeWalletClient: {
      getMarketPrice: async () => {
        throw new Error('wallet down');
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'auto');
  assert.match(result.reason, /VellumAI abstained/);
});

test('scanAndPrice returns needs_review when identity is null', async () => {
  const result = await scanAndPrice({
    frontImagePath: '/tmp/front.jpg',
    identityResolver: {
      evaluateFrontImage: async () => ({
        mode: 'local-only',
        identity: null,
        pokegrade: null,
        vellum: null,
        identities: {},
        identityConflict: false,
        localAbstained: true,
        pokegradeSkipped: true,
        reason: 'no_card_detected',
      }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'needs_review');
  assert.equal(result.idSource, 'vellum-ai-solo');
  assert.match(result.reason, /no_card_detected/);
});

test('scanAndPrice returns error envelope for non-retryable identity failures', async () => {
  const result = await scanAndPrice({
    frontImagePath: '/tmp/front.jpg',
    pokegradeClient: {
      evaluateFrontImage: async () => {
        throw new Error('boom');
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'error');
  assert.equal(result.error, true);
  assert.match(result.reason, /boom/);
});

test('POST /api/scan identifies and returns pricingSources', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'scan-api-'));
  const publicDir = mkdtempSync(path.join(tmpdir(), 'scan-pub-'));
  writeFileSync(path.join(publicDir, 'index.html'), '<html></html>');
  const queue = createQueue(dataDir);
  const identity = { name: 'Charizard', setCode: 'base1', number: '4' };

  const server = createServer({
    queue,
    dataDir,
    publicDir,
    scanAndPrice: async () => ({
      ok: true,
      identity,
      identities: { pokegrade: identity },
      identityConflict: false,
      comps: { pokegrade: 200, justtcg: 195, collectr: 198 },
      suggested: { mercari: 198, ebay: 198 },
      reason: 'sources agree',
      action: 'auto',
      grading: null,
      mode: 'pokegrade-only',
      idSource: 'pokegrade',
      pricingSources: ['pokegrade', 'justtcg', 'collectr'],
    }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
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
    assert.equal(res.body.ok, true);
    assert.equal(res.body.identity.name, 'Charizard');
    assert.ok(res.body.pricingSources.includes('justtcg'));
    assert.equal(res.body.officialArtUrl, 'https://images.pokemontcg.io/base1/4_hires.png');
    assert.equal(res.body.suggested.mercari, 198);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  }
});
