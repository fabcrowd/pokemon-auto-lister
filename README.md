# Pokémon Card Auto-Lister

Personal Windows toolkit that turns phone photos into Mercari and/or eBay drafts (never published).

Full spec: [docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.md](docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.md)

## Setup

```bash
npm install
cp .env.example .env   # fill in PGAI_KEY, EBAY_*, TCGPLAYER_* credentials
```

### eBay developer setup

`EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` come from an eBay developer account
(https://developer.ebay.com/my/keys). `EBAY_REFRESH_TOKEN` requires
completing the user-consent OAuth flow once for the `sell.inventory` scope —
client-credentials tokens (used for sold-comp lookups) cannot call Sell
APIs. `EBAY_MERCHANT_LOCATION_KEY`, `EBAY_FULFILLMENT_POLICY_ID`,
`EBAY_PAYMENT_POLICY_ID`, and `EBAY_RETURN_POLICY_ID` come from the seller's
existing Business Policies and inventory location in Seller Hub.

If your eBay developer account is later used to receive marketplace account
deletion/closure notifications, eBay requires either implementing that
webhook or filing for the small-seller exemption in the developer portal —
this app does not implement the webhook.

## Run the dashboard

```bash
npm start
```

Binds to `HOST:PORT` from `.env` (LAN interface) so phones on the same Wi-Fi can reach `http://<PC-LAN-IP>:<PORT>`.

## Development

```bash
npm test   # node --test tests/
npm run lint
```
