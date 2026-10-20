# Pokémon Card Scanner

Personal **Windows** toolkit that scans Pokémon TCG card photos, identifies each card, and returns current market prices.

Three pieces live in this repo:

1. **Node dashboard + API** (project root) — upload a photo (single card or a multi-card spread) and get identity + price grid per card. Bind is LAN-wide, so it works from a phone on the same Wi‑Fi.
2. **VellumAI** ([`tools/vellum-ai/`](tools/vellum-ai/README.md)) — local Python detect + identify sidecar (YOLO detector, CLIP/FAISS catalog retrieval, OCR).
3. **Chrome extension** — [`tools/extension-wasm/`](tools/extension-wasm/) is the product: it finds Pokémon cards in the photos on a page and overlays name, set and price. Recognition runs in the browser (CLIP + YOLO via onnxruntime-web). It is built into `dist/` (gitignored; install steps in `tools/extension-wasm/INSTALL.md`). When the dashboard is running the dev build uses `GET /api/price-grid` for per-condition JustTCG pricing. [`tools/chrome-extension/`](tools/chrome-extension/) is the older dev extension that talks to the VellumAI extension sidecar (`tools/vellum-ai/server.py`, port 7331).

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
| `JUSTTCG_API_KEY` | [JustTCG](https://justtcg.com/docs/quickstart) — NM comps and the backend `/api/price-grid` response (see API section; separate from the extension TODO's proposed NM/LP/MP/HP/DMG grid) |
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

## Browser extension

Source is `tools/extension-wasm/`; `dist/` holds generated builds, so rebuild after changing source and never edit `dist/` by hand.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup_vendor.ps1      # once: fetch onnxruntime-web into tools/extension-wasm/vendor
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-wasm-extension.ps1          # dev build -> dist/extension-wasm
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-wasm-extension.ps1 -Sealed  # dist/extension-wasm-sealed (scorer only)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-wasm-extension.ps1 -Store   # dist/extension-wasm-store + .zip
```

The dev build keeps the localhost dashboard host permissions, test-photo collection and test hooks. The store build drops all of those, requests `<all_urls>` only as an optional permission, and its permission and host list is pinned by `tests/store-build.test.js`.

What it does on a page:

- **Listing-photo focus.** It scans the listing's own photo, not recommendation carousels or thumbnail strips: related-item sections are found from their headings, and a single hero card that fills its photo is read directly. Square photos with no detections are tiled for lots, and sealed product gives no cards.
- **Full-size photo upgrade.** It looks for the largest rendition of the photo (srcset, zoom/original attributes, image links, `og:image`, known size markers) and detects on that. Without site access it falls back to a screenshot crop. After a screenshot-only scan the popup offers site access once ("Not now" hides it for 14 days); the options page has the same toggle, "Read full-size photos on sites you scan (more accurate)". Photos are fetched without cookies and only from hosts the page already loaded images from.
- **Whole-page scan.** A long page is walked up to 12 screens or 200 cards, duplicates are dropped, and the scroll position is restored. The popup has to stay open for the scan.
- **Era.** Choosing an era limits the name, the set choices, and the suggestions to that era's cards.
- **Best guess.** A card whose printing is still open is priced as one printing: the set named in the page heading, breadcrumb, or title, else the set most settled cards on the page share, else the printing the picture matched best. That guess stays below "high". A "?" next to the name confirms it, and the "Set?" menu stays. Confirming or picking saves a correction. The popup shows one price per card and one estimated lot value; condition chips live in Settings.
- **Picker and version choices.** When unsure it shows close matches and remembers the pick. When look-alike versions (ex / V / VSTAR / Dark) are close it shows an "Other version?" menu with each version's price. The listing title only reorders choices. "High" confidence needs similarity >= 0.82 and a clear lead; three or more boxes with the same name in one photo go to the picker.
- **Optional shared learning** ("Help improve recognition for everyone", off until the user turns it on). `lib/shared-config.js` points at the deployed relay and the signed community pack. Opted-in picks upload as small card crops plus the chosen card, and a signed pack comes back. See `docs/plans/shared-learning.md`, `docs/plans/self-learning.md` and `tools/shared-data/README.md`.
- **Experimental look-alike penalty** is off; it needs a locally built penalty file (`scripts/build-hub-penalty.py`).

Tests: `npm test` (Node unit tests, including the store-build and extension tests). The last recorded full run is in `HANDOFF.md` (1033 pass, 0 fail on 2026-10-17; not rerun for later doc-only commits). Popup: `npx playwright test tests/e2e/extension-wasm-popup.spec.js --project=extension` (needs real Chrome and a fresh dev build). Real-world harness: `scripts/realworld-run.mjs <pages.json>` (see `HANDOFF.md`).

The scanner's content script collects large page-image candidates, including CSS background images, and records each image URL and rendering geometry. The service worker attempts detection against the original HTTPS image when browser access permits; unsupported CSS mappings, inaccessible sources, or failed fetches fall back to a crop from the visible-tab screenshot. Detected source-image boxes are mapped back to viewport coordinates for the overlay. Screenshot scale is measured from the captured bitmap and page viewport rather than relying only on `devicePixelRatio`.

**Model quality:** the shipped detector was retrained on 2026-10-10 with binder, flat-lay and single-card composites plus reviewed sealed-product negatives. On the reviewed real-photo set it scores precision 0.91 / recall 1.00 at the shipped threshold (the previous model scored 0.17 / 0.14). That set is small (5 positive photos, 12 sealed lots), so see `HANDOFF.md` for caveats. A tilted-card retrain on 2026-10-18 (`card_detect_v7b`) was not shipped: on 67 HiBid lot photos it added confident wrong names. Score a model with:

```powershell
cd tools/vellum-ai
.venv\Scripts\python detect/eval_real.py --verbose                        # data/detect-real-eval
.venv\Scripts\python detect/eval_real.py --data ../../data/detect-real-eval-stress
.venv\Scripts\python detect/synth_binder.py --count 700 --split train      # binder / flat-lay / single-card synth
```

`detect/retrain.py` only promotes a model whose real-photo F1 is ≥ 0.90 and no worse than the current one. That offline gate is not enough on its own: also run the Chrome lot harness and require right names to rise without confident wrong names rising (`tasks/lessons.md`).

Marketplace examples may only enter retraining after review. Place a JSON sidecar beside each source image, for example `photo.jpg` and `photo.json`:

```json
{"reviewed": true, "boxes": [[42, 18, 162, 190]]}
```

Boxes use source-image pixel coordinates. Use `"boxes": []` for a reviewed image with no loose cards (including sealed-product negatives). Import reviewed examples from `tools/vellum-ai/` with `python detect/label_marketplace.py`; unreviewed detector proposals are ignored. Keep all photos from the same lot in one dataset split so near-duplicate listing photos cannot leak into validation.

Research supports sliced inference for small objects, and Ultralytics documents slicing plus merging; however, slicing must be evaluated with a detector trained on card-in-photo examples. The current model was also observed predicting a whole tile as the object, so enabling tiles alone is not a fix. See the [SAHI paper](https://arxiv.org/abs/2202.06934) and [Ultralytics SAHI guide](https://docs.ultralytics.com/guides/sahi-tiled-inference).

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
tools/extension-wasm/    # the Chrome extension (source; built into dist/)
tools/chrome-extension/  # older dev extension (sidecar)
tools/relay/, tools/shared-data/  # shared-learning templates the owner deploys
docs/plans/              # launch, shared-learning, self-learning plans
docs/autopilot/      # architecture notes, CURSOR.md
HANDOFF.md           # next-session brief
```

## License

Private / personal use.
