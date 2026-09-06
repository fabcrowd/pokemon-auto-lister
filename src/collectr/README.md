# Collectr pricing sync

How this app gets Collectr market prices for listing comps — without a public Collectr Partner API.

## Short version

| Mode | When | What happens |
|------|------|----------------|
| **api-v2** (preferred) | `COLLECTR_TOKEN` + `COLLECTR_USER_ID` in `.env` | Paginate your portfolio from `api-v2.getcollectr.com`, cache to disk, refresh on an interval |
| **CSV** (fallback) | Token unset | Watch `Downloads/export.csv` (or `COLLECTR_WATCH_PATH`) and load `COLLECTR_CSV` |

There is **no** public Partner API (`getcollectr.com/api` → 404). The web/app backend is private and JWT-gated.

## How comps are used

After PokeGrade (or VellumAI) identifies a card, pricing pulls Collectr as one market-price source:

```text
identity (name / set / number)
  → collectrClient.getMarketPrice(identity)
  → { market, mid: null, name, set, number, source }
  → decidePrice() comps.collectr
```

Lookup order (same for API and CSV): **exact** name+set+number → name+number → name+set.

## api-v2 mode (portfolio sync)

### Auth

1. Log into [app.getcollectr.com](https://app.getcollectr.com) in a **normal** browser (not Cursor DevTools-controlled Chrome).
2. DevTools console:

```js
JSON.parse(localStorage.getItem('collectrToken'))
// → { username, token }
```

3. Put in `.env` (gitignored):

```env
COLLECTR_TOKEN=<jwt>
COLLECTR_USER_ID=<username uuid from that object>
COLLECTR_COLLECTION_ID=<optional; auto-resolved from /accounts/.../collections if empty>
COLLECTR_API_BASE_URL=https://api-v2.getcollectr.com
COLLECTR_SYNC_INTERVAL_MS=21600000
```

4. `npm start` — CSV export watcher is skipped; portfolio sync runs immediately and every `COLLECTR_SYNC_INTERVAL_MS` (default 6h).

### Endpoints we use

| Call | Purpose |
|------|---------|
| `GET /accounts/{userId}/collections?details=true` | Resolve `collectionId` if not set |
| `GET /collections/{userId}/products?collectionId=&offset=&limit=30&…` | Paginated portfolio rows with `market_price` |

Also observed (not required for sync): `GET /catalog?…&groupId=` for set catalogs with `latest_price`.

### Cache

Successful syncs write `data/collectr-portfolio-cache.json` (under gitignored `data/`). Cold start can hydrate from cache if the live sync fails temporarily.

### Dashboard

`GET /api/collectr-status` → banner shows api-v2 OK / stale / sync error. Needs-review comps list Collectr as a normal source.

## CSV fallback

If `COLLECTR_TOKEN` is unset:

1. Export portfolio CSV from the Collectr app (PRO export).
2. Save/overwrite as `%USERPROFILE%\Downloads\export.csv` (or set `COLLECTR_WATCH_PATH`).
3. App copies newer exports into `COLLECTR_CSV` (default `data/collectr-export.csv`) and reloads.

Stale after 24h (file mtime) — banner reminds you to re-export.

## Code map

| File | Role |
|------|------|
| [`client.js`](client.js) | Facade: api-v2 if token, else CSV; starts portfolio sync timer |
| [`apiV2.js`](apiV2.js) | JWT client, pagination, cache, `getMarketPrice` |
| [`catalog.js`](catalog.js) | CSV portfolio loader |
| [`exportWatcher.js`](exportWatcher.js) | Downloads → `COLLECTR_CSV` (CSV mode only) |
| [`match.js`](match.js) | Shared normalize / identity keys |

Wired from `src/index.js`; pricing pipeline: `src/pipeline/processCard.js` → `src/pricing/pricing.js`.

## WAF / IP blocks (ops lesson)

Collectr protects `api-v2` and login with **AWS WAF**. Aggressive probing, automation (e.g. Cursor DevTools MCP on the auth tab), or hammering resend can flag your **public IP**.

Symptoms:

- Login page: “Something went wrong” / disable VPN or adblocker
- `POST /auth/verify/email` or `/auth/verify/referrer` → **401**
- App redirects to `/service-unavailable`
- Same failure on phone **while on the same Wi‑Fi**

Recovery:

1. Stop all Collectr API/login retries (including this app’s sync and DevTools automation on Collectr tabs).
2. Change public IP (disconnect/reconnect modem, different network, or cellular **without** home Wi‑Fi).
3. Log in on a **normal** browser/profile — not the agent-controlled Chrome.
4. Refresh `COLLECTR_TOKEN` / `COLLECTR_USER_ID` in `.env` and restart.

If still blocked after a new IP: email `contact@getcollectr.com`.

**Do not** scrape or drive Collectr login through automation to “fix” WAF — that makes the flag worse.

## Safety

- Never commit `.env` or paste JWTs into git.
- Token is a session credential; rotate by logging out/in on Collectr and updating `.env`.
- This path uses Collectr’s private app API (unofficial). Prefer low request rates (default 6h sync).
