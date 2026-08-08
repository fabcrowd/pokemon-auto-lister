# Pokémon Card Auto-Lister

## Introduction / Overview

Personal Windows toolkit that turns phone photos into **Mercari and/or eBay drafts** (never published). You upload photos on a local LAN dashboard, mark which thumbnail is the front, and the system identifies/prices the card via **PokeGrade `/value`**, cross-checks **TCGPlayer market/mid** and **eBay last-~5 solds**, then drives listing creation only when sources agree. Disagreements go to **Needs review**. A human always hits List/Publish on the marketplace.

**Problem:** Large piles of cards; listing one-by-one is too slow.  
**Goal:** Batch-friendly drafts with phone upload, multi-source pricing, and human-in-the-loop before money.

## Goals

1. Upload multiple card photos from a phone on the same Wi‑Fi; select the front image per card.
2. Identify and price each card with PokeGrade `/value` as the primary valuation signal.
3. Cross-check against TCGPlayer market/mid (official API) and eBay recent solds; show all three on the dashboard.
4. Auto-create marketplace drafts when confidence is high; otherwise queue **Needs review**.
5. Support Mercari (Playwright + real Chrome profile) and eBay (Sell/Inventory APIs) with per-card marketplace checkboxes (default: both).
6. Never auto-publish; never buy; never send offers.
7. Survive reboots via Windows Task Scheduler (or equivalent service wrapper).
8. Persist all state as JSON/CSV under the project folder (no database).

## User Stories

1. As a seller, I open the dashboard on my phone, tap **Add a card**, choose photos, tap the front thumbnail, pick Mercari/eBay (or both), and hit **Add** so drafts appear without using a PC UI for file management.
2. As a seller, I watch an **Auto-list** tab: queue depth, drafts created + total list value, needs-review, errors, all-time processed, and a live per-card log.
3. As a seller, when comps disagree, I open Needs review, see suggested price + PokeGrade / TCGPlayer / eBay solds, adjust if needed, and confirm so drafts are created.
4. As a seller, I open Mercari/eBay, glance at each draft (title, photos, price, shipping), and publish manually.
5. As an operator, I keep API keys and listing defaults in config/env; the Windows service restarts after reboot and drains the queue.

## Requirements

### Functional

1. **Add-card flow:** multi-photo upload; user marks one front; remaining images are listing extras; marketplace checkboxes (Mercari, eBay; default both).
2. **Queue:** durable on-disk queue; process back-to-back batches (e.g. 10 cards dropped at once).
3. **Identification:** POST front image to PokeGrade `/value`; cache result by content hash/item id; 1 credit per successful call.
4. **Pricing inputs (always collected when possible):**
   - PokeGrade returned market value
   - TCGPlayer official market/mid for the matched product/condition
   - eBay last ~5 sold prices (median used for compare)
5. **Suggested price:** blend/display comps; apply **per-marketplace multipliers** from config (`mercariMultiplier`, `ebayMultiplier`).
6. **Auto vs Needs review:**
   - **Needs review** if PokeGrade confidence is low **OR** any two of {PokeGrade value, TCGPlayer market, eBay last-5 median} differ by **>15%**.
   - Otherwise auto-create drafts at suggested price × marketplace multiplier.
7. **Mercari drafts:** Playwright drives sell form with **real installed Chrome** (`channel: 'chrome'`), headful, persistent profile, anti-automation flags from verified Mercari practice; wait for human login if logged out (poll URL, up to 30 min); save **draft only**.
8. **eBay drafts:** official Sell/Inventory (or equivalent draft) APIs; OAuth credentials from env; draft/unpublished listing only.
9. **Listing defaults (config, shipped defaults):**
   - Condition: Like new / Near Mint (map closest eBay condition)
   - Seller-paid shipping: USPS First-Class Envelope ~3 oz (buyer free)
   - Mercari Smart Pricing: off
   - All overridable in config without code changes
10. **Dashboard Auto-list tab:** drafts created + total list value; in queue; needs review; errors; all-time processed; live log.
11. **Safety:** never publish; never purchase; never send offers; extreme/outlier ratios can be forced to Needs review.
12. **Idempotency:** crash between price and draft must not double-create; track per-card per-marketplace draft status separately from “seen/priced.”

### UI

1. Vanilla static HTML/CSS/JS served by the Node process (no React/Vue).
2. Mobile-usable Add panel (thumbnails, front selection, marketplace checkboxes).
3. Auto-list status + Needs review confirm/edit price UI.
4. Bind to LAN interface so phones on the same Wi‑Fi can reach `http://<PC-LAN-IP>:<PORT>`.
5. **Draft Activity** panel matches the reference look (`docs/autopilot/pokemon-auto-lister/draft-activity-ui-reference.png`): light card, monospaced/`//` header (`// AUTO-LISTER — DRAFT ACTIVITY`), status line (`DRAFT MODE` · service running · never publishes), table columns for card title, **VALUE**, **LIST** (green, rounded), **PHOTOS**. Default list markup is **0% over market** (multipliers default to `1.0`).
6. Optional parallel intake: watch `autolist-inbox/` for dropped photo batches in addition to phone upload (same queue).

### Integration

1. PokeGrade `/value` (API key in env).
2. TCGPlayer official pricing API (app credentials in env).
3. eBay developer keyset + OAuth for Sell APIs; Browse/Finding (or Sell analytics) for recent solds.
4. Mercari via Playwright + persistent Chrome profile (no automated login).

### Testing

1. Unit tests for pricing compare (>15% rule), multipliers, money parsing, queue state transitions, idempotency.
2. Integration tests with mocked PokeGrade / TCGPlayer / eBay HTTP.
3. Mercari/eBay browser or API paths tested behind interfaces with fakes in CI (no live marketplace in CI).
4. Autopilot TDD: red → green → refactor per requirement.

### Non-Goals (Out of Scope)

1. Auto-publish / auto-buy / offers / messaging sellers.
2. Deal sniper / Mercari auto-heart watcher (separate product; not this PRD).
3. Public internet exposure, tunnels, Tailscale.
4. Database servers; multi-user / multi-tenant.
5. macOS launchd (Windows-only service for v1).
6. Scraping TCGPlayer sold history; paid third-party sold feeds.
7. React/SPA frameworks; cloud deploy.

## Technical Considerations

### Stack

- **Runtime:** Node.js
- **Browser automation:** Playwright → real Chrome for Mercari only
- **HTTP:** Node built-ins or minimal static file + multipart upload (no heavy framework)
- **State:** JSON/CSV under project `data/` (queue, drafts ledger, price cache, heart/draft ids)
- **Service:** Windows Task Scheduler (Run at startup + restart on failure) or NSSM; absolute `node` path; project **not** under Desktop-equivalent restricted paths if TCC-like issues appear
- **Secrets:** `.env` (gitignored): `PGAI_KEY`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, TCGPlayer keys, eBay refresh token

### Mercari automation (verified constraints to honor)

- Do **not** use bundled Chromium (PerimeterX); use `channel: 'chrome'`, headful, persistent profile, `--disable-blink-features=AutomationControlled`, `ignoreDefaultArgs: ['--enable-automation']`.
- Detect logged-out via URL poll after `/mypage/` → `/login/` (client-side redirect ~15s), not DOM alone.
- First photo URL pattern for read paths if needed: `https://u-mercari-images.mercdn.net/photos/{ITEMID}_1.jpg` (listing creation uses uploaded files instead).
- Prefer project under home/user folder for long-running jobs.

### Pricing algorithm (v1)

1. Obtain `pgValue` from PokeGrade.
2. Resolve TCGPlayer product from PokeGrade identity fields → `tcgMarket`.
3. Query eBay solds for the card query → `ebayMedian` of last up to 5.
4. If any required source missing → Needs review (show what we have).
5. If max pairwise relative spread among present sources > 15% **or** low PokeGrade confidence → Needs review.
6. Else `suggested =` primary blend (document in code: default **median of available sources**, then × marketplace multiplier, round per platform rules).

### Suggested repo layout

```text
/
  package.json
  .env.example
  config/listing-defaults.json
  src/
    server.js              # dashboard + API
    queue/
    pricing/
    pokegrade/
    tcgplayer/
    ebay/
    mercari/               # Playwright draft driver
    service/windows/       # Task Scheduler XML or install script
  public/                  # dashboard static assets
  data/                    # gitignored runtime state
  tests/
  docs/autopilot/pokemon-auto-lister/
```

### Delivery phases (independently useful)

| Phase | Deliverable |
|-------|-------------|
| 1 | Dashboard + upload + front select + on-disk queue + PokeGrade identify/price (no marketplace yet) |
| 2 | Comp engines (TCGPlayer market + eBay solds) + 15% rule + Needs review UI |
| 3 | Mercari draft-only Playwright path + Windows service |
| 4 | eBay draft-only Sell API path + per-card marketplace checkboxes |
| 5 | Hardening: idempotency, batch drain, logging, install docs |

### Success criteria

- From phone on LAN: add a card with 2+ photos → appears in queue → either drafts on selected marketplaces or Needs review with comps visible.
- Zero publishes without human action on the marketplace site/app.
- Service recovers after Windows reboot and continues the queue.
- Autopilot task JSON covers each requirement with TDD phases.

## Resolved decisions

| Topic | Decision |
|-------|----------|
| Product | Sell-side auto-lister (not sniper) |
| OS | Windows only |
| Marketplaces | Mercari + eBay |
| Per-card sites | Checkboxes; default both |
| Price knobs | Per-marketplace multipliers + suggested price UI |
| Auto gate | High confidence auto; else Needs review |
| Comp sources | PokeGrade + TCGPlayer market/mid + eBay last~5 solds (compare) |
| Phone access | LAN only |
| Stack | Node + Playwright + static UI; Mercari browser; eBay APIs; JSON/CSV |
| Listing fields | Config with Like-new / seller-paid / Smart Pricing off defaults |
| Disagree rule | >15% pairwise among sources OR low PokeGrade confidence |
