import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

import { VELLUM_SOURCE } from './types.js';

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

function hashImageBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * HTTP client for the VellumAI sidecar (`POST /identify`).
 *
 * @param {{
 *   baseUrl?: string,
 *   dataDir?: string,
 *   fetchImpl?: typeof fetch,
 *   enabled?: boolean,
 * }} [options]
 */
export function createVellumAiClient({
  baseUrl = process.env.VELLUM_AI_URL || 'http://127.0.0.1:8787',
  dataDir = 'data',
  fetchImpl = fetch,
  enabled = String(process.env.VELLUM_AI_ENABLED || 'false').toLowerCase() === 'true',
} = {}) {
  const cachePath = path.join(dataDir, 'vellum-ai-cache.json');
  const root = String(baseUrl).replace(/\/$/, '');

  function readCache() {
    if (!existsSync(cachePath)) {
      return {};
    }
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }

  function writeCache(cache) {
    mkdirSync(dataDir, { recursive: true });
    atomicWriteJson(cachePath, cache);
  }

  async function health() {
    const response = await fetchImpl(`${root}/health`);
    if (!response.ok) {
      throw new Error(`VellumAI health failed: ${response.status}`);
    }
    return response.json();
  }

  /**
   * @param {string} imagePath
   * @param {{ backImagePath?: string|null }} [options]
   */
  async function evaluateFrontImage(imagePath, { backImagePath = null } = {}) {
    if (!enabled) {
      return {
        source: VELLUM_SOURCE,
        identity: null,
        abstain: true,
        reason: 'VellumAI disabled',
        confidence: 'low',
      };
    }

    const buffer = readFileSync(imagePath);
    const hash = hashImageBytes(buffer);
    const cache = readCache();
    if (cache[hash]) {
      return cache[hash];
    }

    const form = new FormData();
    form.append(
      'front',
      new File([buffer], path.basename(imagePath) || 'front.jpg', { type: 'image/jpeg' }),
    );
    if (backImagePath && existsSync(backImagePath)) {
      const back = readFileSync(backImagePath);
      form.append(
        'back',
        new File([back], path.basename(backImagePath) || 'back.jpg', { type: 'image/jpeg' }),
      );
    }

    const response = await fetchImpl(`${root}/identify`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = ` ${JSON.stringify(await response.json())}`;
      } catch {
        // ignore
      }
      throw new Error(`VellumAI identify failed: ${response.status}${detail}`);
    }

    const data = await response.json();
    const result = {
      source: VELLUM_SOURCE,
      identity: data.identity ?? null,
      value: data.value ?? null,
      confidence: data.confidence ?? (data.abstain ? 'low' : 'high'),
      finish: data.finish ?? null,
      candidates: Array.isArray(data.candidates) ? data.candidates : [],
      abstain: Boolean(data.abstain),
      reason: data.reason ?? null,
      grading: data.grading ?? null,
      raw: data,
    };

    if (!result.abstain) {
      cache[hash] = result;
      writeCache(cache);
    }
    return result;
  }

  return { evaluateFrontImage, health, enabled, baseUrl: root };
}

/**
 * In-process mock for tests / Phase 0 without the Python sidecar.
 * @param {(imagePath: string, options?: object) => Promise<object>|object} handler
 */
export function createMockVellumAiClient(handler) {
  return {
    enabled: true,
    baseUrl: 'mock://vellum-ai',
    health: async () => ({ ok: true, mode: 'mock' }),
    evaluateFrontImage: async (imagePath, options = {}) => {
      const data = await handler(imagePath, options);
      return {
        source: VELLUM_SOURCE,
        identity: data.identity ?? null,
        value: data.value ?? null,
        confidence: data.confidence ?? (data.abstain ? 'low' : 'high'),
        finish: data.finish ?? null,
        candidates: data.candidates ?? [],
        abstain: Boolean(data.abstain),
        reason: data.reason ?? null,
        grading: data.grading ?? null,
        raw: data,
      };
    },
  };
}
