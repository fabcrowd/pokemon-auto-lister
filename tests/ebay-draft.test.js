import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEbayDraftClient, RetryableEbayDraftError } from '../src/ebay/draft.js';

const CARD = {
  id: 'card-123',
  title: 'Charizard Base Set 4/102',
  listPrice: 250,
  photoUrls: ['https://example.com/front.jpg', 'https://example.com/back.jpg'],
};

const CONFIG = {
  condition: 'Like new',
};

function fakeAuthFetch(handlers) {
  return async (url, options) => {
    if (url.includes('/identity/v1/oauth2/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'test-token', expires_in: 7200 }),
      };
    }
    if (url.includes('/inventory_item/')) {
      return handlers.inventory(url, options);
    }
    if (url.includes('/sell/inventory/v1/offer')) {
      return handlers.offer(url, options);
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function draftClient(handlers) {
  return createEbayDraftClient({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    fetchImpl: fakeAuthFetch(handlers),
  });
}

test('createEbayDraft creates an unpublished inventory item and offer from the card', async () => {
  const calls = [];
  const client = draftClient({
    inventory: async (url, options) => {
      calls.push(['inventory', url, options]);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    offer: async (url, options) => {
      calls.push(['offer', url, options]);
      return { ok: true, status: 201, json: async () => ({ offerId: 'offer-1' }) };
    },
  });

  const result = await client.createEbayDraft(CARD, { config: CONFIG });

  assert.deepEqual(result, { offerId: 'offer-1', sku: 'card-123' });

  const [, , inventoryOptions] = calls.find(([action]) => action === 'inventory');
  const inventoryBody = JSON.parse(inventoryOptions.body);
  assert.deepEqual(inventoryBody.product.imageUrls, CARD.photoUrls);

  const [, , offerOptions] = calls.find(([action]) => action === 'offer');
  const offerBody = JSON.parse(offerOptions.body);
  assert.equal(offerBody.pricingSummary.price.value, '250');
  assert.equal(offerBody.sku, 'card-123');
});

test('createEbayDraft never calls a publish endpoint', async () => {
  const calls = [];
  const client = draftClient({
    inventory: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    offer: async (url) => {
      calls.push(url);
      return { ok: true, status: 201, json: async () => ({ offerId: 'offer-1' }) };
    },
  });

  await client.createEbayDraft(CARD, { config: CONFIG });

  assert.ok(calls.every((url) => !url.includes('/publish')));
});

test('5xx inventory error throws a retryable error', async () => {
  const client = draftClient({
    inventory: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    offer: async () => {
      throw new Error('offer should not be called after inventory failure');
    },
  });

  await assert.rejects(() => client.createEbayDraft(CARD, { config: CONFIG }), RetryableEbayDraftError);
});

test('4xx offer error throws a non-retryable error', async () => {
  const client = draftClient({
    inventory: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    offer: async () => ({ ok: false, status: 400, json: async () => ({ errors: ['bad request'] }) }),
  });

  await assert.rejects(
    (async () => {
      try {
        await client.createEbayDraft(CARD, { config: CONFIG });
      } catch (err) {
        assert.ok(!(err instanceof RetryableEbayDraftError));
        throw err;
      }
    })(),
    /eBay offer create failed: 400/,
  );
});

test('missing refresh token throws explicit configuration error', async () => {
  const client = createEbayDraftClient({
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
  });

  await assert.rejects(
    () => client.createEbayDraft(CARD, { config: CONFIG }),
    /eBay configuration error/,
  );
});
