// https://docs.tcgplayer.com/ — official market/mid pricing only, no scraped solds.
const PRICE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

const TCGPLAYER_TOKEN_URL = 'https://api.tcgplayer.com/token';
const TCGPLAYER_CATALOG_URL = 'https://api.tcgplayer.com/catalog/products';
const TCGPLAYER_PRICING_URL = 'https://api.tcgplayer.com/pricing/product';

function identityCacheKey(identity) {
  return `${identity.name}|${identity.set}|${identity.number}`;
}

export function createTcgplayerClient({
  publicKey = process.env.TCGPLAYER_PUBLIC_KEY,
  privateKey = process.env.TCGPLAYER_PRIVATE_KEY,
  fetchImpl = fetch,
} = {}) {
  let accessToken = null;
  const priceCache = new Map();

  async function authenticate() {
    if (accessToken) {
      return accessToken;
    }
    const response = await fetchImpl(TCGPLAYER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: publicKey,
        client_secret: privateKey,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`TCGPlayer auth failed: ${response.status}`);
    }
    const data = await response.json();
    accessToken = data.access_token;
    return accessToken;
  }

  async function findProductId(identity, token) {
    const query = new URLSearchParams({
      productName: identity.name,
      setName: identity.set,
    });
    const response = await fetchImpl(`${TCGPLAYER_CATALOG_URL}?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`TCGPlayer catalog lookup failed: ${response.status}`);
    }
    const data = await response.json();
    return data.results?.[0]?.productId ?? null;
  }

  async function fetchPricing(productId, token) {
    const response = await fetchImpl(`${TCGPLAYER_PRICING_URL}/${productId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`TCGPlayer pricing lookup failed: ${response.status}`);
    }
    const data = await response.json();
    const priceRow = data.results?.[0];
    if (!priceRow) {
      return null;
    }
    return { market: priceRow.marketPrice ?? null, mid: priceRow.midPrice ?? null };
  }

  async function getMarketPrice(identity) {
    if (!publicKey || !privateKey) {
      return null;
    }

    const cacheKey = identityCacheKey(identity);
    const cached = priceCache.get(cacheKey);
    if (cached !== undefined) {
      if (Date.now() - cached.fetchedAt <= PRICE_TTL_MS) return cached.data;
      priceCache.delete(cacheKey);
    }

    const token = await authenticate();
    const productId = await findProductId(identity, token);
    if (productId === null) {
      priceCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
      return null;
    }

    const pricing = await fetchPricing(productId, token);
    priceCache.set(cacheKey, { data: pricing, fetchedAt: Date.now() });
    return pricing;
  }

  return { getMarketPrice };
}
