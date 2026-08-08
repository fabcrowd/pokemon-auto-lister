import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTcgplayerClient } from '../src/tcgplayer/client.js';

function fakeAuthFetch(pricingResponder) {
  return async (url, options) => {
    if (url.includes('/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'test-token', expires_in: 1209600 }),
      };
    }
    if (url.includes('/catalog/products')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ productId: 12345 }] }),
      };
    }
    if (url.includes('/pricing/product/')) {
      return pricingResponder(url, options);
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

test('getMarketPrice returns numeric market and mid for a matched product', async () => {
  const fetchImpl = fakeAuthFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [{ marketPrice: 19.99, midPrice: 18.5 }] }),
  }));
  const client = createTcgplayerClient({ publicKey: 'pub', privateKey: 'priv', fetchImpl });
  const result = await client.getMarketPrice({ name: 'Pikachu', set: 'Base Set', number: '58/102' });
  assert.equal(result.market, 19.99);
  assert.equal(result.mid, 18.5);
});

test('unmatched product returns null without throwing', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 1209600 }) };
    }
    if (url.includes('/catalog/products')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const client = createTcgplayerClient({ publicKey: 'pub', privateKey: 'priv', fetchImpl });
  const result = await client.getMarketPrice({ name: 'Unknown Card', set: 'Nowhere', number: '0/0' });
  assert.equal(result, null);
});

test('missing keys throws explicit configuration error', async () => {
  const client = createTcgplayerClient({
    publicKey: '',
    privateKey: '',
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
  });
  await assert.rejects(
    () => client.getMarketPrice({ name: 'Pikachu', set: 'Base Set', number: '58/102' }),
    /TCGPlayer configuration error/,
  );
});

test('auth failure throws explicit error', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/token')) {
      return { ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const client = createTcgplayerClient({ publicKey: 'pub', privateKey: 'bad', fetchImpl });
  await assert.rejects(
    () => client.getMarketPrice({ name: 'Pikachu', set: 'Base Set', number: '58/102' }),
    /TCGPlayer auth failed/,
  );
});

test('results are cached in memory to spare rate limits on repeat lookups', async () => {
  let catalogCalls = 0;
  let pricingCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 1209600 }) };
    }
    if (url.includes('/catalog/products')) {
      catalogCalls += 1;
      return { ok: true, status: 200, json: async () => ({ results: [{ productId: 12345 }] }) };
    }
    if (url.includes('/pricing/product/')) {
      pricingCalls += 1;
      return { ok: true, status: 200, json: async () => ({ results: [{ marketPrice: 19.99, midPrice: 18.5 }] }) };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const client = createTcgplayerClient({ publicKey: 'pub', privateKey: 'priv', fetchImpl });
  const identity = { name: 'Pikachu', set: 'Base Set', number: '58/102' };
  await client.getMarketPrice(identity);
  await client.getMarketPrice(identity);
  assert.equal(catalogCalls, 1);
  assert.equal(pricingCalls, 1);
});
