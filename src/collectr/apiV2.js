/**
 * Collectr private app API (api-v2.getcollectr.com) — portfolio sync.
 * Auth: JWT from web localStorage.collectrToken (COLLECTR_TOKEN).
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { identityKeys, normalize, normalizeNumber } from './match.js';
import { COLLECTR_STALE_AFTER_MS } from './catalog.js';

export const DEFAULT_COLLECTR_API_BASE_URL = 'https://api-v2.getcollectr.com';
export const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PAGE_LIMIT = 30;

function pokemonRow(product) {
  const category = String(product.catalog_category_name || product.catalog_category || '').toLowerCase();
  if (category && category !== 'pokemon' && category !== '3') {
    return null;
  }
  const market = Number.parseFloat(product.market_price ?? product.latest_price ?? '');
  if (!Number.isFinite(market)) {
    return null;
  }
  return {
    market,
    mid: null,
    name: String(product.product_name || '').trim(),
    set: String(product.catalog_group || '').trim(),
    number: String(product.card_number || '').trim(),
    condition: product.card_condition || null,
    source: 'collectr-api-v2',
    productId: product.product_id || null,
  };
}

/**
 * @param {object} options
 */
export function createCollectrApiV2Client({
  token = process.env.COLLECTR_TOKEN,
  userId = process.env.COLLECTR_USER_ID,
  collectionId = process.env.COLLECTR_COLLECTION_ID || '',
  baseUrl = process.env.COLLECTR_API_BASE_URL || DEFAULT_COLLECTR_API_BASE_URL,
  cachePath,
  staleAfterMs = COLLECTR_STALE_AFTER_MS,
  fetchImpl = fetch,
  log = console.warn,
} = {}) {
  const byExact = new Map();
  const byNameNumber = new Map();
  const byNameSet = new Map();
  let rowCount = 0;
  let syncedAtMs = null;
  let lastError = null;
  let resolvedCollectionId = collectionId || null;
  let hydratePromise = null;

  function configured() {
    return Boolean(token && userId);
  }

  function clearMaps() {
    byExact.clear();
    byNameNumber.clear();
    byNameSet.clear();
    rowCount = 0;
  }

  function ingestProducts(products) {
    clearMaps();
    for (const product of products) {
      const payload = pokemonRow(product);
      if (!payload?.name) {
        continue;
      }
      const keys = identityKeys(payload);
      byExact.set(keys.exact, payload);
      if (!byNameNumber.has(keys.nameNumber)) {
        byNameNumber.set(keys.nameNumber, payload);
      }
      if (!byNameSet.has(keys.nameSet)) {
        byNameSet.set(keys.nameSet, payload);
      }
      rowCount += 1;
    }
  }

  function loadCache() {
    if (!cachePath || !existsSync(cachePath)) {
      return false;
    }
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (!Array.isArray(cached.products)) {
        return false;
      }
      ingestProducts(cached.products);
      syncedAtMs = cached.syncedAtMs ?? null;
      resolvedCollectionId = cached.collectionId || resolvedCollectionId;
      return rowCount > 0;
    } catch {
      return false;
    }
  }

  function saveCache(products) {
    if (!cachePath) {
      return;
    }
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify(
        {
          syncedAtMs,
          collectionId: resolvedCollectionId,
          userId,
          products,
        },
        null,
        2,
      ),
    );
  }

  async function apiGet(pathname) {
    const root = String(baseUrl).replace(/\/+$/, '');
    const response = await fetchImpl(`${root}${pathname}`, {
      headers: {
        Authorization: token,
        Accept: 'application/json',
        Origin: 'https://app.getcollectr.com',
        Referer: 'https://app.getcollectr.com/',
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Collectr api-v2 ${pathname} failed: ${response.status}${body ? ` ${body.slice(0, 120)}` : ''}`);
    }
    return response.json();
  }

  async function resolveCollectionId() {
    if (resolvedCollectionId) {
      return resolvedCollectionId;
    }
    const data = await apiGet(`/accounts/${encodeURIComponent(userId)}/collections?details=true`);
    const list = Array.isArray(data) ? data : data?.data || data?.collections || [];
    const first = list[0];
    const id = first?.id || first?.collectionId || first?.collection_id || null;
    if (!id) {
      throw new Error('Collectr api-v2: no collection id on account');
    }
    resolvedCollectionId = String(id);
    return resolvedCollectionId;
  }

  async function fetchAllProducts() {
    const collId = await resolveCollectionId();
    const products = [];
    let offset = 0;
    for (;;) {
      const qs = new URLSearchParams({
        offset: String(offset),
        limit: String(PAGE_LIMIT),
        filters: '',
        sortType: 'priceChange',
        sortOrder: 'ASC',
        collectionId: collId,
        unstackedView: 'true',
        currency: 'USD',
      });
      const page = await apiGet(`/collections/${encodeURIComponent(userId)}/products?${qs}`);
      const rows = Array.isArray(page?.data) ? page.data : [];
      products.push(...rows);
      if (rows.length < PAGE_LIMIT) {
        break;
      }
      offset += PAGE_LIMIT;
    }
    return products;
  }

  async function sync() {
    if (!configured()) {
      lastError = 'COLLECTR_TOKEN / COLLECTR_USER_ID not set';
      return stats();
    }
    try {
      const products = await fetchAllProducts();
      ingestProducts(products);
      syncedAtMs = Date.now();
      lastError = null;
      saveCache(products);
      return stats();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log(`Collectr api-v2 sync failed: ${lastError}`);
      if (rowCount === 0) {
        loadCache();
      }
      return stats();
    }
  }

  async function ensureHydrated() {
    if (rowCount > 0 || syncedAtMs != null) {
      return;
    }
    if (hydratePromise) {
      await hydratePromise;
      return;
    }
    hydratePromise = (async () => {
      if (!loadCache()) {
        await sync();
      }
    })().finally(() => {
      hydratePromise = null;
    });
    await hydratePromise;
  }

  async function getMarketPrice(identity = {}) {
    await ensureHydrated();
    const name = normalize(identity.name);
    const set = normalize(identity.set);
    const number = normalizeNumber(identity.number);
    if (!name) {
      return null;
    }
    return (
      byExact.get(`${name}|${set}|${number}`) ||
      byNameNumber.get(`${name}|${number}`) ||
      byNameSet.get(`${name}|${set}`) ||
      null
    );
  }

  function stats(nowMs = Date.now()) {
    const ageMs = syncedAtMs == null ? null : Math.max(0, nowMs - syncedAtMs);
    return {
      mode: 'api-v2',
      configured: configured(),
      exists: configured() && (rowCount > 0 || syncedAtMs != null),
      rowCount,
      collectionId: resolvedCollectionId,
      userId: userId || null,
      syncedAtMs,
      ageMs,
      ageHours: ageMs == null ? null : ageMs / (60 * 60 * 1000),
      staleAfterMs,
      stale: Boolean(lastError) || ageMs == null || ageMs >= staleAfterMs,
      lastError,
      cachePath: cachePath || null,
    };
  }

  async function reload() {
    await sync();
    return stats();
  }

  return {
    mode: 'api-v2',
    getMarketPrice,
    stats,
    reload,
    sync,
    configured,
  };
}
