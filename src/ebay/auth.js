const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

export async function fetchEbayAccessToken({
  clientId,
  clientSecret,
  fetchImpl = fetch,
  grantType = 'client_credentials',
  scope,
} = {}) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: grantType, scope });
  const response = await fetchImpl(EBAY_OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`eBay OAuth failed: ${response.status}`);
  }
  const data = await response.json();
  return data.access_token;
}
