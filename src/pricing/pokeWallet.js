/**
 * PokéWallet TCGPlayer USD market prices — https://www.pokewallet.io/api-docs
 * GET /search returns card_info + tcgplayer.prices[] (no Pro endpoints required).
 */
const PRICE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

const DEFAULT_BASE = 'https://api.pokewallet.io';

function identityCacheKey(identity) {
  return `${identity?.name || ''}|${identity?.set || ''}|${identity?.number || ''}`;
}

function normalizeNumber(value) {
  if (value == null) {
    return '';
  }
  const raw = String(value).trim();
  const beforeSlash = raw.split('/')[0].trim();
  return beforeSlash.replace(/^0+/, '').toLowerCase();
}

function cardInfo(card) {
  return card?.card_info || card || {};
}

export function scoreMatch(card, identity) {
  const info = cardInfo(card);
  let score = 0;

  const wantName = String(identity.name || '')
    .toLowerCase()
    .replace(/\s*-\s*\d+.*/, '')
    .trim();
  const gotName = String(info.clean_name || info.name || '')
    .toLowerCase()
    .replace(/\s*-\s*\d+.*/, '')
    .trim();
  if (wantName && gotName === wantName) {
    score += 5;
  } else if (wantName && (gotName.includes(wantName) || wantName.includes(gotName))) {
    score += 2;
  }

  const wantNum = normalizeNumber(identity.number);
  const gotNum = normalizeNumber(info.card_number);
  if (wantNum && gotNum && wantNum === gotNum) {
    score += 5;
  }

  const wantSet = String(identity.set || '').toLowerCase();
  const gotSet = String(info.set_name || '').toLowerCase();
  if (wantSet && gotSet && (gotSet === wantSet || gotSet.includes(wantSet) || wantSet.includes(gotSet))) {
    score += 3;
  }

  return score;
}

/**
 * Prefer Holofoil → Normal → Reverse Holofoil TCGPlayer market_price (USD).
 * @param {{ tcgplayer?: { prices?: object[] } }} card
 * @returns {number|null}
 */
export function extractTcgMarketUsd(card) {
  const prices = Array.isArray(card?.tcgplayer?.prices) ? card.tcgplayer.prices : [];
  if (prices.length === 0) {
    return null;
  }

  const prefer = ['Holofoil', 'Normal', 'Reverse Holofoil', 'Unlimited', '1st Edition'];
  const ordered = [...prices].sort((a, b) => {
    const ai = prefer.indexOf(a.sub_type_name);
    const bi = prefer.indexOf(b.sub_type_name);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const row of ordered) {
    if (typeof row.market_price === 'number' && row.market_price > 0) {
      return row.market_price;
    }
    if (typeof row.mid_price === 'number' && row.mid_price > 0) {
      return row.mid_price;
    }
  }
  return null;
}

export function createPokeWalletClient({
  apiKey = process.env.POKEWALLET_API_KEY,
  baseUrl = process.env.POKEWALLET_API_URL || DEFAULT_BASE,
  fetchImpl = fetch,
} = {}) {
  const priceCache = new Map();

  async function request(pathname, params = {}) {
    if (!apiKey) {
      return null;
    }
    const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const url = new URL(pathname.replace(/^\//, ''), root);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetchImpl(url, {
      headers: { 'X-API-Key': apiKey },
    });
    if (!response.ok) {
      throw new Error(`PokéWallet ${pathname} failed: ${response.status}`);
    }
    return response.json();
  }

  async function searchCards(identity) {
    const q = [identity.name, identity.number, identity.set].filter(Boolean).join(' ');
    if (!q) {
      return [];
    }
    const payload = await request('/search', { q, limit: 10 });
    return Array.isArray(payload?.results) ? payload.results : [];
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

      const market = extractTcgMarketUsd(best);
      if (market == null) {
        priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const info = cardInfo(best);
      const result = {
        market: Math.round(market * 100) / 100,
        mid: null,
        source: 'pokewallet',
        currency: 'USD',
        name: info.clean_name || info.name || null,
        set: info.set_name || null,
        number: info.card_number ?? null,
        pokewalletId: best.id ?? null,
      };
      priceCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
      return result;
    } catch (err) {
      console.error('PokéWallet lookup failed:', err.message);
      return null;
    }
  }

  return { getMarketPrice, searchCards, request };
}
