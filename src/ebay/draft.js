// https://developer.ebay.com/api-docs/sell/inventory/resources/methods —
// Sell/Inventory API only. Creates an inventory item + unpublished offer;
// never calls the offer/{offerId}/publish endpoint, so the listing stays a
// draft until a human publishes it from the eBay seller hub.
import { createEbayAuthClient } from './auth.js';

const INVENTORY_ITEM_URL = (sku) =>
  `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
const OFFER_URL = 'https://api.ebay.com/sell/inventory/v1/offer';

export class RetryableEbayDraftError extends Error {}

function ebayError(message, status) {
  return status >= 500 ? new RetryableEbayDraftError(message) : new Error(message);
}

export function createEbayDraftClient({
  clientId = process.env.EBAY_CLIENT_ID,
  clientSecret = process.env.EBAY_CLIENT_SECRET,
  refreshToken = process.env.EBAY_REFRESH_TOKEN,
  fetchImpl = fetch,
  authClient = createEbayAuthClient({ clientId, clientSecret, refreshToken, fetchImpl }),
  marketplaceId = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US',
  categoryId = process.env.EBAY_CATEGORY_ID,
  merchantLocationKey = process.env.EBAY_MERCHANT_LOCATION_KEY,
  fulfillmentPolicyId = process.env.EBAY_FULFILLMENT_POLICY_ID,
  paymentPolicyId = process.env.EBAY_PAYMENT_POLICY_ID,
  returnPolicyId = process.env.EBAY_RETURN_POLICY_ID,
} = {}) {
  let lastConnect = null;

  async function createEbayDraft(card, { config = {} } = {}) {
    const token = await authClient.getAccessToken();
    const sku = card.id;

    const inventoryResponse = await fetchImpl(INVENTORY_ITEM_URL(sku), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        product: {
          title: card.title,
          imageUrls: card.photoUrls ?? [],
        },
        condition: config.ebayCondition ?? 'USED_EXCELLENT',
        availability: { shipToLocationAvailability: { quantity: 1 } },
      }),
    });
    if (!inventoryResponse.ok) {
      throw ebayError(`eBay inventory item create failed: ${inventoryResponse.status}`, inventoryResponse.status);
    }

    const offerResponse = await fetchImpl(OFFER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sku,
        marketplaceId,
        format: 'FIXED_PRICE',
        categoryId,
        listingDescription: card.title,
        pricingSummary: { price: { value: String(card.listPrice), currency: 'USD' } },
        listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
        merchantLocationKey,
      }),
    });
    if (!offerResponse.ok) {
      throw ebayError(`eBay offer create failed: ${offerResponse.status}`, offerResponse.status);
    }

    const offer = await offerResponse.json();
    return { offerId: offer.offerId, sku };
  }

  function getStatus() {
    const configured = Boolean(clientId && clientSecret && refreshToken);
    return {
      configured,
      connected: Boolean(lastConnect?.ok),
      at: lastConnect?.at || null,
      error: lastConnect?.error || null,
    };
  }

  async function connect() {
    try {
      await authClient.getAccessToken();
      lastConnect = { ok: true, at: new Date().toISOString(), error: null };
      return getStatus();
    } catch (err) {
      lastConnect = { ok: false, at: new Date().toISOString(), error: err.message };
      throw err;
    }
  }

  return { createEbayDraft, connect, getStatus };
}
