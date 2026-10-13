/**
 * pokemontcg.io free API — returns TCGPlayer USD + CardMarket EUR prices in one call.
 * https://docs.pokemontcg.io — free tier: 1000 req/day; set POKEMON_TCG_API_KEY for higher limits.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_BASE = 'https://api.pokemontcg.io/v2';
const TTL_MS = 4 * 60 * 60 * 1000; // 4h — prices update daily

function identityCacheKey(identity) {
  return `${identity?.pokemontcgId || ''}|${identity?.name || ''}|${identity?.set || ''}|${identity?.number || ''}`;
}

function normalizeNumber(value) {
  if (value == null) return '';
  return String(value).split('/')[0].trim().replace(/^0+/, '').toLowerCase();
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * pokemontcg.io ids for a TCGdex catalog id: sv03.5-071 → sv3pt5-71, svp-078 → svp-78,
 * swsh12.5gg-GG04 → swsh12pt5gg-GG04 (same mapping that recovered catalog art).
 */
export function pokemontcgIdCandidates(catalogId) {
  const m = /^([A-Za-z0-9.]+)-([A-Za-z0-9]+)$/.exec(String(catalogId || ''));
  if (!m) return [];
  const [, set, number] = m;
  const sets = [set, set.replace(/\./g, ''), set.replace('.5', 'pt5')];
  const allSets = [...sets, ...sets.map((f) => f.replace(/([a-z])0+(\d)/, '$1$2'))];
  const numbers = [number, number.replace(/^([A-Za-z]*)0+(\d)/, '$1$2')];
  const out = [];
  for (const sid of allSets) for (const num of numbers) out.push(`${sid}-${num}`);
  return [...new Set(out)];
}

function scoreMatch(card, identity) {
  let score = 0;

  const wantName = String(identity.name || '').toLowerCase().replace(/\s*-\s*\d+.*/, '').trim();
  const gotName = String(card.name || '').toLowerCase().replace(/\s*-\s*\d+.*/, '').trim();
  if (wantName && gotName === wantName) score += 5;
  else if (wantName && (gotName.includes(wantName) || wantName.includes(gotName))) score += 2;

  const wantNum = normalizeNumber(identity.number);
  const gotNum = normalizeNumber(card.number);
  if (wantNum && gotNum && wantNum === gotNum) score += 5;

  const wantSet = String(identity.set || '').toLowerCase();
  const gotSet = String(card.set?.name || '').toLowerCase();
  if (wantSet && gotSet && (gotSet === wantSet || gotSet.includes(wantSet) || wantSet.includes(gotSet))) score += 3;

  const wantCode = String(identity.setCode || '').toLowerCase();
  const gotCode = String(card.set?.id || '').toLowerCase();
  if (wantCode && gotCode && (gotCode === wantCode || gotCode.includes(wantCode))) score += 4;

  return score;
}

function rowUsd(row) {
  if (typeof row?.market === 'number' && row.market > 0) return row.market;
  if (typeof row?.mid === 'number' && row.mid > 0) return row.mid;
  return null;
}

function extractTcgplayerQuote(card) {
  const prices = card?.tcgplayer?.prices;
  if (!prices || typeof prices !== 'object') return null;
  const prefer = ['holofoil', 'normal', 'reverseHolofoil', 'unlimitedHolofoil', 'unlimited', '1stEditionHolofoil', '1stEdition'];
  const variants = {};
  for (const [key, row] of Object.entries(prices)) {
    const price = rowUsd(row);
    if (price != null) variants[key] = price;
  }
  const printing = prefer.find((key) => variants[key] != null) || Object.keys(variants)[0];
  if (!printing) return null;
  return { price: variants[printing], printing, variants };
}

function extractTcgplayerUsd(card) {
  return extractTcgplayerQuote(card)?.price ?? null;
}

function extractCardmarketEur(card) {
  const cm = card?.cardmarket?.prices;
  if (!cm || typeof cm !== 'object') return null;
  const market = typeof cm.trendPrice === 'number' && cm.trendPrice > 0 ? cm.trendPrice : null;
  const avg7 = typeof cm.avg7 === 'number' && cm.avg7 > 0 ? cm.avg7 : null;
  const avg30 = typeof cm.avg30 === 'number' && cm.avg30 > 0 ? cm.avg30 : null;
  if (market == null && avg7 == null && avg30 == null) return null;
  return { market, avg7, avg30, currency: 'EUR' };
}

export function createPokemonTcgApiClient({
  apiKey = process.env.POKEMON_TCG_API_KEY,
  baseUrl = process.env.POKEMON_TCG_API_URL || DEFAULT_BASE,
  fetchImpl = fetch,
  retryDelayMs = 2000,
  timeoutMs = 10_000,
} = {}) {
  const cache = new Map();

  function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt > TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  function setCached(key, data) {
    cache.set(key, { data, fetchedAt: Date.now() });
  }

  async function request(pathname, params = {}) {
    const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const url = new URL(pathname.replace(/^\//, ''), root);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = apiKey ? { 'X-Api-Key': apiKey } : {};
    // The keyless tier returns sporadic 500s that succeed on retry.
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await sleep(retryDelayMs * attempt);
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status < 500) break;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`pokemontcg.io ${pathname} failed: ${response.status}`);
    return response.json();
  }

  async function getCardById(cardId) {
    if (!cardId) return null;
    const cached = getCached(`id:${cardId}`);
    if (cached !== undefined) return cached;
    const payload = await request(`/cards/${encodeURIComponent(cardId)}`);
    const card = payload?.data ?? null;
    setCached(`id:${cardId}`, card);
    return card;
  }

  async function searchCard(identity) {
    const parts = [];
    const quoted = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (identity.name) parts.push(`name:"${quoted(identity.name)}"`);
    if (identity.number) parts.push(`number:${normalizeNumber(identity.number)}`);
    if (identity.setCode) parts.push(`set.id:${identity.setCode}`);
    else if (identity.set) parts.push(`set.name:"${quoted(identity.set)}"`);
    if (!parts.length) return null;
    const payload = await request('/cards', { q: parts.join(' '), pageSize: 10 });
    const cards = Array.isArray(payload?.data) ? payload.data : [];
    if (!cards.length) return null;
    const ranked = [...cards].sort((a, b) => scoreMatch(b, identity) - scoreMatch(a, identity));
    const best = ranked[0];
    return scoreMatch(best, identity) >= 5 ? best : null;
  }

  async function getPrices(identity) {
    if (!identity?.name && !identity?.pokemontcgId) return null;

    const cacheKey = identityCacheKey(identity);
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached;

    try {
      let card = null;

      if (identity.pokemontcgId) {
        card = await getCardById(identity.pokemontcgId);
      }
      // Catalog identities carry the TCGdex id; the exact card beats a name/set search.
      for (const candidate of card ? [] : pokemontcgIdCandidates(identity.productId)) {
        const hit = await getCardById(candidate);
        if (hit && normalizeName(hit.name) === normalizeName(identity.name)) {
          card = hit;
          break;
        }
      }
      // A valid catalog id that misses must not degrade to a name search (Pikachu has 100+ prints).
      if (!card && pokemontcgIdCandidates(identity.productId).length === 0) {
        card = await searchCard(identity);
      }
      if (!card) {
        setCached(cacheKey, null);
        return null;
      }

      const tcgQuote = extractTcgplayerQuote(card);
      const tcgUsd = tcgQuote?.price ?? null;
      const cmEur = extractCardmarketEur(card);

      if (tcgUsd == null && cmEur == null) {
        setCached(cacheKey, null);
        return null;
      }

      const result = {
        source: 'pokemontcg-io',
        pokemontcgId: card.id ?? null,
        name: card.name ?? null,
        set: card.set?.name ?? null,
        number: card.number ?? null,
        tcgplayer: tcgUsd != null ? {
          market: Math.round(tcgUsd * 100) / 100,
          mid: null,
          currency: 'USD',
          printing: tcgQuote.printing,
          variants: tcgQuote.variants,
        } : null,
        cardmarket: cmEur,
      };

      setCached(cacheKey, result);
      return result;
    } catch (err) {
      console.error('pokemontcg.io lookup failed:', err.message);
      return null;
    }
  }

  return { getPrices, getCardById, searchCard };
}

export { extractTcgplayerUsd, extractCardmarketEur, scoreMatch };
