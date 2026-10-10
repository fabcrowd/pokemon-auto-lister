/**
 * JustTCG live market prices (USD) — https://justtcg.com/docs/quickstart
 * Prefers GET /v2/cards with Near Mint raw variants.
 */
const DEFAULT_BASE = 'https://api.justtcg.com/v1';
const DEFAULT_V2_BASE = 'https://api.justtcg.com/v2';

function identityCacheKey(identity) {
  return `${identity?.name || ''}|${identity?.set || ''}|${identity?.number || ''}`;
}

function normalizeNumber(value) {
  if (value == null) {
    return '';
  }
  // "223/197" or "GG69" → leading card number token
  const raw = String(value).trim();
  const beforeSlash = raw.split('/')[0].trim();
  return beforeSlash.replace(/^0+/, '').toLowerCase();
}

function scoreMatch(card, identity) {
  let score = 0;
  const wantName = String(identity.name || '')
    .toLowerCase()
    .replace(/\s*-\s*\d+.*/, '')
    .trim();
  const gotName = String(card.name || '')
    .toLowerCase()
    .replace(/\s*-\s*\d+.*/, '')
    .trim();
  if (wantName && gotName === wantName) {
    score += 5;
  } else if (wantName && (gotName.includes(wantName) || wantName.includes(gotName))) {
    score += 2;
  }

  const wantNum = normalizeNumber(identity.number);
  const gotNum = normalizeNumber(card.number);
  if (wantNum && gotNum && wantNum === gotNum) {
    score += 5;
  }

  const wantSet = String(identity.set || '').toLowerCase();
  const gotSet = String(card.set?.name || card.set_name || '').toLowerCase();
  if (wantSet && gotSet && (gotSet === wantSet || gotSet.includes(wantSet) || wantSet.includes(gotSet))) {
    score += 3;
  }

  return score;
}

/**
 * Pick a raw Near Mint USD market price from v2 card variants.
 * @param {{ variants?: object[] }} card
 * @returns {number|null}
 */
export function extractNearMintUsd(card) {
  const variants = Array.isArray(card?.variants) ? card.variants : [];
  const rawNm = variants.filter(
    (v) =>
      (v.type === 'raw' || !v.grading) &&
      String(v.condition || '').toLowerCase() === 'near mint' &&
      String(v.language || 'English').toLowerCase() === 'english',
  );

  const preferPrint = ['Holofoil', 'Normal', 'Reverse Holofoil'];
  const ordered = [...rawNm].sort((a, b) => {
    const ai = preferPrint.indexOf(a.printing);
    const bi = preferPrint.indexOf(b.printing);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const variant of ordered) {
    const markets = Array.isArray(variant.markets) ? variant.markets : [];
    const usd =
      markets.find((m) => String(m.currency || '').toUpperCase() === 'USD' && typeof m.price === 'number') ||
      markets.find((m) => String(m.region || '').toUpperCase() === 'US' && typeof m.price === 'number');
    if (usd && typeof usd.price === 'number' && usd.price > 0) {
      return usd.price;
    }
    // v1-style flat price field
    if (typeof variant.price === 'number' && variant.price > 0) {
      return variant.price;
    }
  }
  return null;
}

const PRICE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

export function createJustTcgClient({
  apiKey = process.env.JUSTTCG_API_KEY,
  baseUrl = process.env.JUSTTCG_API_URL || DEFAULT_BASE,
  v2BaseUrl = process.env.JUSTTCG_API_V2_URL || DEFAULT_V2_BASE,
  fetchImpl = fetch,
} = {}) {
  const priceCache = new Map();

  async function request(base, pathname, params = {}) {
    if (!apiKey) {
      return null;
    }
    const root = base.endsWith('/') ? base : `${base}/`;
    const url = new URL(pathname.replace(/^\//, ''), root);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetchImpl(url, {
      headers: { 'x-api-key': apiKey },
    });
    if (!response.ok) {
      throw new Error(`JustTCG ${pathname} failed: ${response.status}`);
    }
    return response.json();
  }

  async function searchCards(identity) {
    const q = [identity.name, identity.number, identity.set].filter(Boolean).join(' ');
    if (!q) {
      return [];
    }
    const payload = await request(v2BaseUrl, '/cards', {
      game: 'Pokemon',
      q,
      limit: 10,
    });
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  async function getMarketPrice(identity) {
    if (!apiKey || !identity?.name) {
      return null;
    }

    const cacheKey = identityCacheKey(identity);
    const cached = priceCache.get(cacheKey);
    if (cached !== undefined) {
      if (Date.now() - cached.fetchedAt <= PRICE_TTL_MS) return cached.data;
      priceCache.delete(cacheKey);
    }

    try {
      const cards = await searchCards(identity);
      if (cards.length === 0) {
        priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const ranked = [...cards].sort((a, b) => scoreMatch(b, identity) - scoreMatch(a, identity));
      const best = ranked[0];
      if (scoreMatch(best, identity) < 5) {
        priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const market = extractNearMintUsd(best);
      if (market == null) {
        priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const result = {
        market: Math.round(market * 100) / 100,
        mid: null,
        source: 'justtcg',
        currency: 'USD',
        name: best.name,
        set: best.set?.name || best.set_name || null,
        number: best.number ?? null,
        justtcgId: best.id ?? null,
      };
      priceCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
      return result;
    } catch (err) {
      console.error('JustTCG lookup failed:', err.message);
      return null;
    }
  }

  return { getMarketPrice, searchCards, request };
}

/**
 * Normalize a JustTCG condition label into the extension's NM/LP/MP/HP/DMG keys.
 */
function normalizeCondition(label) {
  const s = String(label || '').toLowerCase().trim();
  if (s === 'near mint' || s === 'nm' || s === 'mint' || s === 'm') return 'NM';
  if (s === 'lightly played' || s === 'lp') return 'LP';
  if (s === 'moderately played' || s === 'mp' || s === 'played') return 'MP';
  if (s === 'heavily played' || s === 'hp') return 'HP';
  if (s === 'damaged' || s === 'dmg' || s === 'd' || s === 'poor') return 'DMG';
  return null;
}

/**
 * Pull a USD market price out of a JustTCG variant row.
 */
function pickUsdPrice(variant) {
  const markets = Array.isArray(variant?.markets) ? variant.markets : [];
  const usd =
    markets.find((m) => String(m.currency || '').toUpperCase() === 'USD' && typeof m.price === 'number') ||
    markets.find((m) => String(m.region || '').toUpperCase() === 'US' && typeof m.price === 'number');
  if (usd && typeof usd.price === 'number') return usd.price;
  if (typeof variant?.price === 'number') return variant.price;
  return null;
}

/**
 * Build a {variants, graded} price grid from a JustTCG card payload.
 * variants = { [printing]: { NM, LP, MP, HP, DMG } }  — raw/ungraded
 * graded   = { [grader]: { [grade]: price } }         — PSA 10, BGS 9.5, etc.
 */
export function extractPriceGrid(card) {
  const rawByPrinting = {};
  const graded = {};

  for (const v of card?.variants || []) {
    const price = pickUsdPrice(v);
    if (price == null || !(price > 0)) continue;

    const isGraded = v.type === 'graded' || v.grading;
    if (isGraded) {
      const grader  = String(v.grading?.company || v.gradingCompany || 'UNK').toUpperCase();
      const gradeNm = String(v.grading?.grade   || v.grade          || '').trim();
      if (!gradeNm) continue;
      graded[grader] = graded[grader] || {};
      graded[grader][gradeNm] = Math.round(price * 100) / 100;
      continue;
    }

    const printing  = v.printing || 'Normal';
    const condition = normalizeCondition(v.condition);
    if (!condition) continue;
    rawByPrinting[printing] = rawByPrinting[printing] || { NM: null, LP: null, MP: null, HP: null, DMG: null };
    rawByPrinting[printing][condition] = Math.round(price * 100) / 100;
  }

  return { variants: rawByPrinting, graded };
}

/**
 * Attach a `getPriceGrid(identity)` method onto a client built by createJustTcgClient().
 * Returns { source: 'justtcg', variants, graded, name, set, number } or null.
 */
export function attachPriceGrid(client) {
  if (!client || typeof client.searchCards !== 'function') return client;
  if (typeof client.getPriceGrid === 'function') return client;

  client.getPriceGrid = async function getPriceGrid(identity) {
    if (!identity?.name) return null;
    try {
      const cards = await client.searchCards(identity);
      if (!cards.length) return null;
      const ranked = [...cards].sort((a, b) => scoreMatch(b, identity) - scoreMatch(a, identity));
      const best = ranked[0];
      if (scoreMatch(best, identity) < 5) return null;
      const grid = extractPriceGrid(best);
      return {
        source: 'justtcg',
        name:   best.name,
        set:    best.set?.name || best.set_name || null,
        number: best.number ?? null,
        variants: grid.variants,
        graded:   grid.graded,
      };
    } catch (err) {
      console.error('JustTCG price-grid lookup failed:', err.message);
      return null;
    }
  };
  return client;
}

export { scoreMatch, normalizeNumber, normalizeCondition, pickUsdPrice };
