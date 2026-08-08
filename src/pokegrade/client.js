import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// https://pokegrade.ai/developers — POST image bytes to /value, 1 credit per uncached call.
const POKEGRADE_VALUE_URL = 'https://api.pokegrade.ai/value';

export class RetryablePokegradeError extends Error {}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

function hashImageBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createPokegradeClient({ apiKey = process.env.PGAI_KEY, dataDir = 'data', fetchImpl = fetch } = {}) {
  const cachePath = path.join(dataDir, 'pokegrade-cache.json');

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

  async function evaluateFrontImage(imagePath) {
    if (!apiKey) {
      throw new Error('PokeGrade configuration error: PGAI_KEY is not set');
    }

    const buffer = readFileSync(imagePath);
    const hash = hashImageBytes(buffer);
    const cache = readCache();
    if (cache[hash]) {
      return cache[hash];
    }

    const response = await fetchImpl(POKEGRADE_VALUE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    });

    if (response.status >= 500) {
      throw new RetryablePokegradeError(`PokeGrade transient error: ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`PokeGrade request failed: ${response.status}`);
    }

    const data = await response.json();
    const result = {
      identity: data.identity,
      value: data.value ?? data.marketValue ?? null,
      confidence: data.confidence ?? null,
    };

    cache[hash] = result;
    writeCache(cache);
    return result;
  }

  return { evaluateFrontImage };
}
