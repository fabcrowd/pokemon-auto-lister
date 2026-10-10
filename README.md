# Pokémon Card Scanner

Personal **Windows** toolkit that scans Pokémon TCG card photos, identifies each card, and returns current market prices.

Three pieces live in this repo:

1. **Node dashboard + API** (project root) — upload a photo (single card or a multi-card spread) and get identity + price grid per card. Bind is LAN-wide, so it works from a phone on the same Wi‑Fi.
2. **VellumAI** ([`tools/vellum-ai/`](tools/vellum-ai/README.md)) — local Python detect + identify sidecar (YOLO detector, CLIP/FAISS catalog retrieval, OCR).
3. **Chrome extensions**
   - `dist/extension-wasm/` — standalone end-user build that overlays prices on any webpage. **Not in git** (`dist/` is gitignored); install steps in its `INSTALL.md`. When the dashboard is running it uses `GET /api/price-grid` for per-condition JustTCG pricing.
   - [`tools/chrome-extension/`](tools/chrome-extension/) — dev extension that talks to the VellumAI extension sidecar (`tools/vellum-ai/server.py`, port 7331).

```text
Photo (single or multi-card spread)
  → multi-card detection: VellumAI detector → rectified crop per card
  → identity: PokeGrade ⊕ VellumAI (dual), VellumAI only (local-only), or PokeGrade only
  → comps: PokeGrade value, Collectr, TCGPlayer, eBay solds, JustTCG, PokéWallet, RapidAPI, pokemontcg.io
  → median price + needs-review flag → Scanner panel price grid per card
```

## Requirements

- Windows (sidecar launch scripts expect `tools/vellum-ai/.venv*/Scripts/python.exe`)
- Node.js **≥ 20** (uses native `--env-file`)
- Python **3.12** for VellumAI (optional unless you use `local-only` / `dual` identity)
- At least two pricing sources configured for prices to auto-accept (see [Pricing](#pricing--needs-review))

## Quick start

```powershell
cd pokemon-auto-lister
npm install
copy .env.example .env
# Edit .env — see Configuration
npm start
```

Dashboard: `http://127.0.0.1:3000` on this PC, or `http://<PC-LAN-IP>:3000` from a phone on the same Wi‑Fi.

To identify locally, set up and start VellumAI (first time: see [tools/vellum-ai/README.md](tools/vellum-ai/README.md) for venv + catalog embeddings), then set `VELLUM_AI_ENABLED=true`:

```powershell
npm run vellum-ai    # identify sidecar on http://127.0.0.1:8787
```

## Configuration

Copy [`.env.example`](.env.example) to `.env`. Variables read by the server:

### Identity

| Variable | Purpose |
|----------|---------|
| `PGAI_KEY` | [PokeGrade](https://pokegrade.ai/developers) identification + market value |
| `VELLUM_AI_ENABLED` | Use the local VellumAI sidecar (default `false`) |
| `VELLUM_AI_URL` | Sidecar URL (default `http://127.0.0.1:8787`) |
| `VELLUM_AI_REQUIRE_OCR` | Sidecar-side: require OCR agreement before accepting a match (default `true`) |
| `IDENTITY_MODE` | `dual` (default) · `local-only` · `pokegrade-only` |
| `SCANNER_IDENTITY_MODE` | Override for `POST /api/scan` only. Defaults to `local-only` when VellumAI is enabled, else `IDENTITY_MODE` |
| `POKEGRADE_CIRCUIT_TTL_HOURS` | Auto-clear the PokeGrade quota circuit (default 24) |

### Pricing sources

| Variable | Source |
|----------|--------|
| `JUSTTCG_API_KEY` | [JustTCG](https://justtcg.com/docs/quickstart) — NM comps + per-condition price grid (`/api/price-grid`) |
| `POKEWALLET_API_KEY` | [PokéWallet](https://www.pokewallet.io/api-docs) — TCGPlayer USD comps |
| `TCGPLAYER_PUBLIC_KEY` / `TCGPLAYER_PRIVATE_KEY` | TCGPlayer official pricing API |
| `RAPIDAPI_KEY` | [RapidAPI Pokémon TCG](https://rapidapi.com/tcggopro/api/pokemon-tcg-api) (tcggo) comps |
| `RAPIDAPI_EUR_USD` | EUR→USD rate for RapidAPI prices (default `1.09`) |
| `POKEMON_TCG_API_KEY` | [pokemontcg.io](https://docs.pokemontcg.io) — optional; raises the free-tier rate limit |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | eBay Marketplace Insights — median of last 5 sold items |
| `COLLECTR_TOKEN` / `COLLECTR_USER_ID` / `COLLECTR_COLLECTION_ID` | Collectr private api-v2 portfolio comps |
| `COLLECTR_API_BASE_URL` / `COLLECTR_SYNC_INTERVAL_MS` | Collectr api-v2 base URL and re-sync interval (default 6h) |
| `COLLECTR_CSV` / `COLLECTR_WATCH_PATH` | Collectr CSV fallback when no token is set |

### Server

| Variable | Purpose |
|----------|---------|
| `HOST` / `PORT` | Bind address (default `0.0.0.0:3000`) |
| `DATA_DIR` | Runtime state + card catalog (default `data`) |

### Collectr

Full guide: [`src/collectr/README.md`](src/collectr/README.md).

Collectr has **no public Partner API** (`getcollectr.com/api` is 404). The client uses the private web backend `api-v2.getcollectr.com` with the JWT from browser `localStorage.collectrToken` while logged into [app.getcollectr.com](https://app.getcollectr.com). Aggressive probing can trip WAF 401s — back off and re-login. Without a token, comps come from the portfolio CSV at `COLLECTR_CSV`.

## Pricing / Needs review

Suggested price = median of all available comps.

A card is marked **needs review** when any of these hold:

- fewer than **2** comp sources returned a price
- PokeGrade confidence is low
- any two comps differ by more than **15%**
- identity sources disagree (PokeGrade vs VellumAI), or VellumAI abstains in solo mode

When the PokeGrade free-tier quota is exhausted, the app opens a **quota circuit**, skips further PokeGrade calls, and identifies with **VellumAI solo**. Reset it from the dashboard banner (`POST /api/pokegrade-circuit/reset`) or wait `POKEGRADE_CIRCUIT_TTL_HOURS`.

## API

| Route | Purpose |
|-------|---------|
| `POST /api/scan` | Multipart `photos` field → identity + comps + price decision (Scanner panel) |
| `POST /detect` | JSON `{ image_b64 }` → per-card detection, identity and price; retries + preprocessing fallbacks on abstain |
| `GET /api/price-grid?name=&set=&number=` | JustTCG per-condition grid (used by the extension) |
| `GET /api/identity-status` | Identity modes, VellumAI enabled/URL, circuit state |
| `POST /api/pokegrade-circuit/reset` | Close the PokeGrade quota circuit |
| `GET /api/collectr-status` | Collectr mode + sync stats |
| `GET /api/scan-photo` | Serve a saved scan crop |
| `GET /health`, `GET /api/health` | Liveness |

## Development

```powershell
npm test                          # node --test (all tests/*.test.js)
node --test tests/pricing.test.js # single file
npm run lint                      # eslint
npm run test:vellum               # VellumAI Python tests (tools/vellum-ai/.venv)
npx playwright test               # E2E, headless
npx playwright test --project=extension   # extension E2E (headed, real Chrome)
npx playwright test --project=demo        # demo overlay (headed)
```

## Layout

```text
src/
  index.js           # bootstrap: reads env, builds clients, injects into server
  server.js          # LAN HTTP: routes above + static dashboard
  server/            # multipart parser
  scan/              # scanAndPrice — identity → comps → price decision
  identify/          # identity resolver (dual / local-only / pokegrade-only) + VellumAI client
  photos/            # multi-card split, shot kind, photo roles
  pricing/           # needs-review rules + JustTCG / PokéWallet / RapidAPI / pokemontcg.io clients
  pokegrade/         # PokeGrade API client + quota circuit
  collectr/          # Collectr api-v2 + CSV fallback
  ebay/              # eBay OAuth + sold comps
  tcgplayer/         # TCGPlayer client
public/              # static dashboard + Scanner panel
data/                # runtime state + card catalog (gitignored)
tests/               # node --test suites; tests/e2e/ = Playwright
scripts/             # benchmarks, sidecar launchers, debug reports
tools/vellum-ai/     # local detect + ID sidecar (Python 3.12)
tools/chrome-extension/  # dev Chrome extension
docs/autopilot/      # architecture notes, CURSOR.md
HANDOFF.md           # next-session brief
```

## License

Private / personal use.
