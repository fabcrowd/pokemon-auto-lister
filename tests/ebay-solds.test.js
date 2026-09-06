import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEbaySoldsClient } from '../src/ebay/solds.js';

function fakeAuthFetch(searchResponder) {
  return async (url, options) => {
    if (url.includes('/identity/v1/oauth2/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'test-token', expires_in: 7200 }),
      };
    }
    if (url.includes('/item_sales/search')) {
      return searchResponder(url, options);
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

test('getRecentSolds returns up to 5 sold prices and the median', async () => {
  const fetchImpl = fakeAuthFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      itemSales: [
        { lastSoldPrice: { value: '10.00' } },
        { lastSoldPrice: { value: '50.00' } },
        { lastSoldPrice: { value: '30.00' } },
        { lastSoldPrice: { value: '20.00' } },
        { lastSoldPrice: { value: '40.00' } },
        { lastSoldPrice: { value: '999.00' } },
      ],
    }),
  }));
  const client = createEbaySoldsClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const result = await client.getRecentSolds({ name: 'Pikachu', set: 'Base Set', number: '58/102' });
  assert.deepEqual(result.prices, [10, 50, 30, 20, 40]);
  assert.equal(result.median, 30);
});

test('zero results returns empty prices and null median', async () => {
  const fetchImpl = fakeAuthFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ itemSales: [] }),
  }));
  const client = createEbaySoldsClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const result = await client.getRecentSolds({ name: 'Unknown Card', set: 'Nowhere', number: '0/0' });
  assert.deepEqual(result.prices, []);
  assert.equal(result.median, null);
});

test('query is built from card name, set, and number when present', async () => {
  let capturedUrl;
  const fetchImpl = fakeAuthFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ itemSales: [] }) };
  });
  const client = createEbaySoldsClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  await client.getRecentSolds({ name: 'Pikachu', set: 'Base Set', number: '58/102' });
  const requestedQuery = new URL(capturedUrl).searchParams.get('q');
  assert.equal(requestedQuery, 'Pikachu Base Set 58/102');
});

test('missing keys returns empty solds without calling the network', async () => {
  const client = createEbaySoldsClient({
    clientId: '',
    clientSecret: '',
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
  });
  assert.deepEqual(
    await client.getRecentSolds({ name: 'Pikachu', set: 'Base Set', number: '58/102' }),
    { prices: [], median: null },
  );
});

test('auth failure throws explicit error', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/identity/v1/oauth2/token')) {
      return { ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const client = createEbaySoldsClient({ clientId: 'id', clientSecret: 'bad', fetchImpl });
  await assert.rejects(
    () => client.getRecentSolds({ name: 'Pikachu', set: 'Base Set', number: '58/102' }),
    /eBay auth failed/,
  );
});
