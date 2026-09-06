# Pokémon Card Auto-Lister

Personal **Windows** toolkit that turns phone photos (or a drop folder) into **live Mercari listings** (and/or eBay drafts). Mercari posts when comps agree or you hit **Go**; eBay stays draft-only until Sell publish is wired.

```text
Phone / inbox → pick front photo
  → identity: PokeGrade /value ⊕ VellumAI (dual), or VellumAI solo if PG quota circuit is open
  → cross-check Collectr (+ TCGPlayer / eBay solds when keyed)
  → auto-list Mercari if comps agree (±15%) else Needs review → Go
  → Mercari List (Playwright + real Chrome) · eBay draft (Sell APIs)
```

**Grading** stays on PokeGrade (AI estimate — not PSA/CGC/BGS). **VellumAI** is local detect+ID only; see [tools/vellum-ai/README.md](tools/vellum-ai/README.md).

Full product spec: [docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.md](docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.md)

## Status

| Item | State |
|------|--------|
| Autopilot tasks | **14 / 14** complete (`pokemon-auto-lister` branch) |
| Tests | `npm test` — 149+ passing |
| Mercari sniper | Built (`src/sniper/`); rich Scalper panel; off until `SNIPER_ENABLED=true` |
| Live credentials | Not configured until you fill `.env` |

## Requirements

- Node.js **≥ 20**
- Windows (Task Scheduler service scripts; LAN phone upload)
- Google **Chrome** installed (Mercari drafts use Playwright `channel: 'chrome'`)
- API keys: [PokeGrade](https://pokegrade.ai/developers), [eBay Developer](https://developer.ebay.com/), [TCGPlayer](https://developer.tcgplayer.com/)

## Quick start

```powershell
cd "C:\repos\projects\auto card lister"
npm install
copy .env.example .env
# Edit .env — see sections below
npm start
```

Open on this PC: `http://127.0.0.1:3000`  
From your phone (same Wi‑Fi): `http://<PC-LAN-IP>:3000`

## Configuration

### `.env`

Copy from [`.env.example`](.env.example):

| Variable | Purpose |
|----------|---------|
| `PGAI_KEY` | PokeGrade `/value` identification + market value (+ grade when returned) |
| `VELLUM_AI_ENABLED` / `VELLUM_AI_URL` | Local VellumAI sidecar for dual/solo ID (default off) |
| `IDENTITY_MODE` | `dual` (default) · `local-only` · `pokegrade-only` |
| `POKEGRADE_CIRCUIT_TTL_HOURS` | Auto-clear PG quota circuit (default 24) |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | eBay app credentials |
| `EBAY_REFRESH_TOKEN` | User OAuth refresh token with `sell.inventory` (drafts) |
| `EBAY_*_POLICY_ID` / `EBAY_MERCHANT_LOCATION_KEY` / `EBAY_CATEGORY_ID` | Seller Hub business policies + inventory location |
| `TCGPLAYER_PUBLIC_KEY` / `TCGPLAYER_PRIVATE_KEY` | Official market/mid pricing |
| `POKEWALLET_API_KEY` | [PokéWallet](https://www.pokewallet.io/api-docs) TCGPlayer USD market comps (backup) |
| `JUSTTCG_API_KEY` | [JustTCG](https://justtcg.com/docs/quickstart) live USD Near Mint market comps |
| `RAPIDAPI_KEY` | RapidAPI Pokémon TCG market comps (tcggo) — use when official TCGPlayer keys fail |
| `RAPIDAPI_EUR_USD` | EUR→USD rate for RapidAPI prices (default `1.09`) |
| `COLLECTR_TOKEN` / `COLLECTR_USER_ID` / `COLLECTR_COLLECTION_ID` | Collectr private api-v2 portfolio sync (from app `localStorage.collectrToken`) |
| `COLLECTR_CSV` / `COLLECTR_WATCH_PATH` | CSV fallback when token unset |
| `HOST` / `PORT` | Dashboard bind (default `0.0.0.0:3000`) |
| `INBOX_DIR` | Optional folder-drop path (default `autolist-inbox`) |
| `DATA_DIR` | Runtime JSON state (default `data`) |
| `SNIPER_ENABLED` | `true` to run Mercari auto-heart scalper (default off) |
| `SNIPER_INTERVAL_MS` | Optional scan interval override (default 600000 = 10 min) |

### Collectr pricing

Full guide: [`src/collectr/README.md`](src/collectr/README.md).

Collectr has **no public Partner API** (`getcollectr.com/api` is 404). Preferred path: private web backend `api-v2.getcollectr.com` with a JWT from browser `localStorage.collectrToken` while logged into [app.getcollectr.com](https://app.getcollectr.com). Set `COLLECTR_TOKEN` + `COLLECTR_USER_ID` (optional `COLLECTR_COLLECTION_ID`). The app paginates your portfolio, caches to `data/collectr-portfolio-cache.json`, and refreshes every `COLLECTR_SYNC_INTERVAL_MS` (default 6h).

Without a token, comps fall back to portfolio CSV at `COLLECTR_CSV` (auto-import from `Downloads/export.csv`).

**WAF note:** Collectr bot protection is IP-based. Do not drive Collectr login through Cursor/DevTools automation; if login returns 401 / service-unavailable, change public IP and re-login in a normal browser, then refresh the token. See the Collectr README.

### Listing defaults

[`config/listing-defaults.json`](config/listing-defaults.json) — condition, seller-paid shipping, Smart Pricing off, per-marketplace price multipliers (default `1.0` = **0% over market**).

### Pricing / Needs review

Suggested list price = median of available comps × marketplace multiplier.

**Needs review** when PokeGrade confidence is low, **identity sources disagree** (PokeGrade vs VellumAI), VellumAI solo abstains, **or** any two of {PokeGrade, Collectr, TCGPlayer market, eBay last-5 median} differ by **>15%**. Edit price and hit **Go** to post live on Mercari.

When PokeGrade free-tier quota is exhausted, the app opens a **quota circuit**, skips further PG calls, and identifies with **VellumAI solo** (comps from Collectr/TCG/eBay). Reset from the dashboard banner or wait for `POKEGRADE_CIRCUIT_TTL_HOURS`.

## Dashboard

- **Add new cards** — shows watched `INBOX_DIR`, pending count; button runs inbox scan → detect → price → list
- **Rescan listing prices** — refresh comps for drafted/listed; flag outside ±5% of posted for review/repost
- **Current listings** — POSTED / MARKET / DELTA / HEALTH / STATUS (LIVE badge + link)
- **Needs review** — comps + editable price → **Go** / **Repost** / Skip
- **Stats** — live, drafts, total list value, queue, needs review, errors, all-time
- **LIVE toast** when Mercari publish succeeds
- **Scalper** — `// SCALPER — MERCARI HEARTS` ops panel (see below); polls `GET /api/sniper`

UI reference (sell-side): [docs/autopilot/pokemon-auto-lister/draft-activity-ui-reference.png](docs/autopilot/pokemon-auto-lister/draft-activity-ui-reference.png)

## Inbox (manual scan)

Drop a folder of photos into `autolist-inbox/` (or `INBOX_DIR`):

```text
autolist-inbox/
  charizard-base-set/
    front.jpg
    back.jpg
```

- Dashboard **Add new cards** (or `POST /api/inbox/scan`) enqueues new drops — no background auto-watch
- Folder name → card title
- Filename starting with `front` (case-insensitive) is the PokeGrade image; else first image by name
- Marketplace checkboxes set Mercari/eBay defaults for the scan
- Marker file `.autolister-processed` prevents double-enqueue (delete to re-scan)

**Flat Shared albums (iCloud):** photos are sorted by camera roll (`IMG_####`), then:

1. **Identify full fronts** and **full backs** (content heuristics — not shoot order)
2. Pair each front with the **next full-card photo as its back**
3. Attach **corner close-ups** to the best-matching front (color fingerprints vs the front + its corner crops, with a soft IMG proximity prior)

- Needs Review: **Browse inbox photos** to pick the real full-card front from `INBOX_DIR`; matching corners are rematched and identity re-runs


After listing, **Rescan listing prices** compares fresh market vs posted; drift beyond **5%** moves the card to Needs Review for **Repost** (new Mercari listing — end the old one manually if still live).

**Download photos:** Windows Shared Albums often never sync. Dashboard **Download photos** copies recent JPGs from `ICLOUD_PHOTOS_DIR` (default `%USERPROFILE%\iCloudPhotos\Photos`) into `INBOX_DIR`, then use **Add new cards**.

## Mercari live listings

- Playwright drives **real Chrome** (not bundled Chromium — PerimeterX)
- Persistent profile; **never automates login** — first time, log in when the browser waits (up to ~30 min)
- Clicks **List** when `mercariAutoPublish` is true (default) — set `false` in `config/listing-defaults.json` to Save draft instead
- Dashboard shows **LIVE** toast + link when a listing goes up
- Listing fields from `config/listing-defaults.json`

## Mercari scalper (sniper)

Internal buy-side sibling under [`src/sniper/`](src/sniper/). Same Node process and Mercari Chrome profile as the lister (page mutex). **Never buys or sends offers** — only auto-hearts.

Spec: [docs/autopilot/pokemon-mercari-sniper/pokemon-mercari-sniper.md](docs/autopilot/pokemon-mercari-sniper/pokemon-mercari-sniper.md)  
Strategies/thresholds: [`config/sniper-strategies.json`](config/sniper-strategies.json)

| Action | When |
|--------|------|
| Heart | market / ask ≥ **1.25×** |
| Offer worklist | **1.15–1.25×** |
| Suspect (no heart) | ≥ **5×** (likely junk/misread) |

Strategies: `raw-crack` (compare raw value on PSA slab searches) and `graded-under` (compare matching PSA grade).

### Scalper dashboard panel

Matches Live Activity ops chrome on the same LAN page:

- Header `// SCALPER — MERCARI HEARTS` with **OFF / ARMED / SCANNING** badge
- Threshold chips (≥1.25× heart · 1.15–1.25× worklist · ≥5× suspect)
- Stats: hearted, worklist, suspect, seen, last-cycle hearts, scan interval
- Last-cycle summary + strategy chips when armed
- Three deal tables — **Recent hearts**, **Offer worklist**, **Suspect outliers** — each row: Mercari CDN thumb, linked title, ASK / MKT / RATIO / STRAT
- Lane notes remind you hearts are bookmarks only (you still buy yourself)

API: `GET /api/sniper` returns `enabled`, `running`, `thresholds`, `strategies`, counts, `recentHearts`, `worklist`, `suspects`, `lastCycle`.

### Enable + smoke checklist

1. Mercari Chrome profile already logged in (same as sell-side).
2. Set `SNIPER_ENABLED=true` in `.env` (optional `SNIPER_INTERVAL_MS=60000` for a faster first smoke).
3. `npm start` — console should log `Sniper enabled`; badge flips to **ARMED**.
4. Wait for first cycle (~15s after boot, then on interval) — badge may show **SCANNING**.
5. Dashboard Scalper panel: last-cycle line + deal rows; or `GET /api/sniper`.
6. Confirm a hearted id appears under `data/sniper/state.json` and on Mercari likes — and that a second cycle does **not** un-heart it.
7. Turn interval back to 10 min for production; leave sniper off if you are not watching the Chrome window.

State lives in `data/sniper/` (separate from sell `data/queue/`). PokeGrade item-id cache: `data/pokegrade-item-cache.json`.

## eBay drafts

Official Sell / Inventory APIs — draft/unpublished only. Client-credentials tokens used for sold comps **cannot** create drafts; you need a user `EBAY_REFRESH_TOKEN` with inventory scope.

If eBay later requires marketplace account-deletion notifications: implement their webhook **or** file the small-seller exemption. This app does not implement the webhook.

## Run at startup (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File src\service\windows\install.ps1
```

Registers scheduled task `PokemonAutoLister` (logon + restart on failure). Prefer a stable path (not Desktop).

```powershell
powershell -ExecutionPolicy Bypass -File src\service\windows\uninstall.ps1
```

Allow inbound `PORT` in Windows Firewall for phone access. Chrome must remain installed for Mercari.

## Development

```powershell
npm test      # node --test
npm run lint  # eslint
```

Autopilot config: [`autopilot.json`](autopilot.json)  
Sell tasks (done): [`docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.json`](docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.json)  
Sniper PRD: [`docs/autopilot/pokemon-mercari-sniper/`](docs/autopilot/pokemon-mercari-sniper/)

## Layout

```text
src/
  index.js           # bootstrap: queue, clients, server, inbox, optional sniper
  server.js          # LAN HTTP + multipart Add-card + /api/sniper
  queue/             # durable sell JSON queue
  pricing/           # 15% rule + multipliers
  pokegrade/ tcgplayer/ ebay/ mercari/
  sniper/            # Mercari auto-heart scalper (separate state)
  pipeline/          # processCard
  dispatch/          # per-marketplace draft fan-out
  inbox/             # folder watcher
  service/windows/   # Task Scheduler install/uninstall
public/              # static dashboard (+ Scalper panel)
config/              # listing-defaults + sniper-strategies
data/                # runtime state (gitignored); sniper under data/sniper/
tests/
docs/autopilot/      # PRDs, tasks, CURSOR.md
HANDOFF.md           # next-session brief
```

## Safety

- Mercari goes **live** on Go / auto-agree when `mercariAutoPublish` is true — set `false` to Save draft instead
- eBay remains draft-only until Sell publish is wired
- Sniper only hearts — never buys or sends offers

## License

Private / personal use.
