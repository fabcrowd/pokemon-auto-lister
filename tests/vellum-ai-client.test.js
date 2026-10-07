import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createVellumAiClient, createMockVellumAiClient } from '../src/identify/vellumAi.js';
import { VELLUM_SOURCE } from '../src/identify/types.js';

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAeJAgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/9k=',
  'base64',
);

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test('createVellumAiClient abstains when disabled', async () => {
  const client = createVellumAiClient({
    enabled: false,
    fetchImpl: async () => {
      throw new Error('should not fetch when disabled');
    },
  });
  const result = await client.evaluateFrontImage('/tmp/missing.jpg');
  assert.equal(result.abstain, true);
  assert.equal(result.source, VELLUM_SOURCE);
  assert.match(result.reason, /disabled/i);
});

test('createVellumAiClient health throws on non-ok', async () => {
  const client = createVellumAiClient({
    enabled: true,
    fetchImpl: async () => jsonResponse({}, false, 503),
  });
  await assert.rejects(() => client.health(), /health failed: 503/);
});

test('createVellumAiClient identifies, caches, and skips abstain cache', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'vellum-client-'));
  const front = path.join(dataDir, 'front.jpg');
  const back = path.join(dataDir, 'back.jpg');
  writeFileSync(front, TINY_JPEG);
  writeFileSync(back, TINY_JPEG);
  let identifyCalls = 0;
  try {
    const client = createVellumAiClient({
      dataDir,
      enabled: true,
      fetchImpl: async (url, opts) => {
        if (String(url).endsWith('/health')) {
          return jsonResponse({ ok: true });
        }
        identifyCalls += 1;
        assert.equal(opts?.method, 'POST');
        assert.ok(opts?.body instanceof FormData);
        assert.ok(opts.body.has('front'));
        assert.ok(opts.body.has('back'));
        return jsonResponse({
          identity: { name: 'Pikachu', setCode: 'base1', number: '58' },
          confidence: 'high',
          finish: 'nonholo',
          candidates: [{ id: 'base1-58' }],
        });
      },
    });
    const health = await client.health();
    assert.equal(health.ok, true);

    const first = await client.evaluateFrontImage(front, { backImagePath: back });
    assert.equal(first.identity.name, 'Pikachu');
    assert.equal(first.finish, 'nonholo');
    assert.equal(identifyCalls, 1);
    assert.ok(existsSync(path.join(dataDir, 'vellum-ai-cache.json')));

    const second = await client.evaluateFrontImage(front, { backImagePath: back });
    assert.equal(second.identity.name, 'Pikachu');
    assert.equal(identifyCalls, 1);

    const abstainClient = createVellumAiClient({
      dataDir,
      enabled: true,
      fetchImpl: async () =>
        jsonResponse({ identity: null, abstain: true, reason: 'no_card', confidence: 'low' }),
    });
    const otherFront = path.join(dataDir, 'other.jpg');
    writeFileSync(otherFront, Buffer.from([...TINY_JPEG, 1]));
    const abstain = await abstainClient.evaluateFrontImage(otherFront);
    assert.equal(abstain.abstain, true);
    const cache = JSON.parse(readFileSync(path.join(dataDir, 'vellum-ai-cache.json'), 'utf8'));
    assert.equal(Object.keys(cache).length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('createVellumAiClient throws with status detail on identify failure', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'vellum-fail-'));
  const front = path.join(dataDir, 'front.jpg');
  writeFileSync(front, TINY_JPEG);
  try {
    const client = createVellumAiClient({
      dataDir,
      enabled: true,
      fetchImpl: async () => jsonResponse({ error: 'boom' }, false, 500),
    });
    await assert.rejects(() => client.evaluateFrontImage(front), /identify failed: 500.*boom/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('createMockVellumAiClient wraps handler payload', async () => {
  const client = createMockVellumAiClient(async () => ({
    identity: { name: 'Mew' },
    abstain: false,
    confidence: 'high',
  }));
  const result = await client.evaluateFrontImage('/x.jpg');
  assert.equal(result.source, VELLUM_SOURCE);
  assert.equal(result.identity.name, 'Mew');
  assert.equal((await client.health()).ok, true);
});
