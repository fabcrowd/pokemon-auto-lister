// https://developer.ebay.com/api-docs/buy/marketplace-insights/ — official sold-item comps, no scraping.
const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_ITEM_SALES_URL = 'https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search';
const EBAY_OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights';
const MAX_SOLDS = 5;

function buildQuery(identity) {
  return [identity.name, identity.set, identity.number].filter(Boolean).join(' ');
}

function median(numbers) {
  if (numbers.length === 0) {
    return null;
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function createEbaySoldsClient({
  clientId = process.env.EBAY_CLIENT_ID,
  clientSecret = process.env.EBAY_CLIENT_SECRET,
  fetchImpl = fetch,
} = {}) {
  let accessToken = null;

  async function authenticate() {
    if (accessToken) {
      return accessToken;
    }
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetchImpl(EBAY_OAUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: EBAY_OAUTH_SCOPE,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`eBay auth failed: ${response.status}`);
    }
    const data = await response.json();
    accessToken = data.access_token;
    return accessToken;
  }

  async function getRecentSolds(identity) {
    if (!clientId || !clientSecret) {
      throw new Error('eBay configuration error: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET are not set');
    }

    const token = await authenticate();
    const query = new URLSearchParams({ q: buildQuery(identity), limit: String(MAX_SOLDS) });
    const response = await fetchImpl(`${EBAY_ITEM_SALES_URL}?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`eBay item sales lookup failed: ${response.status}`);
    }
    const data = await response.json();
    const prices = (data.itemSales ?? [])
      .slice(0, MAX_SOLDS)
      .map((sale) => Number(sale.lastSoldPrice?.value))
      .filter((value) => !Number.isNaN(value));

    return { prices, median: median(prices) };
  }

  return { getRecentSolds };
}
