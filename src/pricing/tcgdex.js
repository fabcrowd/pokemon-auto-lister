/**
 * TCGdex free API — TCGplayer USD + Cardmarket EUR prices on each card, no key, no daily quota.
 * The local catalog uses TCGdex ids, so a VellumAI identity prices its exact product with one lookup
 * (no name/set search to get wrong). https://tcgdex.dev
 */
const DEFAULT_BASE = 'https://api.tcgdex.net/v2/en';
const TTL_MS = 4 * 60 * 60 * 1000; // prices update daily
// ECB reference rates (keyless); published once per working day.
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD';
const FX_TTL_MS = 12 * 60 * 60 * 1000;
const FX_RETRY_MS = 10 * 60 * 1000;

// Highest-value printing first, matching justTcg's Holofoil > Normal > Reverse preference.
const PRINT_PREFERENCE = [
  'holofoil',
  'normal',
  'reverse-holofoil',
  'unlimited-holofoil',
  'unlimited',
  '1st-edition-holofoil',
  '1st-edition',
];

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeNumber(value) {
  return String(value || '').split('/')[0].trim().toLowerCase().replace(/^0+(?=.)/, '');
}

/** TCGdex card id for an identity: the catalog productId, else `${setCode}-${number}`. */
export function tcgdexIdFor(identity) {
  const productId = String(identity?.productId || '');
  if (/^[A-Za-z0-9.]+-[A-Za-z0-9]+$/.test(productId)) return productId;
  if (identity?.setCode && identity?.number) return `${identity.setCode}-${identity.number}`;
  return null;
}

function tcgplayerPrice(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.marketPrice > 0) return row.marketPrice;
  if (row.midPrice > 0) return row.midPrice;
  return null;
}

/** USD market price from a TCGdex `pricing.tcgplayer` block, by printing preference. */
export function extractTcgdexQuote(tcgplayer) {
  if (!tcgplayer || typeof tcgplayer !== 'object') return null;
  const variants = Object.entries(tcgplayer).filter(([, row]) => tcgplayerPrice(row) != null);
  const rank = ([key]) => {
    const i = PRINT_PREFERENCE.indexOf(key);
    return i === -1 ? PRINT_PREFERENCE.length : i;
  };
  const priced = Object.fromEntries(variants.map(([key, row]) => [key, tcgplayerPrice(row)]));
  const [printing, row] = variants.sort((a, b) => rank(a) - rank(b))[0] || [];
  const price = tcgplayerPrice(row);
  if (price == null) return null;
  return { price, printing, variants: priced };
}

export function extractTcgdexUsd(tcgplayer) {
  return extractTcgdexQuote(tcgplayer)?.price ?? null;
}

const GRID_PRINTING = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  'reverse-holofoil': 'Reverse Holofoil',
  'unlimited-holofoil': 'Unlimited Holofoil',
  unlimited: 'Unlimited',
  '1st-edition-holofoil': '1st Edition Holofoil',
  '1st-edition': '1st Edition',
};

/**
 * Extension price grid from a TCGdex card. TCGdex has one market price per printing, not per
 * condition, so it fills NM only; graded prices are unavailable.
 */
export function tcgdexPriceGrid(card) {
  const variants = {};
  for (const [key, row] of Object.entries(card?.pricing?.tcgplayer || {})) {
    if (!row || typeof row !== 'object') continue;
    const price = row.marketPrice > 0 ? row.marketPrice : row.midPrice > 0 ? row.midPrice : null;
    if (price == null) continue;
    variants[GRID_PRINTING[key] || key] = { NM: Math.round(price * 100) / 100, LP: null, MP: null, HP: null, DMG: null };
  }
  if (!Object.keys(variants).length) return null;
  return {
    source: 'tcgdex',
    name: card.name ?? null,
    set: card.set?.name ?? null,
    number: card.localId ?? null,
    variants,
    graded: {},
  };
}

/**
 * Cardmarket EUR for the card itself. TCGdex's "-holo" fields are the reverse-holo/foil variant
 * (Victreebel 151: avg 0.08, avg-holo 0.24) — a different product, so never used.
 */
function cardmarketEur(cardmarket) {
  if (!cardmarket || typeof cardmarket !== 'object') return null;
  for (const key of ['trend', 'avg30', 'avg']) {
    if (cardmarket[key] > 0) return cardmarket[key];
  }
  return null;
}

/**
 * Cached EUR→USD lookup. On failure it keeps the last good rate (a day-old ECB rate beats none) and
 * waits FX_RETRY_MS before asking again; null only when no rate was ever fetched.
 */
export function ecbEurUsdRate({ fetchImpl = fetch, url = FX_URL, now = Date.now } = {}) {
  let cached = null;
  let retryAt = 0;
  return async function eurUsdRate() {
    if (cached && now() - cached.at <= FX_TTL_MS) return cached.rate;
    if (now() < retryAt) return cached?.rate ?? null;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rate = (await response.json())?.rates?.USD;
      // Sanity bounds: EUR/USD has stayed within 0.8-1.6 since the euro launched.
      if (!(rate > 0.5 && rate < 2)) throw new Error(`implausible USD rate ${rate}`);
      cached = { rate, at: now() };
      return rate;
    } catch (err) {
      retryAt = now() + FX_RETRY_MS;
      console.error('EUR→USD rate unavailable:', err.message, cached ? '(using last good rate)' : '(Cardmarket-only cards stay unpriced)');
      return cached?.rate ?? null;
    }
  };
}

export function createTcgdexClient({
  baseUrl = process.env.TCGDEX_API_URL || DEFAULT_BASE,
  fetchImpl = fetch,
  eurUsdRate = ecbEurUsdRate({ fetchImpl }),
} = {}) {
  const cache = new Map();

  async function getCard(id) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.fetchedAt <= TTL_MS) return hit.card;
    const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetchImpl(new URL(`cards/${encodeURIComponent(id)}`, root));
    if (response.status === 404) {
      cache.set(id, { card: null, fetchedAt: Date.now() });
      return null;
    }
    if (!response.ok) throw new Error(`TCGdex /cards/${id} failed: ${response.status}`);
    const card = await response.json();
    cache.set(id, { card, fetchedAt: Date.now() });
    return card;
  }

  async function getMatchingCard(identity) {
    const id = tcgdexIdFor(identity);
    if (!id || !identity?.name) return null;
    const card = await getCard(id);
    // A wrong id (stale catalog, PokeGrade-style productId) must not price a different card:
    // name, and set + number whenever the identity states them.
    if (!card || normalizeName(card.name) !== normalizeName(identity.name)) return null;
    if (identity.setCode && card.set?.id && card.set.id !== identity.setCode) return null;
    if (identity.number && card.localId && normalizeNumber(card.localId) !== normalizeNumber(identity.number)) return null;
    return card;
  }

  async function getPriceGrid(identity) {
    const card = await getMatchingCard({ ...identity, productId: identity?.productId || identity?.id });
    return card ? tcgdexPriceGrid(card) : null;
  }

  async function getMarketPrice(identity) {
    const card = await getMatchingCard(identity);
    if (!card) return null;
    const id = tcgdexIdFor(identity);
    const quote = extractTcgdexQuote(card.pricing?.tcgplayer);
    let market = quote?.price ?? null;
    let basis = 'tcgplayer';
    // Trainer Gallery, Galarian Gallery, Radiant Collection and many promos have Cardmarket prices only.
    const eur = market == null ? cardmarketEur(card.pricing?.cardmarket) : null;
    if (eur != null) {
      const rate = await eurUsdRate();
      if (rate) {
        market = eur * rate;
        basis = 'cardmarket-eur';
      }
    }
    if (market == null) return null;
    return {
      market: Math.round(market * 100) / 100,
      mid: null,
      printing: quote?.printing ?? null,
      variants: quote?.variants ?? null,
      source: 'tcgdex',
      basis,
      eur,
      currency: 'USD',
      name: card.name,
      set: card.set?.name ?? null,
      number: card.localId ?? null,
      productId: card.id ?? id,
      cardmarket: card.pricing?.cardmarket ?? null,
    };
  }

  return { getMarketPrice, getPriceGrid, getCard };
}
