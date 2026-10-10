# Pokémon Card Scanner

Personal **Windows** toolkit that scans physical card photos (or multi-card spreads), identifies each card, and returns current market prices.

```text
Photo (single or multi-card spread)
  → multi-card detection: VellumAI contours → rectify_card crops
  → identity: PokeGrade /value ⊕ VellumAI (dual), or VellumAI solo if PG quota circuit is open
  → cross-check Collectr (+ JustTCG / TCGPlayer / eBay solds / PokéWallet / RapidAPI)
  → Scanner panel: card name + set + price grid per card
```

**VellumAI** is the local detect+identify sidecar; see [tools/vellum-ai/README.md](tools/vellum-ai/README.md).

## Status

| Item | State |
|------|-------|
| Tests | `npm test` (Node) · `npm run test:vellum` (Python) |
| Live credentials | Not configured until you fill `.env` |

## Requirements

- Node.js **≥ 20**
- Windows
- API keys: [PokeGrade](https://pokegrade.ai/developers), [JustTCG](https://justtcg.com/docs/quickstart)
- VellumAI sidecar (optional, for local-only mode): Python 3.12 + `tools/vellum-ai/`

## Quick start

```powershell
cd pokemon-auto-lister
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
| `PGAI_KEY` | PokeGrade `/value` identification + market value |
| `VELLUM_AI_ENABLED` / `VELLUM_AI_URL` | Local VellumAI sidecar for dual/solo ID (default off) |
| `SCANNER_IDENTITY_MODE` | `dual` (default) · `local-only` · `pokegrade-only` |
| `POKEGRADE_CIRCUIT_TTL_HOURS` | Auto-clear PG quota circuit (default 24) |
| `JUSTTCG_API_KEY` | [JustTCG](https://justtcg.com/docs/quickstart) live USD Near Mint market comps |
| `POKEWALLET_API_KEY` | [PokéWallet](https://www.pokewallet.io/api-docs) TCGPlayer USD market comps (backup) |
| `RAPIDAPI_KEY` | RapidAPI Pokémon TCG market comps (tcggo) |
| `RAPIDAPI_EUR_USD` | EUR→USD rate for RapidAPI prices (default `1.09`) |
| `COLLECTR_TOKEN` / `COLLECTR_USER_ID` / `COLLECTR_COLLECTION_ID` | Collectr private api-v2 portfolio comps (from app `localStorage.collectrToken`) |
| `COLLECTR_CSV` / `COLLECTR_WATCH_PATH` | CSV fallback when token unset |
| `HOST` / `PORT` | Dashboard bind (default `0.0.0.0:3000`) |
| `DATA_DIR` | Runtime JSON state (default `data`) |

### Collectr pricing

Full guide: [`src/collectr/README.md`](src/collectr/README.md).

Collectr has **no public Partner API** (`getcollectr.com/api` is 404). Preferred path: private web backend `api-v2.getcollectr.com` with a JWT from browser `localStorage.collectrToken` while logged into [app.getcollectr.com](https://app.getcollectr.com). Set `COLLECTR_TOKEN` + `COLLECTR_USER_ID` (optional `COLLECTR_COLLECTION_ID`).

Without a token, comps fall back to portfolio CSV at `COLLECTR_CSV`.

### Pricing / Needs review

Suggested price = median of available comps.

**Needs review** when PokeGrade confidence is low, **identity sources disagree** (PokeGrade vs VellumAI), VellumAI solo abstains, **or** any two of {PokeGrade, Collectr, JustTCG, eBay last-5 median} differ by **>15%**.

When PokeGrade free-tier quota is exhausted, the app opens a **quota circuit**, skips further PG calls, and identifies with **VellumAI solo**. Reset from the dashboard banner or wait for `POKEGRADE_CIRCUIT_TTL_HOURS`.

## Scanner

- `POST /api/scan` — submit a photo; returns detected cards with identity + price grid
- Multi-card spreads: VellumAI contour detection → rectified crops per card
- VellumAI runs at `http://127.0.0.1:8787` (start: `tools/vellum-ai/`)
- Catalog embeddings: `data/card-catalog/embeddings.faiss` (~42 MB) — see [tools/vellum-ai/README.md](tools/vellum-ai/README.md)

## Development

```powershell
npm test                          # node --test (all tests/*.test.js)
node --test tests/pricing.test.js # single file
npm run lint                      # eslint
npm run vellum-ai                 # start VellumAI sidecar (tools/vellum-ai/.venv312 or .venv)
npm run test:vellum               # VellumAI Python tests
npx playwright test               # E2E (headless); --project=extension / demo run headed
```

## Layout

```text
src/
  index.js           # bootstrap: reads env, builds clients, injects into server
  server.js          # LAN HTTP: /detect, /api/scan, /api/price-grid, static dashboard
  server/            # multipart parser
  scan/              # scanAndPrice — identity → comps → price grid orchestration
  identify/          # identity resolver (dual / local-only / pokegrade-only) + VellumAI client
  photos/            # multi-card split, shot kind, photo roles
  pricing/           # 15% needs-review rule, comps median, JustTCG / PokéWallet / RapidAPI clients
  pokegrade/         # PokeGrade API client + quota circuit
  collectr/          # Collectr api-v2 + CSV fallback
  ebay/              # eBay OAuth + sold comps
  tcgplayer/         # TCGPlayer client
public/              # static dashboard + Scanner panel
data/                # runtime state + card catalog (gitignored)
tests/               # node --test suites; tests/e2e/ = Playwright
scripts/             # benchmarks, sidecar launchers, debug reports
tools/vellum-ai/     # local detect+ID sidecar (Python 3.12)
tools/chrome-extension/  # dev Chrome extension
docs/autopilot/      # architecture notes, CURSOR.md
HANDOFF.md           # next-session brief
```

## License

Private / personal use.
