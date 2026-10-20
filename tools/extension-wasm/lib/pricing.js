// Fetch market price from pokemontcg.io with 24-hour chrome.storage.local cache.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const API_BASE     = "https://api.pokemontcg.io/v2/cards";

// In-flight deduplication: card ID → pending Promise
const _inflight = new Map();

// Variant priority: prefer holofoil → reverse → normal
const VARIANT_ORDER = [
  "holofoil",
  "reverseHolofoil",
  "normal",
  "1stEditionHolofoil",
  "1stEditionNormal",
];

/**
 * Returns { price: number, variant: string } for a card identity, or null if unavailable.
 * identity must have at least { id: string }.
 */
export async function getPrice(identity) {
  if (!identity?.id) return null;

  // Cache key versioned to bust old plain-number entries from prior schema
  const cacheKey = `price2_${identity.id}`;
  const cached   = await getCached(cacheKey);
  if (cached !== undefined) return cached;

  // Return existing in-flight request for the same card rather than firing a duplicate
  if (_inflight.has(identity.id)) return _inflight.get(identity.id);

  const request = _fetchPrice(identity.id, cacheKey);
  _inflight.set(identity.id, request);
  try {
    return await request;
  } finally {
    _inflight.delete(identity.id);
  }
}

/**
 * Return the raw pokemontcg.io card payload including the full tcgplayer.prices map and
 * tcgplayer.url (which contains the TCGPlayer product ID). Cached under a separate key
 * so this doesn't collide with the lean getPrice() cache.
 */
const _fullInflight = new Map();
export async function getFullCardPayload(id) {
  if (!id) return null;
  const cacheKey = `full2_${id}`;
  const cached   = await getCached(cacheKey);
  if (cached !== undefined) return cached;
  if (_fullInflight.has(id)) return _fullInflight.get(id);
  const p = (async () => {
    const url = `${API_BASE}/${id}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) {
          if (resp.status === 404) { await setCached(cacheKey, null); return null; }
          if (resp.status >= 500 && attempt < 2) continue;
          return null;
        }
        const json = await resp.json();
        const data = json?.data || null;
        await setCached(cacheKey, data);
        return data;
      } catch {
        if (attempt < 2) continue;
        return null;
      }
    }
    return null;
  })();
  _fullInflight.set(id, p);
  try { return await p; } finally { _fullInflight.delete(id); }
}

const TCGDEX_BASE = "https://api.tcgdex.net/v2/en/cards";
const _tcgdexInflight = new Map();

/** TCGdex card keyed by our catalog id, or null. Daily TCGPlayer numbers come from the shared snapshot. */
export async function getTcgdexCard(id) {
  if (!id) return null;
  const cacheKey = `tcgdex1_${id}`;
  const cached   = await getCached(cacheKey);
  if (cached !== undefined) return cached;
  if (_tcgdexInflight.has(id)) return _tcgdexInflight.get(id);
  const p = (async () => {
    try {
      const resp = await fetch(`${TCGDEX_BASE}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
      if (resp.status === 404) { await setCached(cacheKey, null); return null; }
      if (!resp.ok) return null;
      const card = await resp.json();
      await setCached(cacheKey, card);
      return card;
    } catch (err) {
      console.error("[pricing] TCGdex fetch failed for", id, err?.message || err);
      return null;
    }
  })();
  _tcgdexInflight.set(id, p);
  try { return await p; } finally { _tcgdexInflight.delete(id); }
}

/** Pull the TCGPlayer product ID out of a tcgplayer.url like .../product/490294/... */
export function extractTcgPlayerId(tcgplayerUrl) {
  if (!tcgplayerUrl) return null;
  const m = String(tcgplayerUrl).match(/\/product\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function _fetchPrice(id, cacheKey) {
  const url = `${API_BASE}/${id}`;
  // Up to 3 attempts for transient 5xx — pokemontcg.io is flaky under load.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) {
        if (resp.status === 404) { await setCached(cacheKey, null); return null; }
        if (resp.status >= 500 && attempt < 2) continue; // retry 5xx
        return null;
      }
      const json      = await resp.json();
      const priceData = extractPrice(json.data);
      await setCached(cacheKey, priceData);
      return priceData;
    } catch (err) {
      if (attempt < 2) continue;
      console.error("[pricing] fetch failed for", id, err?.message || err);
      return null;
    }
  }
  return null;
}

function extractPrice(card) {
  if (!card?.tcgplayer?.prices) return null;
  const prices = card.tcgplayer.prices;

  for (const variant of VARIANT_ORDER) {
    const p = prices[variant]?.market ?? prices[variant]?.mid;
    if (p != null) return { price: p, variant };
  }

  // Fall back to first available variant
  for (const variant of Object.keys(prices)) {
    const p = prices[variant]?.market ?? prices[variant]?.mid;
    if (p != null) return { price: p, variant };
  }

  return null;
}

async function getCached(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      const entry = result[key];
      if (!entry) return resolve(undefined);
      if (Date.now() - entry.ts > CACHE_TTL_MS) return resolve(undefined);
      resolve(entry.value); // null (404) or { price, variant } — both are valid cached values
    });
  });
}

async function setCached(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: { value, ts: Date.now() } }, resolve);
  });
}
