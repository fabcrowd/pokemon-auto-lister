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

function normalizeSetName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Only short series codes ("SV03:", "SWSH07:"); "Generations: Radiant Collection" keeps its prefix.
    .replace(/^[A-Za-z0-9]{1,6}:\s*/, '')
    // JustTCG era prefixes on older sets: "EX Unseen Forces", "XY - Fates Collide", "SM - Team Up".
    .replace(/^(?:EX\s+|(?:XY|SM)\s+-\s+)/, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Catalog (TCGdex) set names JustTCG spells differently.
const SET_ALIASES = {
  'SVP Black Star Promos': 'SV: Scarlet & Violet Promo Cards',
  'Nintendo Black Star Promos': 'Nintendo Promos',
  'SWSH Black Star Promos': 'SWSH: Sword & Shield Promo Cards',
  'SM Black Star Promos': 'SM Promos',
  'XY Black Star Promos': 'XY Promos',
  'BW Black Star Promos': 'Black and White Promos',
  'DP Black Star Promos': 'Diamond and Pearl Promos',
  'HGSS Black Star Promos': 'HGSS Promos',
  'Wizards Black Star Promos': 'WoTC Promo',
  'Sun & Moon': 'SM Base Set',
  '151': 'SV: Scarlet & Violet 151',
};

/** JustTCG's name for the identity's set; Radiant Collection cards ("RC15") live in their own set. */
export function justTcgSetName(identity) {
  const set = String(identity?.set || '');
  if (/^RC\d/i.test(String(identity?.number || '')) && /^(Generations|Legendary Treasures)$/.test(set)) {
    return `${set}: Radiant Collection`;
  }
  return SET_ALIASES[set] || set;
}

// JustTCG names a series' first set "SV01: Scarlet & Violet Base Set"; catalogs say "Scarlet & Violet".
function setNameForms(name) {
  const n = normalizeSetName(name);
  const bare = n.replace(/baseset$/, '');
  return bare ? [n, bare] : [n];
}

/**
 * Same set across JustTCG series prefixes ("SV03: …"), accents ("Pokémon GO") and the "Base Set" suffix.
 * Exact after normalising: substring matching made Base Set equal Base Set 2 and Celebrations equal Classic Collection.
 */
export function sameSetName(a, b) {
  const x = setNameForms(a);
  const y = setNameForms(b);
  return Boolean(x[0] && y[0]) && x.some((form) => y.includes(form));
}

function containsSetName(a, b) {
  const x = normalizeSetName(a);
  const y = normalizeSetName(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
}

/**
 * Same printed card: name, plus number and set whenever the identity states them.
 * Name-only hits are refused — they priced e.g. Evolving Skies Tropius as EX Deoxys Tropius.
 */
function isSameCard(card, identity) {
  const strip = (v) => String(v || '').toLowerCase().replace(/\s*-\s*\d+.*/, '').trim();
  const want = strip(identity.name);
  const got = strip(card.name);
  if (!want || !got) return false;
  // Containment is only safe once the number pins the card ("Mew" would otherwise accept "Mewtwo").
  const namesAgree = got === want || (Boolean(identity.number) && (got.includes(want) || want.includes(got)));
  if (!namesAgree) return false;
  if (identity.number && normalizeNumber(identity.number) !== normalizeNumber(card.number)) return false;
  if (identity.set && !sameSetName(justTcgSetName(identity), card.set?.name || card.set_name)) return false;
  return true;
}

function bestMatch(cards, identity) {
  const same = cards.filter((card) => isSameCard(card, identity));
  return same.sort((a, b) => scoreMatch(b, identity) - scoreMatch(a, identity))[0] || null;
}

/**
 * Pick a raw Near Mint USD market price from v2 card variants.
 * @param {{ variants?: object[] }} card
 * @returns {number|null}
 */
function nearMintUsd(variant) {
  const markets = Array.isArray(variant?.markets) ? variant.markets : [];
  const usd =
    markets.find((m) => String(m.currency || '').toUpperCase() === 'USD' && typeof m.price === 'number') ||
    markets.find((m) => String(m.region || '').toUpperCase() === 'US' && typeof m.price === 'number');
  if (usd && typeof usd.price === 'number' && usd.price > 0) return usd.price;
  if (typeof variant?.price === 'number' && variant.price > 0) return variant.price;
  return null;
}

export function extractNearMintQuote(card) {
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

  const priced = {};
  for (const variant of ordered) {
    const price = nearMintUsd(variant);
    if (price == null || !variant.printing || priced[variant.printing] != null) continue;
    priced[variant.printing] = price;
  }
  for (const variant of ordered) {
    const price = priced[variant.printing];
    if (price == null) continue;
    return { price, printing: variant.printing, variants: priced };
  }
  return null;
}

export function extractNearMintUsd(card) {
  return extractNearMintQuote(card)?.price ?? null;
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

  let setsPromise = null;

  // One /sets call per client; free-text search alone missed most cards (e.g. Evolving Skies #6).
  async function resolveSetId(setName) {
    if (!setName) return null;
    if (!setsPromise) {
      setsPromise = request(baseUrl, '/sets', { game: 'pokemon' }).catch((err) => {
        setsPromise = null;
        throw err;
      });
    }
    const sets = (await setsPromise)?.data || [];
    const want = normalizeSetName(setName);
    const exact = sets.find((s) => setNameForms(s.name).includes(want));
    if (exact) return exact.id;
    // Only narrows the search; isSameCard still requires the exact set.
    const partial = sets
      .filter((s) => containsSetName(s.name, setName))
      .sort((a, b) => normalizeSetName(a.name).length - normalizeSetName(b.name).length);
    return partial[0]?.id ?? null;
  }

  async function searchCards(identity) {
    const q = [identity.name, identity.number, identity.set].filter(Boolean).join(' ');
    if (!q) {
      return [];
    }
    const setId = identity.name ? await resolveSetId(justTcgSetName(identity)) : null;
    const params = setId
      ? { game: 'Pokemon', set: setId, q: identity.name, limit: 20 }
      : { game: 'Pokemon', q, limit: 10 };
    const payload = await request(v2BaseUrl, '/cards', params);
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

      const best = bestMatch(cards, identity);
      if (!best) {
        priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const quote = extractNearMintQuote(best);
      if (quote == null) {
        priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const result = {
        market: Math.round(quote.price * 100) / 100,
        mid: null,
        printing: quote.printing,
        variants: quote.variants,
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
      const best = bestMatch(cards, identity);
      if (!best) return null;
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
