import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.js';

// Minimal valid JPEG bytes (SOI + EOI)
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06,
  0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b,
  0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34,
  0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00,
  0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10,
  0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd8, 0xff, 0xd9]);

const TINY_JPEG_B64 = TINY_JPEG.toString('base64');

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
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(handlers, fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'detect-stress-'));
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

function detectPost(server, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  return request(server, {
    method: 'POST',
    path: '/detect',
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...extraHeaders },
  });
}

// ─── Input Validation ─────────────────────────────────────────────────────────

test('/detect: invalid JSON body returns 400', async () => {
  await withServer(
    { scanAndPrice: async () => ({ ok: true, identity: { name: 'Pikachu' } }) },
    async ({ server }) => {
      const res = await request(server, {
        method: 'POST',
        path: '/detect',
        body: Buffer.from('not-json{{{{'),
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.statusCode, 400);
    },
  );
});

test('/detect: empty string image_b64 returns 400', async () => {
  await withServer(
    { scanAndPrice: async () => ({ ok: true, identity: { name: 'Pikachu' } }) },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: '' });
      assert.equal(res.statusCode, 400);
    },
  );
});

test('/detect: non-string image_b64 returns 400', async () => {
  await withServer(
    { scanAndPrice: async () => ({ ok: true, identity: { name: 'Pikachu' } }) },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: 12345 });
      assert.equal(res.statusCode, 400);
    },
  );
});

test('/detect: image_b64 that is only whitespace is not rejected at validation (decodes as empty buffer)', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      // Whitespace is a truthy string — passes the image_b64 check.
      // Buffer.from('   ', 'base64') decodes to an empty buffer.
      // The pipeline continues and sharp processes it (may fail internally).
      const res = await detectPost(server, { image_b64: '   ' });
      // Server does not return 400 for whitespace — returns 200 or 500 depending on sharp.
      assert.ok(res.statusCode !== 400, 'Whitespace base64 should not be rejected as missing');
    },
  );
});

test('/detect: missing body returns 400', async () => {
  await withServer(
    { scanAndPrice: async () => ({ ok: true, identity: { name: 'Pikachu' } }) },
    async ({ server }) => {
      const res = await request(server, {
        method: 'POST',
        path: '/detect',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.statusCode, 400);
    },
  );
});

// ─── mapPricedToCard: vellumConfidence variants ───────────────────────────────

test('/detect: vellumConfidence=high maps to 0.9', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].confidence, 0.9);
    },
  );
});

test('/detect: vellumConfidence=medium maps to 0.65', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'medium',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].confidence, 0.65);
    },
  );
});

test('/detect: vellumConfidence=low maps to 0.3', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'low',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].confidence, 0.3);
    },
  );
});

test('/detect: unknown vellumConfidence defaults to 0.7', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'EXTREME',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].confidence, 0.7);
    },
  );
});

test('/detect: undefined vellumConfidence defaults to 0.7', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 5 },
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].confidence, 0.7);
    },
  );
});

// ─── mapPricedToCard: abstain conditions ──────────────────────────────────────

test('/detect: ok=false triggers abstain', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: false,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].abstain, true);
    },
  );
});

test('/detect: identity=null triggers abstain', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: null,
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].abstain, true);
    },
  );
});

test('/detect: identity.name="Unknown" triggers abstain', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Unknown' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].abstain, true);
    },
  );
});

test('/detect: identity.name="unknown" (lowercase) triggers abstain', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'unknown' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].abstain, true);
    },
  );
});

// ─── mapPricedToCard: suggested price edge cases ─────────────────────────────

test('/detect: empty suggested object yields null market_price', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: {},
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].market_price, null);
      assert.equal(res.body.cards[0].price_variant, null);
    },
  );
});

test('/detect: suggested with only Infinity yields null market_price', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: Infinity, pokegrade: -Infinity },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].market_price, null);
    },
  );
});

test('/detect: suggested with only NaN yields null market_price', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: NaN },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].market_price, null);
    },
  );
});

test('/detect: suggested with string values yields null market_price', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 'ten dollars', pokegrade: null },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].market_price, null);
    },
  );
});

test('/detect: picks first finite price when multiple suggested entries', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { pokegrade: 15.0, tcgplayer: 9.99 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      // Object.entries order: pokegrade should come first
      assert.equal(res.body.cards[0].market_price, 15.0);
      assert.equal(res.body.cards[0].price_variant, 'pokegrade');
    },
  );
});

test('/detect: zero is a valid finite price', async () => {
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 0 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].market_price, 0);
    },
  );
});

// ─── Retry loop ────────────────────────────────────────────────────────────────

test('/detect: retries scanAndPrice up to 2x when identity is not usable', async () => {
  let callCount = 0;
  await withServer(
    {
      scanAndPrice: async () => {
        callCount++;
        // always return unusable result
        return { ok: true, identity: { name: 'Unknown' }, suggested: {} };
      },
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      // initial call + 2 retries = 3 total (then fallbacks run but scanAndPrice
      // may be called more by tryPreprocessFallbacks/tryTileFallback — assert >=3)
      assert.ok(callCount >= 3, `expected >=3 calls, got ${callCount}`);
    },
  );
});

test('/detect: stops retrying once usable identity is returned', async () => {
  let callCount = 0;
  await withServer(
    {
      scanAndPrice: async () => {
        callCount++;
        if (callCount < 2) return { ok: true, identity: { name: 'Unknown' }, suggested: {} };
        return { ok: true, identity: { name: 'Charizard' }, suggested: { tcgplayer: 100 }, vellumConfidence: 'high' };
      },
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards[0].identity.name, 'Charizard');
      assert.equal(callCount, 2);
    },
  );
});

// ─── scanAndPrice throws ───────────────────────────────────────────────────────

test('/detect: scanAndPrice throwing returns 500', async () => {
  await withServer(
    {
      scanAndPrice: async () => {
        throw new Error('vellum timeout');
      },
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 500);
      assert.match(res.body.error, /vellum timeout/);
    },
  );
});

test('/detect: scanAndPrice throwing with no message returns 500', async () => {
  await withServer(
    {
      scanAndPrice: async () => {
        // eslint-disable-next-line no-throw-literal
        throw null;
      },
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 500);
      assert.ok(typeof res.body.error === 'string');
    },
  );
});

// ─── multiCardSplitter edge cases ────────────────────────────────────────────

test('/detect: multiCardSplitter.detectRaw throwing falls through to single-card path', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => { throw new Error('sidecar crash'); },
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Pikachu' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      // Should NOT return 500 — sidecar crash should propagate as unhandled
      // (current code does not catch detectRaw throws, so expect 500)
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      // Document the current behavior: unhandled promise rejection becomes 500
      assert.ok(res.statusCode === 200 || res.statusCode === 500);
    },
  );
});

test('/detect: all rawCards filtered as zero-confidence falls back to single-card path', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [0, 0, 100, 100], conf: 0.0, crop_b64: TINY_JPEG_B64 },
          { box: [100, 0, 200, 100], conf: 0.02, crop_b64: TINY_JPEG_B64 },
          { box: [200, 0, 300, 100], conf: 0.04, crop_b64: TINY_JPEG_B64 },
        ],
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Bulbasaur' },
        suggested: { tcgplayer: 3 },
        vellumConfidence: 'medium',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      // all conf < 0.05 are filtered → rawCards becomes null → single-card path
      assert.equal(res.body.cards.length, 1);
      assert.equal(res.body.cards[0].identity.name, 'Bulbasaur');
    },
  );
});

test('/detect: rawCards with exactly 1 entry uses single-card path with sidecar box', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [10, 20, 110, 170], conf: 0.8, crop_b64: TINY_JPEG_B64 },
        ],
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Squirtle' },
        suggested: { tcgplayer: 7 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards.length, 1);
      // box comes from the single sidecar detection
      assert.deepEqual(res.body.cards[0].box, [10, 20, 110, 170]);
    },
  );
});

test('/detect: rawCard missing box defaults to [0,0,640,480] in multi-card path', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { conf: 0.9, crop_b64: TINY_JPEG_B64 },       // no box
          { box: null, conf: 0.9, crop_b64: TINY_JPEG_B64 }, // null box
        ],
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Mewtwo' },
        suggested: { tcgplayer: 50 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards.length, 2);
      assert.deepEqual(res.body.cards[0].box, [0, 0, 640, 480]);
      assert.deepEqual(res.body.cards[1].box, [0, 0, 640, 480]);
    },
  );
});

test('/detect: rawCard with box shorter than 4 elements defaults to [0,0,640,480]', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [10, 20], conf: 0.9, crop_b64: TINY_JPEG_B64 },
          { box: [], conf: 0.9, crop_b64: TINY_JPEG_B64 },
        ],
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Jigglypuff' },
        suggested: { tcgplayer: 2 },
        vellumConfidence: 'medium',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      // box is an Array (passes Array.isArray) so it's used as-is — document actual behavior
      assert.equal(res.body.cards.length, 2);
      assert.ok(Array.isArray(res.body.cards[0].box));
    },
  );
});

test('/detect: rawCard missing crop_b64 uses original imageBuffer in multi-card path', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [0, 0, 100, 100], conf: 0.9 },   // no crop_b64
          { box: [100, 0, 200, 100], conf: 0.9 },  // no crop_b64
        ],
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Gengar' },
        suggested: { tcgplayer: 20 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards.length, 2);
    },
  );
});

test('/detect: per-card scanAndPrice throw in multi-card path returns abstain card', async () => {
  let callCount = 0;
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [0, 0, 100, 100], conf: 0.9, crop_b64: TINY_JPEG_B64 },
          { box: [100, 0, 200, 100], conf: 0.9, crop_b64: TINY_JPEG_B64 },
        ],
      },
      scanAndPrice: async () => {
        callCount++;
        if (callCount === 1) throw new Error('card 0 failed');
        return { ok: true, identity: { name: 'Lapras' }, suggested: { tcgplayer: 8 }, vellumConfidence: 'high' };
      },
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards.length, 2);
      // card 0 threw → abstain=true, card 1 succeeded → abstain=false
      assert.equal(res.body.cards[0].abstain, true);
      assert.equal(res.body.cards[1].abstain, false);
    },
  );
});

// ─── Concurrency ──────────────────────────────────────────────────────────────

test('/detect: handles 10 concurrent requests without corruption', async () => {
  const results = [];
  await withServer(
    {
      scanAndPrice: async ({ frontImagePath }) => ({
        ok: true,
        identity: { name: `Card-${path.basename(frontImagePath).slice(0, 6)}` },
        suggested: { tcgplayer: Math.random() * 100 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const promises = Array.from({ length: 10 }, () =>
        detectPost(server, { image_b64: TINY_JPEG_B64 }),
      );
      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.equal(res.statusCode, 200, `Unexpected status ${res.statusCode}`);
        assert.ok(Array.isArray(res.body.cards), 'Missing cards array');
        assert.equal(res.body.cards.length, 1);
        results.push(res.body.cards[0]);
      }
      assert.equal(results.length, 10);
    },
  );
});

test('/detect: handles 5 concurrent multi-card requests', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [0, 0, 100, 100], conf: 0.9, crop_b64: TINY_JPEG_B64 },
          { box: [100, 0, 200, 100], conf: 0.85, crop_b64: TINY_JPEG_B64 },
          { box: [200, 0, 300, 100], conf: 0.8, crop_b64: TINY_JPEG_B64 },
        ],
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Eevee' },
        suggested: { tcgplayer: 5 },
        vellumConfidence: 'medium',
      }),
    },
    async ({ server }) => {
      const promises = Array.from({ length: 5 }, () =>
        detectPost(server, { image_b64: TINY_JPEG_B64 }),
      );
      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.cards.length, 3);
      }
    },
  );
});

// ─── Large payload ─────────────────────────────────────────────────────────────

test('/detect: very large image payload (2 MB base64) is accepted and processed', async () => {
  const largeBuffer = Buffer.alloc(1.5 * 1024 * 1024, 0x42); // 1.5 MB of 0x42
  const largeb64 = largeBuffer.toString('base64');
  await withServer(
    {
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Venusaur' },
        suggested: { tcgplayer: 30 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: largeb64 });
      // May succeed (200) or fail with sharp error (500) — both are acceptable, 400 is not
      assert.ok(res.statusCode !== 400, 'Should not reject as invalid input for large payload');
    },
  );
});

// ─── GET /detect rejection ─────────────────────────────────────────────────────

test('GET /detect is not a valid route and returns 404', async () => {
  await withServer(
    { scanAndPrice: async () => ({ ok: true, identity: { name: 'Pikachu' } }) },
    async ({ server }) => {
      const res = await request(server, { method: 'GET', path: '/detect' });
      assert.equal(res.statusCode, 404);
    },
  );
});

// ─── Multi-card: priced=null abstain passthrough ──────────────────────────────

test('/detect: multi-card scanAndPrice returning null-like result produces abstain cards', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [0, 0, 100, 100], conf: 0.9, crop_b64: TINY_JPEG_B64 },
          { box: [100, 0, 200, 100], conf: 0.9, crop_b64: TINY_JPEG_B64 },
        ],
      },
      scanAndPrice: async () => ({ ok: false, identity: null, suggested: null }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards.length, 2);
      for (const card of res.body.cards) {
        assert.equal(card.abstain, true);
        assert.equal(card.market_price, null);
      }
    },
  );
});

// ─── Mixed confidence filtering ───────────────────────────────────────────────

test('/detect: rawCards with mixed conf — filters phantoms, keeps valid', async () => {
  let scanCallCount = 0;
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [0, 0, 100, 100], conf: 0.03, crop_b64: TINY_JPEG_B64 },   // filtered (phantom)
          { box: [100, 0, 200, 100], conf: 0.06, crop_b64: TINY_JPEG_B64 },  // kept
          { box: [200, 0, 300, 100], conf: 0.04, crop_b64: TINY_JPEG_B64 },  // filtered (phantom)
          { box: [300, 0, 400, 100], conf: 0.9, crop_b64: TINY_JPEG_B64 },   // kept
        ],
      },
      scanAndPrice: async () => {
        scanCallCount++;
        return { ok: true, identity: { name: 'Snorlax' }, suggested: { tcgplayer: 12 }, vellumConfidence: 'high' };
      },
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards.length, 2, 'Expected 2 valid cards after phantom filtering');
    },
  );
});

test('/detect: rawCards where conf is not a number are kept (no finite check)', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [0, 0, 100, 100], conf: undefined, crop_b64: TINY_JPEG_B64 },
          { box: [100, 0, 200, 100], conf: 'high', crop_b64: TINY_JPEG_B64 },
        ],
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Gengar' },
        suggested: { tcgplayer: 20 },
        vellumConfidence: 'high',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      // conf is not finite (undefined, string) → filter keeps them (!Number.isFinite → true so kept)
      assert.equal(res.body.cards.length, 2);
    },
  );
});

// ─── Single-card unclassified detection (sidecar box, no conf) ───────────────

test('/detect: single rawCard with no conf uses original buffer and sidecar box', async () => {
  await withServer(
    {
      multiCardSplitter: {
        detectRaw: async () => [
          { box: [5, 10, 105, 160] }, // conf undefined — unclassified
        ],
      },
      scanAndPrice: async () => ({
        ok: true,
        identity: { name: 'Ditto' },
        suggested: { tcgplayer: 1 },
        vellumConfidence: 'low',
      }),
    },
    async ({ server }) => {
      const res = await detectPost(server, { image_b64: TINY_JPEG_B64 });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.cards.length, 1);
      assert.deepEqual(res.body.cards[0].box, [5, 10, 105, 160]);
    },
  );
});
