/**
 * RapidAPI Pokémon TCG (tcggo) market prices — fallback when official TCGPlayer keys fail.
 * https://rapidapi.com/tcggopro/api/pokemon-tcg-api
 */
const PRICE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

const DEFAULT_HOST = 'pokemon-tcg-api.p.rapidapi.com';
const DEFAULT_BASE = `https://${DEFAULT_HOST}`;

function identityCacheKey(identity) {
  return `${identity?.name || ''}|${identity?.set || ''}|${identity?.number || ''}|${identity?.setCode || ''}`;
}

function toUsd(amount, currency, eurUsd) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return null;
  }
  const cur = String(currency || 'USD').toUpperCase();
  if (cur === 'USD') {
    return amount;
  }
  if (cur === 'EUR') {
    return amount * eurUsd;
  }
  return amount;
}

function extractRawMarketUsd(card, eurUsd) {
  const tp = card?.prices?.tcg_player;
  if (tp && typeof tp.market_price === 'number') {
    return toUsd(tp.market_price, tp.currency, eurUsd);
  }
  const cm = card?.prices?.cardmarket;
  if (cm) {
    const raw = cm['7d_average'] ?? cm.lowest_near_mint ?? cm['30d_average'];
    if (typeof raw === 'number') {
      return toUsd(raw, cm.currency, eurUsd);
    }
  }
  return null;
}

function normalizeNumber(value) {
  if (value == null) {
    return '';
  }
  return String(value).replace(/^0+/, '').toLowerCase();
}

function scoreMatch(card, identity) {
  let score = 0;
  const wantName = String(identity.name || '').toLowerCase();
  const gotName = String(card.name || '').toLowerCase();
  if (wantName && gotName === wantName) {
    score += 5;
  } else if (wantName && gotName.includes(wantName)) {
    score += 2;
  }

  const wantNum = normalizeNumber(identity.number);
  const gotNum = normalizeNumber(card.card_number);
  if (wantNum && gotNum && wantNum === gotNum) {
    score += 5;
  }

  const wantSet = String(identity.set || '').toLowerCase();
  const gotSet = String(card.episode?.name || '').toLowerCase();
  if (wantSet && gotSet && (gotSet === wantSet || gotSet.includes(wantSet) || wantSet.includes(gotSet))) {
    score += 3;
  }

  const wantCode = String(identity.setCode || '').toLowerCase();
  const gotTcgid = String(card.tcgid || '').toLowerCase();
  if (wantCode && gotTcgid && (gotTcgid === wantCode || gotTcgid.endsWith(`-${wantCode}`) || wantCode.includes(gotTcgid))) {
    score += 4;
  }

  return score;
}

export function createRapidPokemonTcgClient({
  apiKey = process.env.RAPIDAPI_KEY || process.env.RAPIDAPI_POKEMON_TCG_KEY,
  host = process.env.RAPIDAPI_POKEMON_TCG_HOST || DEFAULT_HOST,
  baseUrl = process.env.RAPIDAPI_POKEMON_TCG_URL || DEFAULT_BASE,
  eurUsd = Number.parseFloat(process.env.RAPIDAPI_EUR_USD || '1.09') || 1.09,
  fetchImpl = fetch,
} = {}) {
  const priceCache = new Map();

  async function request(pathname, params = {}) {
    if (!apiKey) {
      return null;
    }
    const url = new URL(pathname, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetchImpl(url, {
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': host,
        'x-rapidapi-key': apiKey,
      },
    });
    if (!response.ok) {
      throw new Error(`RapidAPI Pokemon TCG ${pathname} failed: ${response.status}`);
    }
    return response.json();
  }

  async function getCardById(cardId) {
    if (!cardId) {
      return null;
    }
    const payload = await request(`/cards/${encodeURIComponent(cardId)}`);
    if (!payload) {
      return null;
    }
    // API may return the card at top level or under data
    if (payload.data && !Array.isArray(payload.data) && payload.data.id != null) {
      return payload.data;
    }
    if (payload.id != null) {
      return payload;
    }
    if (Array.isArray(payload.data) && payload.data[0]) {
      return payload.data[0];
    }
    return null;
  }

  async function searchCards(identity) {
    const number = identity.number != null ? String(identity.number) : '';
    const setCode = identity.setCode ? String(identity.setCode) : '';

    if (identity.rapidapiId || identity.tcggoId) {
      const direct = await getCardById(identity.rapidapiId || identity.tcggoId);
      if (direct) {
        return [direct];
      }
    }

    // Prefer exact tcgid when setCode looks like sv3-223
    if (setCode.includes('-')) {
      const byId = await request('/cards', { tcgid: setCode, per_page: 5 });
      if (Array.isArray(byId?.data) && byId.data.length > 0) {
        return byId.data;
      }
    }

    if (identity.name && number) {
      const byNameNum = await request('/cards', {
        name: identity.name,
        card_number: number,
        per_page: 10,
        sort: 'relevance',
      });
      if (Array.isArray(byNameNum?.data) && byNameNum.data.length > 0) {
        return byNameNum.data;
      }
    }

    const search = [identity.name, number, identity.set].filter(Boolean).join(' ');
    if (!search) {
      return [];
    }
    const bySearch = await request('/cards', {
      search,
      per_page: 10,
      sort: 'relevance',
    });
    return Array.isArray(bySearch?.data) ? bySearch.data : [];
  }

  async function getMarketPrice(identity) {
    if (!apiKey || (!identity?.name && !identity?.rapidapiId && !identity?.tcggoId)) {
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
      let best = ranked[0];
      if (!identity.rapidapiId && !identity.tcggoId && scoreMatch(best, identity) < 5) {
        priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      // Hydrate list hits via GET /cards/{id} for full price payload.
      if (best?.id != null) {
        try {
          const full = await getCardById(best.id);
          if (full) {
            best = full;
          }
        } catch (err) {
          console.error(`RapidAPI card ${best.id} hydrate failed:`, err.message);
        }
      }

      const market = extractRawMarketUsd(best, eurUsd);
      if (market == null) {
        priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const result = {
        market: Math.round(market * 100) / 100,
        mid: null,
        source: 'rapidapi-pokemon-tcg',
        currency: 'USD',
        name: best.name,
        set: best.episode?.name || null,
        number: best.card_number ?? null,
        tcgid: best.tcgid || null,
        rapidapiId: best.id ?? null,
      };
      priceCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
      return result;
    } catch (err) {
      console.error('RapidAPI Pokemon TCG lookup failed:', err.message);
      return null;
    }
  }

  return { getMarketPrice, getCardById, request };
}

export { extractRawMarketUsd, scoreMatch, toUsd };
