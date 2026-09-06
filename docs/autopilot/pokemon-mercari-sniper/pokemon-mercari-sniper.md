# Pokémon Mercari Sniper (Scalper)

## Introduction / Overview

Internal **buy-side** sibling module to the auto-lister. Scans Mercari search strategies on a timer, prices each new listing’s first photo via **PokeGrade `/value`**, and **auto-hearts** deals that clear the threshold. Lives in the same Node process and Mercari Chrome profile as the sell-side lister; keeps its own state under `data/sniper/`.

**Problem:** Underpriced slabs disappear in minutes; a human cannot watch Mercari around the clock.  
**Goal:** Heart clear deals automatically; surface near-misses and suspect outliers for human review. Never buy or message sellers.

## Goals

1. Scan configured Mercari searches every ~10 minutes (configurable).
2. Price new listings via first CDN photo → PokeGrade; cache forever by Mercari item id.
3. Strategies: `raw-crack` (compare raw value) and `graded-under` (compare matching PSA grade comp).
4. Heart when market/ask ≥ 1.25×; offer-worklist for 1.15–1.25×; flag ≥5× as suspect (do not heart).
5. Share one Mercari Chrome session with the sell lister via a page mutex.
6. Expose minimal Scalper status on the existing LAN dashboard (read-only).

## Non-Goals

1. Auto-buy, offers, or messaging sellers.
2. eBay / Vinted watchers, trading-desk ledger, fee-aware P&amp;L (later phases).
3. Separate Chrome profile or second Windows Task Scheduler job for v1.
4. Changing sell-side pricing (±15%) or queue state machine.
5. Database server; React SPA.

## Technical Considerations

- **Module:** `src/sniper/`; enable with `SNIPER_ENABLED=true`.
- **Config:** `config/sniper-strategies.json` (strategies + thresholds).
- **State:** `data/sniper/` — `seen` vs `hearted` must stay separate (crash between grade and heart must not double-click / un-heart).
- **Mercari:** same Chrome launch rules as sell-side; search selectors `ProductThumbWrapper`, price first money token, heart `ItemLike`.
- **Photo URL:** `https://u-mercari-images.mercdn.net/photos/{ITEMID}_1.jpg`.
- **Transient failures:** leave item un-seen for retry next cycle.

## Success criteria

- With sniper enabled and Mercari logged in, a qualifying listing is hearted once and recorded under `data/sniper/`.
- Sell drafts and sniper scans never open a second Chrome profile; they serialize on one mutex.
- `npm test` covers deal math, state idempotency, search parse, and PokeGrade extensions with fakes (no live Mercari in CI).
