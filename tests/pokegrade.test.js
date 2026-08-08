import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPokegradeClient } from '../src/pokegrade/client.js';

function makeTempImage(dir, bytes = 'fake-image-bytes') {
  const imagePath = path.join(dir, 'front.jpg');
  writeFileSync(imagePath, bytes);
  return imagePath;
}

test('evaluateFrontImage posts to /value and returns identity + market value + confidence', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pokegrade-'));
  const imagePath = makeTempImage(dir);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ identity: { name: 'Pikachu' }, value: 42, confidence: 'high' }),
    };
  };
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  const result = await client.evaluateFrontImage(imagePath);
  assert.equal(calls, 1);
  assert.deepEqual(result.identity, { name: 'Pikachu' });
  assert.equal(result.value, 42);
  assert.equal(result.confidence, 'high');
  rmSync(dir, { recursive: true, force: true });
});

test('second call with same image bytes hits cache and does not call network', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pokegrade-'));
  const imagePath = makeTempImage(dir);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ identity: { name: 'Pikachu' }, value: 42, confidence: 'high' }),
    };
  };
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  await client.evaluateFrontImage(imagePath);
  await client.evaluateFrontImage(imagePath);
  assert.equal(calls, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('5xx transient error throws retryable error without writing cache', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pokegrade-'));
  const imagePath = makeTempImage(dir);
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  await assert.rejects(() => client.evaluateFrontImage(imagePath), /PokeGrade transient error/);
  assert.equal(existsSync(path.join(dir, 'pokegrade-cache.json')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('missing API key throws clear configuration error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pokegrade-'));
  const imagePath = makeTempImage(dir);
  const client = createPokegradeClient({
    apiKey: '',
    dataDir: dir,
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
  });
  await assert.rejects(() => client.evaluateFrontImage(imagePath), /PGAI_KEY/);
  rmSync(dir, { recursive: true, force: true });
});
