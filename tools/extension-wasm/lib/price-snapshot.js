// One prices.json on the data repo, published nightly. Every install downloads that file.
// A price replaces the TCGdex number only when this card's TCGPlayer product id is in the file.

import { PRICE_SNAPSHOT_URL } from "./shared-config.js";

export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SNAPSHOT_CHARS = 8_000_000;
const STORAGE_KEY = "priceSnapshot1";
const FAIL_MS = 15 * 60 * 1000;

const SUBTYPE = {
  normal: "Normal",
  holofoil: "Holofoil",
  reverseHolofoil: "Reverse Holofoil",
  unlimitedHolofoil: "Unlimited Holofoil",
  unlimited: "Unlimited",
  "1stEditionHolofoil": "1st Edition Holofoil",
  "1stEditionNormal": "1st Edition",
};

function roundPrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
}

function spreadOf(variants) {
  const markets = Object.values(variants).map((variant) => variant.market).filter((price) => price > 0);
  if (markets.length < 2) return 1;
  return Math.max(...markets) / Math.min(...markets);
}

/** The parsed snapshot, or an error when the file is not the shape this build stores. */
export function parseSnapshot(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_SNAPSHOT_CHARS) {
    throw new Error("price snapshot is too large");
  }
  const data = JSON.parse(text);
  if (data?.v !== 1 || typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))) {
    throw new Error("price snapshot has no date");
  }
  if (!data.prices || typeof data.prices !== "object" || Array.isArray(data.prices)) {
    throw new Error("price snapshot has no prices");
  }
  return { v: 1, updatedAt: data.updatedAt, prices: data.prices };
}

/**
 * Replace TCGdex markets with the shared snapshot. The same object comes back when nothing matched,
 * so a missing product cannot change the date on screen.
 */
export function applySnapshot(grid, snapshot) {
  if (!grid || grid.source !== "tcgdex" || !snapshot?.prices) return grid;
  const updatedAt = typeof snapshot.updatedAt === "string" && Number.isFinite(Date.parse(snapshot.updatedAt))
    ? snapshot.updatedAt
    : null;
  if (!updatedAt) return grid;
  let applied = 0;
  const variants = {};
  for (const [printing, variant] of Object.entries(grid.variants || {})) {
    const subtype = SUBTYPE[printing];
    const product = snapshot.prices[String(variant?.productId)];
    const market = subtype && product ? roundPrice(product[subtype]) : null;
    if (market == null) {
      variants[printing] = variant;
      continue;
    }
    applied += 1;
    variants[printing] = {
      ...variant,
      market,
      conditions: { ...variant.conditions, NM: market },
    };
  }
  if (!applied) return grid;
  return { ...grid, variants, updatedAt, spreadRatio: spreadOf(variants) };
}

function chromeStorage() {
  return {
    get(key) {
      return new Promise((resolve) => {
        chrome.storage.local.get(key, (result) => resolve(result[key]));
      });
    },
    set(key, value) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [key]: value }, resolve);
      });
    },
  };
}

/** @param {{ fetchImpl?: Function, storage?: { get: Function, set: Function }, now?: Function, url?: string, ttlMs?: number }} [deps] */
export function createSnapshotClient({
  fetchImpl = (...args) => fetch(...args),
  storage = null,
  now = Date.now,
  url = PRICE_SNAPSHOT_URL,
  ttlMs = SNAPSHOT_TTL_MS,
} = {}) {
  const store = storage || chromeStorage();
  let memory = null;
  let refreshing = null;
  let failUntil = 0;

  async function readStored() {
    if (memory && now() - memory.fetchedAt < ttlMs) return memory;
    const stored = await store.get(STORAGE_KEY);
    if (stored?.snapshot && Number.isFinite(stored.fetchedAt)) {
      memory = stored;
      return stored;
    }
    return null;
  }

  async function refreshOnce() {
    if (!url) return null;
    if (now() < failUntil) return (await readStored())?.snapshot ?? null;
    const stored = await readStored();
    if (stored && now() - stored.fetchedAt < ttlMs) return stored.snapshot;
    let snapshot;
    try {
      const response = await fetchImpl(url, {
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`price snapshot answered ${response.status}`);
      snapshot = parseSnapshot(await response.text());
    } catch (err) {
      failUntil = now() + FAIL_MS;
      console.error("[prices] snapshot not updated:", err?.message || err);
      return stored?.snapshot ?? null;
    }
    memory = { fetchedAt: now(), snapshot };
    try {
      await store.set(STORAGE_KEY, memory);
    } catch (err) {
      console.error("[prices] snapshot not stored:", err?.message || err);
    }
    return snapshot;
  }

  function refreshPriceSnapshot() {
    if (!refreshing) refreshing = refreshOnce().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function currentSnapshot() {
    const stored = await readStored();
    if (stored && now() - stored.fetchedAt < ttlMs) return stored.snapshot;
    return refreshPriceSnapshot();
  }

  return { currentSnapshot, refreshPriceSnapshot };
}

const client = createSnapshotClient();

export function currentSnapshot() {
  return client.currentSnapshot();
}

export function refreshPriceSnapshot() {
  return client.refreshPriceSnapshot();
}
