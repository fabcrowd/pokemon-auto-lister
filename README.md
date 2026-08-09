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

## Inbox folder watcher (optional)

Instead of (or in addition to) the phone upload panel, drop a folder of
photos into the inbox directory (`autolist-inbox/` by default, override
with `INBOX_DIR`):

```
autolist-inbox/
  charizard-base-set/
    front.jpg
    back.jpg
    corner-detail.jpg
```

- The folder name becomes the card title.
- Any file whose name starts with `front` (case-insensitive) is used as the
  PokeGrade front image; otherwise the first image (sorted by filename) is
  used.
- Both Mercari and eBay are enabled by default for inbox drops.
- Once a folder is enqueued it is marked with a `.autolister-processed`
  file inside it, so restarting the app or re-scanning never double-enqueues
  the same drop. Delete that marker file to force a re-scan.
- Inbox drops flow through the exact same queue and pricing/draft pipeline
  as phone uploads.

## Development

```bash
npm test   # node --test tests/
npm run lint
```
