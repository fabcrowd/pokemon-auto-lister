import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

import { isQuotaExhaustedStatus } from './circuit.js';

// https://pokegrade.ai/developers/docs — POST /api/v1/value
const POKEGRADE_VALUE_URL = 'https://pokegrade.ai/api/v1/value';

export class RetryablePokegradeError extends Error {}

/** Free-tier / rate-limit burnout — open circuit and fall back to VellumAI solo. */
export class QuotaExhaustedPokegradeError extends Error {}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

function hashImageBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseMoney(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeConfidence(confidence) {
  if (confidence === 'low' || confidence === 'high') {
    return confidence;
  }
  if (typeof confidence === 'number') {
    return confidence < 70 ? 'low' : 'high';
  }
  return confidence ?? null;
}

/**
 * Normalize graded comps from various PokeGrade payload shapes into { psa8, psa9, ... }.
 *
 * @param {object|null|undefined} marketValue
 * @returns {Record<string, number|null>}
 */
export function extractGradedComps(marketValue) {
  const graded = {};
  if (!marketValue || typeof marketValue !== 'object') {
    return graded;
  }

  const nested = marketValue.graded ?? marketValue.grades ?? marketValue.psa ?? null;
  const sources = [marketValue, nested].filter((s) => s && typeof s === 'object');

  for (const source of sources) {
    for (const [key, raw] of Object.entries(source)) {
      if (key === 'raw_price' || key === 'raw' || key === 'graded' || key === 'grades' || key === 'psa') {
        continue;
      }
      const match = String(key).match(/^(?:psa[_\s-]?)?(\d{1,2})$/i) || String(key).match(/psa[_\s-]?(\d{1,2})/i);
      if (!match) {
        continue;
      }
      const grade = match[1];
      const money = parseMoney(raw);
      if (money != null) {
        graded[`psa${grade}`] = money;
      }
    }
  }

  // Common explicit fields
  for (const grade of [7, 8, 9, 10]) {
    const candidates = [
      marketValue[`psa_${grade}`],
      marketValue[`psa${grade}`],
      marketValue[`PSA ${grade}`],
      marketValue[`PSA${grade}`],
      nested?.[`psa_${grade}`],
      nested?.[`psa${grade}`],
      nested?.[String(grade)],
    ];
    for (const candidate of candidates) {
      const money = parseMoney(candidate);
      if (money != null) {
        graded[`psa${grade}`] = money;
        break;
      }
    }
  }

  return graded;
}

function mapValueResponse(data) {
  const card = data.card_info ?? data.identity ?? {};
  const identity = {
    name: card.name ?? null,
    set: card.set ?? null,
    setCode: card.set_code ?? null,
    number: card.number ?? null,
    productId: card.product_id ?? null,
    game: card.game ?? null,
  };
  const marketValue = data.market_value ?? {};
  const value =
    parseMoney(marketValue.raw_price) ??
    parseMoney(marketValue.raw) ??
    data.value ??
    data.marketValue ??
    null;
  const gradeBlock = data.grade ?? data.grading ?? data.grades ?? null;
  let grading = null;
  if (gradeBlock && typeof gradeBlock === 'object') {
    grading = {
      overall: gradeBlock.overall ?? gradeBlock.final ?? gradeBlock.grade ?? null,
      centering: gradeBlock.centering ?? null,
      corners: gradeBlock.corners ?? null,
      edges: gradeBlock.edges ?? null,
      surface: gradeBlock.surface ?? null,
      summary: gradeBlock.summary ?? gradeBlock.condition ?? null,
    };
  }

  return {
    identity,
    value,
    graded: extractGradedComps(marketValue),
    grading,
    confidence: normalizeConfidence(data.confidence),
    raw: data,
  };
}

function mimeFromUrlOrPath(source) {
  const lower = String(source).toLowerCase();
  if (lower.includes('.png')) {
    return 'image/png';
  }
  if (lower.includes('.webp')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

export function createPokegradeClient({ apiKey = process.env.PGAI_KEY, dataDir = 'data', fetchImpl = fetch } = {}) {
  const cachePath = path.join(dataDir, 'pokegrade-cache.json');
  const itemCachePath = path.join(dataDir, 'pokegrade-item-cache.json');

  function readJsonCache(filePath) {
    if (!existsSync(filePath)) {
      return {};
    }
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }

  function writeJsonCache(filePath, cache) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteJson(filePath, cache);
  }

  async function postValue(buffer, mimeType, { backBuffer = null, backMimeType = null } = {}) {
    if (!apiKey) {
      throw new Error('PokeGrade configuration error: PGAI_KEY is not set');
    }

    const payload = {
      image_base64: buffer.toString('base64'),
      mime_type: mimeType,
    };
    if (backBuffer) {
      payload.back_image_base64 = backBuffer.toString('base64');
      payload.back_mime_type = backMimeType || 'image/jpeg';
    }

    const response = await fetchImpl(POKEGRADE_VALUE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.status >= 500) {
      throw new RetryablePokegradeError(`PokeGrade transient error: ${response.status}`);
    }
    if (response.status === 422) {
      throw new Error('PokeGrade could not identify a card in the image');
    }

    let detail = '';
    let bodyJson = null;
    if (!response.ok) {
      try {
        bodyJson = await response.json();
        detail = ` ${JSON.stringify(bodyJson)}`;
      } catch {
        // ignore body parse errors
      }
      if (isQuotaExhaustedStatus(response.status, detail)) {
        throw new QuotaExhaustedPokegradeError(
          `PokeGrade quota exhausted: ${response.status}${detail}`,
        );
      }
      throw new Error(`PokeGrade request failed: ${response.status}${detail}`);
    }

    const data = await response.json();
    return mapValueResponse(data);
  }

  /**
   * @param {string} imagePath
   * @param {{ backImagePath?: string|null }} [options]
   */
  async function evaluateFrontImage(imagePath, { backImagePath = null } = {}) {
    const buffer = readFileSync(imagePath);
    const backBuffer =
      backImagePath && existsSync(backImagePath) ? readFileSync(backImagePath) : null;
    const hash = hashImageBytes(
      backBuffer ? Buffer.concat([buffer, Buffer.from('|'), backBuffer]) : buffer,
    );
    const cache = readJsonCache(cachePath);
    if (cache[hash]) {
      return cache[hash];
    }

    const result = await postValue(buffer, mimeFromUrlOrPath(imagePath), {
      backBuffer,
      backMimeType: backImagePath ? mimeFromUrlOrPath(backImagePath) : null,
    });
    cache[hash] = result;
    writeJsonCache(cachePath, cache);
    return result;
  }

  /**
   * Evaluate a remote image URL (e.g. Mercari CDN first photo).
   * Optional itemId caches forever under pokegrade-item-cache.json.
   *
   * @param {string} imageUrl
   * @param {{ itemId?: string }} [options]
   */
  async function evaluateImageUrl(imageUrl, { itemId } = {}) {
    if (itemId) {
      const itemCache = readJsonCache(itemCachePath);
      if (itemCache[itemId]) {
        return itemCache[itemId];
      }
    }

    const imageResponse = await fetchImpl(imageUrl);
    if (imageResponse.status >= 500) {
      throw new RetryablePokegradeError(`Image fetch transient error: ${imageResponse.status}`);
    }
    if (!imageResponse.ok) {
      throw new Error(`Image fetch failed: ${imageResponse.status}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const hash = hashImageBytes(buffer);
    const hashCache = readJsonCache(cachePath);
    if (hashCache[hash]) {
      if (itemId) {
        const itemCache = readJsonCache(itemCachePath);
        itemCache[itemId] = hashCache[hash];
        writeJsonCache(itemCachePath, itemCache);
      }
      return hashCache[hash];
    }

    const result = await postValue(buffer, mimeFromUrlOrPath(imageUrl));
    hashCache[hash] = result;
    writeJsonCache(cachePath, hashCache);

    if (itemId) {
      const itemCache = readJsonCache(itemCachePath);
      itemCache[itemId] = result;
      writeJsonCache(itemCachePath, itemCache);
    }

    return result;
  }

  return { evaluateFrontImage, evaluateImageUrl };
}
