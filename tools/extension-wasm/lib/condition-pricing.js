// Per-condition + graded pricing for the extension.
//
// Three stacked sources, tried in order:
//   1. Local backend proxy (http://127.0.0.1:3000/api/price-grid) if the Node dashboard is running
//      → JustTCG via existing server-side key, best data, no key exposed to extension
//   2. PokemonPriceTracker.com direct, if the user has pasted a key into options
//      → NM/LP/MP/HP/DMG + PSA/BGS/CGC/SGC in one call
//   3. pokemontcg.io variant map (no per-condition breakdown, just per-printing market)
//      → fallback that always works, no key needed
//
// Normalized return shape (same for all three sources):
//   {
//     source: "backend" | "ppt" | "tcgdex" | "pokemontcg",
//     variants: {
//       <printingName>: {
//         conditions: { NM, LP, MP, HP, DMG },   // numbers or null
//         market: <number|null>                   // single "default" number
//       }
//     },
//     graded: {
//       <grader>: { <grade>: <price>, ... }       // e.g. graded.PSA['10'] = 4500
//     },
//     defaultVariant: <printingName|null>,
//     spreadRatio: <number>                       // max/min across printings
//   }

const BACKEND_URL = "http://127.0.0.1:3000/api/price-grid";
const HEALTH_URL  = "http://127.0.0.1:3000/api/health";
const PPT_BASE    = "https://www.pokemonpricetracker.com/api/v2/cards";
const CONDITIONS  = ["NM", "LP", "MP", "HP", "DMG"];

// ---- backend health probe (cached with TTL so we retry if the user starts the server later) ----

const BACKEND_PROBE_TTL_MS       = 60 * 1000; // reprobe every minute
const BACKEND_PROBE_FAIL_TTL_MS  = 15 * 1000; // reprobe failures sooner
let _backendProbe = { ok: false, hasPriceGrid: false, ts: 0 };

export async function probeBackend() {
  const now = Date.now();
  const age = now - _backendProbe.ts;
  const ttl = _backendProbe.ok ? BACKEND_PROBE_TTL_MS : BACKEND_PROBE_FAIL_TTL_MS;
  if (_backendProbe.ts && age < ttl) return _backendProbe.ok && _backendProbe.hasPriceGrid;
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) {
      _backendProbe = { ok: false, hasPriceGrid: false, ts: now };
      return false;
    }
    const j = await r.json().catch(() => ({}));
    _backendProbe = { ok: true, hasPriceGrid: !!j?.priceGrid, ts: now };
  } catch {
    _backendProbe = { ok: false, hasPriceGrid: false, ts: now };
  }
  return _backendProbe.ok && _backendProbe.hasPriceGrid;
}

/** Expose the raw probe state for the UI (so the pill can say "backend / backend-no-grid / off"). */
export function getBackendStatus() {
  return { ..._backendProbe };
}

// ---- key management ----

async function getPptKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("pptApiKey", (res) => resolve(res?.pptApiKey || null));
  });
}

// ---- orchestrator ----

/**
 * Fetch the condition grid for one card identity.
 * @param {{ id?: string, name?: string, set?: string, number?: string, tcgPlayerId?: number }} identity
 * @returns {Promise<Object|null>}
 */
export async function getConditionGrid(identity) {
  if (!identity?.name) return null;

  // 1. Backend proxy (JustTCG)
  if (await probeBackend()) {
    const r = await fetchBackend(identity);
    if (r) return r;
  }

  // 2. PokemonPriceTracker (user key required, needs tcgPlayerId)
  const pptKey = await getPptKey();
  if (pptKey && identity.tcgPlayerId) {
    const r = await fetchPpt(identity, pptKey);
    if (r) return r;
  }

  return null;
}

// ---- source 1: local backend ----

async function fetchBackend(identity) {
  try {
    const url = new URL(BACKEND_URL);
    if (identity.name)   url.searchParams.set("name",   identity.name);
    if (identity.set)    url.searchParams.set("set",    identity.set);
    if (identity.number) url.searchParams.set("number", identity.number);
    if (identity.id)     url.searchParams.set("id",     identity.id);
    const r = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    return normalizeBackend(j);
  } catch {
    return null;
  }
}

function normalizeBackend(j) {
  const variants = {};
  for (const [printing, grid] of Object.entries(j.variants || {})) {
    const conds = {};
    for (const c of CONDITIONS) conds[c] = typeof grid[c] === "number" ? grid[c] : null;
    variants[printing] = { conditions: conds, market: conds.NM ?? firstNonNull(conds) };
  }
  const spreadRatio = computeSpread(variants);
  return {
    source: "backend",
    variants,
    graded: j.graded || {},
    defaultVariant: pickDefaultPrinting(variants),
    spreadRatio,
  };
}

// ---- source 2: PokemonPriceTracker ----

async function fetchPpt(identity, apiKey) {
  try {
    const url = `${PPT_BASE}?tcgPlayerIds=${encodeURIComponent(identity.tcgPlayerId)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const card = Array.isArray(j?.data) ? j.data[0] : j?.data;
    if (!card) return null;
    return normalizePpt(card);
  } catch {
    return null;
  }
}

function normalizePpt(card) {
  const variants = {};
  for (const [printing, printingData] of Object.entries(card.variants || {})) {
    const cu = printingData?.conditionUsed || printingData;
    const conds = {
      NM:  numOrNull(cu.marketNearMint),
      LP:  numOrNull(cu.marketLightlyPlayed),
      MP:  numOrNull(cu.marketModeratelyPlayed),
      HP:  numOrNull(cu.marketHeavilyPlayed),
      DMG: numOrNull(cu.marketDamaged),
    };
    variants[printing] = { conditions: conds, market: conds.NM ?? firstNonNull(conds) };
  }

  // Graded block — PPT returns ebay-sourced data per grader
  const graded = {};
  if (card.ebay && typeof card.ebay === "object") {
    for (const entry of card.ebay.grades || []) {
      const parts = String(entry.grade || "").trim().split(/\s+/); // "PSA 10"
      if (parts.length < 2) continue;
      const grader = parts[0].toUpperCase();
      const grade  = parts.slice(1).join(" ");
      graded[grader] = graded[grader] || {};
      graded[grader][grade] = numOrNull(entry.averagePrice ?? entry.smartMarketPrice ?? entry.medianPrice);
    }
  }

  return {
    source: "ppt",
    variants,
    graded,
    defaultVariant: pickDefaultPrinting(variants),
    spreadRatio: computeSpread(variants),
  };
}

// ---- source 3: pokemontcg.io variant map (built from already-fetched card payload) ----

/**
 * Given a pokemontcg.io card payload (card.tcgplayer.prices), build the same shape as above
 * — minus per-condition data. Each printing gets {conditions: {NM: <market>, LP: null, ...}}.
 * This exists so the overlay always has SOMETHING to show even when neither backend nor PPT answer.
 */
export function fromPokemontcgPayload(prices, updatedAt = null) {
  const variants = {};
  if (!prices || typeof prices !== "object") return null;
  for (const [printing, p] of Object.entries(prices)) {
    const market = numOrNull(p?.market ?? p?.mid);
    if (market == null) continue;
    variants[printing] = {
      conditions: { NM: market, LP: null, MP: null, HP: null, DMG: null },
      market,
    };
  }
  if (Object.keys(variants).length === 0) return null;
  return {
    source: "pokemontcg",
    variants,
    graded: {},
    defaultVariant: pickDefaultPrinting(variants),
    spreadRatio: computeSpread(variants),
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
  };
}

// ---- source 3a: TCGdex (TCGPlayer market per printing, keyed by our catalog id) ----

const TCGDEX_PRINTING = {
  normal: "normal",
  holofoil: "holofoil",
  "reverse-holofoil": "reverseHolofoil",
  "unlimited-holofoil": "unlimitedHolofoil",
  unlimited: "unlimited",
  "1st-edition-holofoil": "1stEditionHolofoil",
  "1st-edition": "1stEditionNormal",
};

function sameText(a, b) {
  const key = (v) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return key(a) === key(b);
}

function sameNumber(a, b) {
  const key = (v) => String(v || "").split("/")[0].trim().toLowerCase().replace(/^0+(?=.)/, "");
  return key(a) === key(b);
}

/**
 * Build the grid from a TCGdex card (api.tcgdex.net/v2/en/cards/<id>). TCGdex gives one
 * TCGPlayer market price per printing, so only NM is filled. Returns null when the card
 * is not the identity we asked for, so a stale id can never price a different card.
 */
export function fromTcgdexPayload(card, identity) {
  if (!card || !sameText(card.name, identity?.name)) return null;
  if (identity?.setCode && card.set?.id && card.set.id !== identity.setCode) return null;
  if (identity?.number && card.localId && !sameNumber(card.localId, identity.number)) return null;
  const tcgplayer = card.pricing?.tcgplayer;
  if (!tcgplayer || typeof tcgplayer !== "object") return null;
  const variants = {};
  for (const [key, row] of Object.entries(tcgplayer)) {
    if (!row || typeof row !== "object") continue;
    const market = numOrNull(row.marketPrice) ?? numOrNull(row.midPrice);
    if (market == null) continue;
    variants[TCGDEX_PRINTING[key] || key] = {
      conditions: { NM: market, LP: null, MP: null, HP: null, DMG: null },
      market,
    };
  }
  if (Object.keys(variants).length === 0) return null;
  return {
    source: "tcgdex",
    variants,
    graded: {},
    defaultVariant: pickDefaultPrinting(variants),
    spreadRatio: computeSpread(variants),
    updatedAt: typeof tcgplayer.updated === "string" ? tcgplayer.updated : null,
  };
}

/** TCGPlayer product id from a TCGdex card, for the Price Tracker lookup. */
export function tcgPlayerIdFromTcgdex(card) {
  for (const row of Object.values(card?.pricing?.tcgplayer || {})) {
    if (row && typeof row === "object" && Number.isInteger(row.productId)) return row.productId;
  }
  return null;
}

// ---- helpers ----

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

function firstNonNull(conds) {
  for (const c of CONDITIONS) if (conds[c] != null) return conds[c];
  return null;
}

// Prefer holofoil > normal > reverseHolofoil > first available.
const PRINTING_PRIORITY = ["holofoil", "Holofoil", "1stEditionHolofoil", "normal", "Normal", "reverseHolofoil", "Reverse Holofoil"];
function pickDefaultPrinting(variants) {
  const keys = Object.keys(variants);
  if (keys.length === 0) return null;
  for (const p of PRINTING_PRIORITY) if (variants[p]) return p;
  return keys[0];
}

function computeSpread(variants) {
  const markets = Object.values(variants).map((v) => v.market).filter((n) => n != null && n > 0);
  if (markets.length < 2) return 1;
  return Math.max(...markets) / Math.min(...markets);
}
