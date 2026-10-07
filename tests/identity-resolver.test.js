import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createIdentityResolver, identityCompareKey } from '../src/identify/resolver.js';
import { createMockVellumAiClient } from '../src/identify/vellumAi.js';
import { createPokegradeCircuit } from '../src/pokegrade/circuit.js';
import { QuotaExhaustedPokegradeError } from '../src/pokegrade/client.js';

const CHARIZARD = { name: 'Charizard', set: 'Base Set', setCode: 'base1', number: '4' };
const BLASTOISE = { name: 'Blastoise', set: 'Base Set', setCode: 'base1', number: '2' };

test('identityCompareKey prefers setCode|number', () => {
  assert.equal(identityCompareKey(CHARIZARD), 'base1|4');
});

test('dual agree uses PokeGrade identity', async () => {
  const resolver = createIdentityResolver({
    mode: 'dual',
    vellumEnabled: true,
    pokegradeClient: {
      evaluateFrontImage: async () => ({ identity: CHARIZARD, value: 100, confidence: 'high' }),
    },
    vellumClient: createMockVellumAiClient(async () => ({
      identity: { ...CHARIZARD },
      confidence: 'high',
    })),
  });
  const result = await resolver.evaluateFrontImage('/tmp/front.jpg');
  assert.equal(result.mode, 'dual');
  assert.equal(result.identityConflict, false);
  assert.deepEqual(result.identity, CHARIZARD);
  assert.equal(result.pokegrade.value, 100);
});

test('dual disagree sets identityConflict', async () => {
  const resolver = createIdentityResolver({
    mode: 'dual',
    vellumEnabled: true,
    pokegradeClient: {
      evaluateFrontImage: async () => ({ identity: CHARIZARD, value: 100, confidence: 'high' }),
    },
    vellumClient: createMockVellumAiClient(async () => ({
      identity: BLASTOISE,
      confidence: 'high',
    })),
  });
  const result = await resolver.evaluateFrontImage('/tmp/front.jpg');
  assert.equal(result.identityConflict, true);
  assert.match(result.reason, /disagree/i);
});

test('quota exhaustion opens circuit and runs VellumAI solo', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pg-circuit-'));
  try {
    const circuit = createPokegradeCircuit({ dataDir: dir, ttlHours: 24 });
    let pgCalls = 0;
    const resolver = createIdentityResolver({
      mode: 'dual',
      vellumEnabled: true,
      circuit,
      pokegradeClient: {
        evaluateFrontImage: async () => {
          pgCalls += 1;
          throw new QuotaExhaustedPokegradeError('PokeGrade quota exhausted: 429');
        },
      },
      vellumClient: createMockVellumAiClient(async () => ({
        identity: CHARIZARD,
        confidence: 'high',
      })),
    });
    const result = await resolver.evaluateFrontImage('/tmp/front.jpg');
    assert.equal(result.mode, 'local-only');
    assert.equal(result.pokegradeSkipped, true);
    assert.deepEqual(result.identity, CHARIZARD);
    assert.equal(circuit.isOpen(), true);

    // Second call should skip PokeGrade entirely
    const again = await resolver.evaluateFrontImage('/tmp/front.jpg');
    assert.equal(again.mode, 'local-only');
    assert.equal(pgCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local-only abstain when VellumAI abstains', async () => {
  const resolver = createIdentityResolver({
    mode: 'local-only',
    vellumEnabled: true,
    pokegradeClient: {
      evaluateFrontImage: async () => {
        throw new Error('should not call pokegrade');
      },
    },
    vellumClient: createMockVellumAiClient(async () => ({
      identity: null,
      abstain: true,
      reason: 'no_card_detected',
      confidence: 'low',
    })),
  });
  const result = await resolver.evaluateFrontImage('/tmp/front.jpg');
  assert.equal(result.localAbstained, true);
  assert.equal(result.identity, null);
});

test('local-only returns Vellum identity without calling PokeGrade', async () => {
  const resolver = createIdentityResolver({
    mode: 'local-only',
    vellumEnabled: true,
    pokegradeClient: {
      evaluateFrontImage: async () => {
        throw new Error('should not call pokegrade');
      },
    },
    vellumClient: createMockVellumAiClient(async () => ({
      identity: CHARIZARD,
      confidence: 'high',
    })),
  });
  const result = await resolver.evaluateFrontImage('/tmp/front.jpg');
  assert.equal(result.mode, 'local-only');
  assert.deepEqual(result.identity, CHARIZARD);
  assert.equal(result.pokegradeSkipped, true);
});

test('local-only fails closed when Vellum is disabled', async () => {
  const resolver = createIdentityResolver({
    mode: 'local-only',
    vellumEnabled: false,
    pokegradeClient: {
      evaluateFrontImage: async () => ({ identity: CHARIZARD }),
    },
  });
  const result = await resolver.evaluateFrontImage('/tmp/front.jpg');
  assert.equal(result.identity, null);
  assert.match(result.reason, /VELLUM_AI_ENABLED/);
});

test('identityCompareKey falls back to name|set|number', () => {
  assert.equal(
    identityCompareKey({ name: 'Pikachu', set: 'Base Set', number: '58' }),
    'pikachu|baseset|58',
  );
  assert.equal(identityCompareKey(null), '');
  assert.equal(identityCompareKey({ name: 'Pikachu', set: 'Base' }), 'pikachu|base');
});

test('dual treats low-confidence Vellum as abstain', async () => {
  const resolver = createIdentityResolver({
    mode: 'dual',
    vellumEnabled: true,
    pokegradeClient: {
      evaluateFrontImage: async () => ({ identity: CHARIZARD, value: 50, confidence: 'high' }),
    },
    vellumClient: createMockVellumAiClient(async () => ({
      identity: BLASTOISE,
      confidence: 'low',
    })),
  });
  const result = await resolver.evaluateFrontImage('/tmp/front.jpg');
  assert.equal(result.identityConflict, false);
  assert.equal(result.localAbstained, true);
  assert.deepEqual(result.identity, CHARIZARD);
});
