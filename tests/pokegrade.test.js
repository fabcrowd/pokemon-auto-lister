import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createPokegradeClient,
  extractGradedComps,
  QuotaExhaustedPokegradeError,
} from '../src/pokegrade/client.js';

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
      json: async () => ({
        confidence: 98,
        card_info: { name: 'Pikachu', set: 'Base', number: '25' },
        market_value: { raw_price: '$42.00' },
      }),
    };
  };
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  const result = await client.evaluateFrontImage(imagePath);
  assert.equal(calls, 1);
  assert.equal(result.identity.name, 'Pikachu');
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
      json: async () => ({
        confidence: 98,
        card_info: { name: 'Pikachu' },
        market_value: { raw_price: '$42.00' },
      }),
    };
  };
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  await client.evaluateFrontImage(imagePath);
  await client.evaluateFrontImage(imagePath);
  assert.equal(calls, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('429 quota throws QuotaExhaustedPokegradeError without writing cache', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pokegrade-'));
  const imagePath = makeTempImage(dir);
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: 'quota exceeded' }),
  });
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  await assert.rejects(
    () => client.evaluateFrontImage(imagePath),
    (err) => err instanceof QuotaExhaustedPokegradeError,
  );
  assert.equal(existsSync(path.join(dir, 'pokegrade-cache.json')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('maps grading subgrades from API payload', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pokegrade-'));
  const imagePath = makeTempImage(dir);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      confidence: 90,
      card_info: { name: 'Pikachu' },
      market_value: { raw_price: '$10' },
      grade: { overall: 8.5, centering: 9, corners: 8, edges: 8.5, surface: 8 },
    }),
  });
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  const result = await client.evaluateFrontImage(imagePath);
  assert.equal(result.grading.overall, 8.5);
  assert.equal(result.grading.centering, 9);
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

test('extractGradedComps maps psa fields from market_value', () => {
  const graded = extractGradedComps({
    raw_price: '$40',
    psa8: '$120',
    psa_9: 200,
    graded: { '10': '$400' },
  });
  assert.equal(graded.psa8, 120);
  assert.equal(graded.psa9, 200);
  assert.equal(graded.psa10, 400);
});

test('evaluateFrontImage includes graded comps without breaking raw value', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pokegrade-'));
  const imagePath = makeTempImage(dir);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      confidence: 90,
      card_info: { name: 'Charizard' },
      market_value: { raw_price: '$50.00', psa8: '$150', psa9: '$300' },
    }),
  });
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  const result = await client.evaluateFrontImage(imagePath);
  assert.equal(result.value, 50);
  assert.equal(result.graded.psa8, 150);
  assert.equal(result.graded.psa9, 300);
  rmSync(dir, { recursive: true, force: true });
});

test('evaluateImageUrl caches forever by item id', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pokegrade-'));
  let valueCalls = 0;
  let imageCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (typeof url === 'string' && url.includes('mercdn')) {
      imageCalls += 1;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('cdn-bytes'),
      };
    }
    valueCalls += 1;
    assert.equal(options.method, 'POST');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        confidence: 88,
        card_info: { name: 'Mew' },
        market_value: { raw_price: '$33', psa8: 90 },
      }),
    };
  };
  const client = createPokegradeClient({ apiKey: 'test-key', dataDir: dir, fetchImpl });
  const url = 'https://u-mercari-images.mercdn.net/photos/m123_1.jpg';
  const first = await client.evaluateImageUrl(url, { itemId: 'm123' });
  const second = await client.evaluateImageUrl(url, { itemId: 'm123' });
  assert.equal(first.value, 33);
  assert.equal(first.graded.psa8, 90);
  assert.equal(second.value, 33);
  assert.equal(valueCalls, 1);
  assert.equal(imageCalls, 1);
  assert.equal(existsSync(path.join(dir, 'pokegrade-item-cache.json')), true);
  const itemCache = JSON.parse(readFileSync(path.join(dir, 'pokegrade-item-cache.json'), 'utf8'));
  assert.equal(itemCache.m123.value, 33);
  rmSync(dir, { recursive: true, force: true });
});

