# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal Windows toolkit that identifies and prices Pokémon TCG cards from photos.
Plain-JS ESM Node server (dashboard + JSON API) plus a Python detect/identify sidecar
(VellumAI) and Chrome extensions. Integrates PokeGrade, VellumAI, TCGPlayer, JustTCG,
PokéWallet, RapidAPI, eBay, and Collectr.

Session continuity lives in `HANDOFF.md`, `tasks/todo.md` (plus an untracked root
`todo.md`), and `tasks/lessons.md` — read them before proposing work. Cursor
conventions: `docs/autopilot/CURSOR.md`.

---

## 1. Commands

Shell is PowerShell: no `&&`, no bash heredocs; use `;` between commands.

```powershell
npm start                                  # node --env-file=.env src/index.js → http://127.0.0.1:3000
npm test                                   # node --test (all tests/*.test.js)
node --test tests/pricing.test.js          # single file; pass multiple files as separate args
node --test --test-name-pattern="<regex>" tests/pricing.test.js  # single test by name
npm run lint                               # eslint .

npm run vellum-ai                          # start VellumAI identify sidecar (prefers .venv312, then .venv)
npm run test:vellum                        # Python unittest suite in tools/vellum-ai/tests (uses .venv)

npx playwright test                        # E2E, headless Chromium (excludes extension-chrome.spec.js)
npx playwright test --project=extension    # Chrome extension tests (headed, needs real Chrome)
npx playwright test --project=demo         # demo overlay (headed)
```

---

## 2. Architecture

### Processes
| Process | Entry | Port |
|---|---|---|
| Node dashboard / API | `src/index.js` → `src/server.js` | 3000 |
| VellumAI identify sidecar (CLIP + FAISS + detector) | `tools/vellum-ai/identify_server.py` | 8787 |
| Extension detect sidecar | `tools/vellum-ai/server.py` | 7331 |

Two extensions: `tools/chrome-extension/` (tracked, dev) and `dist/extension-wasm/`
(standalone end-user build; `dist/` is gitignored).

### Wiring
- `src/index.js` reads env, constructs every client (`create*Client`), and passes them
  into `createServer({...})`. Nothing else reads `process.env` for wiring.
- Two identity resolvers are built from `src/identify/resolver.js`: one for
  `IDENTITY_MODE` (listing/inbox) and a separate `scannerIdentityResolver` for
  `SCANNER_IDENTITY_MODE` (`POST /api/scan` only). Modes: `dual | local-only | pokegrade-only`.
- Request flow: `POST /detect` / `POST /api/scan` (multipart via `src/server/multipart.js`)
  → multi-card split (`src/photos/splitMultiCard.js`, VellumAI contours → rectified crops)
  → `src/scan/scanAndPrice.js` (identity → comps from pricing clients)
  → `src/pricing/pricing.js` rules → JSON price grid per card.
- `GET /api/price-grid` (JustTCG) is consumed by the extension when the server is up.

### Pricing rules (do not "simplify" away)
- Suggested price = median of available comps; `MIN_COMP_SOURCES = 2`.
- `needs_review` when any two comps differ by > `NEEDS_REVIEW_THRESHOLD` (15%), PokeGrade
  confidence is low, identity sources disagree, or VellumAI solo abstains.
- `PRICE_DRIFT_THRESHOLD` (5%) is a different rule: posted list price vs refreshed market.

---

## 3. Code Style and Patterns

### Module system
- All source is plain `.js` ESM — no TypeScript, no bundler. JSDoc is welcome.
- Node built-ins imported with `node:` prefix (`import http from 'node:http'`).

### Server
- Single `http.createServer` — no Express. Routes are an `if (method && pathname)` chain
  in `createServer`, dispatching to `async function handle*(req, res, deps)`.
- Responses always via `sendJson(res, status, data)`.
- Guard every injected dep:
  ```js
  if (typeof scanAndPrice !== 'function') return sendJson(res, 503, { error: '...' });
  ```
- Errors caught at route level; `RetryablePokegradeError` is checked with `instanceof`
  before the generic 500.

### Image processing
- Use `sharp` for image transforms; wrap calls in try/catch and fall back gracefully
  (see `imageMeanBrightness` in `src/server.js`). Prefer `.toBuffer()` over temp files.

### CORS
- Restricted to `chrome-extension://`, `http://127.0.0.1:3000`, `http://localhost:3000`,
  and `"null"`. Do not widen this allowlist.

### Tests (Node built-in runner)
- `import { test } from 'node:test'` and `assert from 'node:assert/strict'`.
- Integration tests spin up a real server with `server.listen(0)`; tear down in `finally`.
- No mocking framework — pass lightweight stub objects via DI.
- Git history follows RED/GREEN TDD commits (`test: add failing ...` then `feat: ... (GREEN)`).

---

## 4. Gotchas

### Identity
- `VELLUM_AI_ENABLED=false` by default — the sidecar must be running at `VELLUM_AI_URL`
  before enabling it.
- PokeGrade has a quota circuit breaker (`src/pokegrade/circuit.js`). When open, identity
  falls back to VellumAI solo. Reset via `POST /api/pokegrade-circuit/reset` or wait
  `POKEGRADE_CIRCUIT_TTL_HOURS`.
- PokeGrade 422 "could not identify a card" is a skip, not a retry.

### Scan retry logic (`src/server.js`)
- VellumAI abstain results are retried up to 2× with increasing JPEG quality before the
  preprocessing fallback chain: sharpen → CLAHE+sharpen → rotate 180° → tile split (3 tiles).
- A single detection with no `conf` (`isUnclassifiedDetection`) skips the single-card fast
  path and falls through to tile splitting.
- Zero-confidence phantom detections are filtered (`c.conf >= 0.05` or absent). Do not
  remove — it prevents recursive re-detection explosion.

### Paths
- `serveScanPhoto` rejects `dir` containing `/` or `\`; `serveStatic` checks
  `resolved.startsWith(resolvedPublicDir)`. Always `path.resolve` before comparing.

### Environment
- `.env` is loaded via `--env-file=.env` (Node 20+). Do not add dotenv.
- Pricing needs at least one of `POKEWALLET_API_KEY` / `JUSTTCG_API_KEY` / `TCGPLAYER_PUBLIC_KEY`.
- Document new keys in `.env.example`. Do not rotate `PGAI_KEY` unless asked.
- Collectr has no public API: uses private `api-v2.getcollectr.com` with a JWT from browser
  `localStorage.collectrToken`; aggressive probing trips WAF 401s. CSV is the fallback.

### Data / models
- `data/` (catalog embeddings, card images, runtime state) and model weights are gitignored;
  regenerate per `tools/vellum-ai/README.md`. Keep `data/card-catalog/` private.
- Detector classes: `full_card` / `corner_closeup` / `card_back` — a corner close-up must
  never be used as a listing front.

### Native deps
- `sharp` ships a native binding; reinstall (`npm ci`) if `node_modules` crosses OS/arch.
