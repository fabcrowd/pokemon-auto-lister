// https://developer.ebay.com/api-docs/static/oauth-tokens.html — shared OAuth token exchange for eBay's Buy and Sell APIs.
const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

export async function fetchEbayAccessToken({ clientId, clientSecret, fetchImpl = fetch, grantType, scope, refreshToken }) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const params = { grant_type: grantType, scope };
  if (grantType === 'refresh_token') {
    params.refresh_token = refreshToken;
  }

  const response = await fetchImpl(EBAY_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new Error(`eBay auth failed: ${response.status}`);
  }
  const data = await response.json();
  return data.access_token;
}

export const EBAY_SELL_INVENTORY_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.inventory';

export function createEbayAuthClient({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
  scope = EBAY_SELL_INVENTORY_SCOPE,
} = {}) {
  let accessToken = null;

  async function getAccessToken() {
    if (accessToken) {
      return accessToken;
    }
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        'eBay configuration error: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET/EBAY_REFRESH_TOKEN are not set',
      );
    }
    accessToken = await fetchEbayAccessToken({
      clientId,
      clientSecret,
      fetchImpl,
      grantType: 'refresh_token',
      scope,
      refreshToken,
    });
    return accessToken;
  }

  return { getAccessToken };
}
