# Inbox CTA + listings price monitor (2026-08-11)

## Plan
- [x] Stop background inbox watcher; button-driven `POST /api/inbox/scan`
- [x] `GET /api/inbox/status` + `countPendingInbox`
- [x] Replace Add-a-card UI with folder + **Add new cards**
- [x] Current listings table (posted vs market, delta, health)
- [x] ±5% price drift monitor + Repost (clear mercari `created`)
- [x] Tests + README
- [x] **Rescan all cards** — `forceRescan` regroups all inbox photos and reprocesses existing non-listed queue items

## Review
- Manual ingest via **Add new cards**; no 5s auto-enqueue
- **Rescan all cards** ignores flat-seen / folder markers, updates matching queue cards, re-runs identity/pricing; listed cards skipped
- `POST /api/listings/rescan-prices` flags drift → Needs Review **Repost**
- Repost creates a new Mercari listing (old one not auto-ended)
- **Download photos** copies recent JPGs from `ICLOUD_PHOTOS_DIR` → `INBOX_DIR` (Shared Albums workaround)

# PokéWallet comps backup (2026-08-11)

## Plan
- [x] `src/pricing/pokeWallet.js` — `/search` + Holofoil TCGPlayer USD
- [x] Wire into decidePrice / pipeline / monitor / index / Needs Review UI
- [x] `POKEWALLET_API_KEY` in `.env` + `.env.example` + README
- [x] Tests + live smoke (Charizard ex 223 → $109.47)

## Review
- Backup/comparison source alongside JustTCG / RapidAPI / PokeGrade
- Free tier: 100/hour, 1000/day — search-only (no Pro history)

# Fix corner-as-front photo selection (2026-08-11)

## Plan
- [x] Restore mtime on download; sort flat inbox by IMG_####
- [x] Identify fronts/backs by content; next full-card = back; match closeups by similarity
- [x] Set front reprocesses identity; UI shows extras
- [x] Tests + README
- [x] Inbox front picker (Browse inbox photos)
- [x] Retrain Vellum detector multi-class (full_card / corner_closeup / card_back)

## Review
- Detector classes teach corner≠front; `usable_as_front` requires full_card @ conf≥0.35
- Bootstrap from inbox + 45% synth corners; corner→full rate 0% on val
- Hand-label hard failures in `data/vellum-detect/` for the next retrain

# Debug loop (2026-08-12)

## Running
- [x] `/loop 5m` armed — `scripts/loop-debug-report.mjs` + Global Mind `active/auto-card-lister-debug-loop.md`
- [ ] Clear 9 error cards (8 no pricedCache — PokeGrade identity failures)
- [ ] Enable Vellum sidecar if dual identify needed (`VELLUM_AI_ENABLED=true`)
- [ ] Refresh Collectr JWT when comps needed

## Tick 0 (2026-08-12)
- Tests 213/213 pass; dashboard OK
- errors=9, needsReview=8; vellumEnabled=false in dual mode
- Collectr 401 stale (expected)

## Tick 2 (2026-08-12 21:41 ET)
- Stable — identical metrics to tick 0/1
