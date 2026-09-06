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
    if (priceCache.has(cacheKey)) {
      return priceCache.get(cacheKey);
    }

    try {
      const cards = await searchCards(identity);
      if (cards.length === 0) {
        priceCache.set(cacheKey, null);
        return null;
      }

      const ranked = [...cards].sort((a, b) => scoreMatch(b, identity) - scoreMatch(a, identity));
      const best = ranked[0];
      if (scoreMatch(best, identity) < 5) {
        priceCache.set(cacheKey, null);
        return null;
      }

      const market = extractNearMintUsd(best);
      if (market == null) {
        priceCache.set(cacheKey, null);
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
      priceCache.set(cacheKey, result);
      return result;
    } catch (err) {
      console.error('JustTCG lookup failed:', err.message);
      return null;
    }
  }

  return { getMarketPrice, searchCards, request };
}

export { scoreMatch, normalizeNumber };
