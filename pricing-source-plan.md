# Pricing-source plan — per-condition data

Research + recommendation for the todo.md Section 1 (per-condition raw prices) data layer.

**TL;DR**: Pick **PokemonPriceTracker.com** as the primary source and reuse the project's existing **JustTCG** server-side pipeline as an optional "pro mode" when the user is also running the Node backend. Scrydex is the paid upgrade path if we outgrow those.

---

## Candidate sources investigated

| Source | Per-condition | Graded | Free tier | Auth | Browser-safe | Notes |
|---|---|---|---|---|---|---|
| **pokemontcg.io** (current) | ❌ | ❌ | 1k/day no-key, 20k/day with key | optional | ✅ | Only `low/mid/high/market` per TCGPlayer variant. What we have today. |
| **TCGPlayer API** (official) | ✅ | ❌ (limited) | — | OAuth, closed to new signups | ⚠️ server only | Statement on their docs: "no longer granting new API access." Dead end. |
| **JustTCG** | ✅ NM/LP/MP/HP/DMG, printing-aware | ✅ (graded as `variants[].grading`) | — | `x-api-key` header; docs warn "never expose in client-side code" | ⚠️ needs backend proxy | **Project already pays for this and parses it server-side** in `src/pricing/justTcg.js`. |
| **PokemonPriceTracker.com** | ✅ `marketNearMint`..`marketDamaged` | ✅ PSA/BGS/CGC/SGC incl. population | 100 credits/day free | Bearer token | ⚠️ key visible if put in extension | Batch lookup. Fits our needs exactly. $9.99/mo for 20k/day. |
| **Scrydex** | ✅ NM/LP/MP/HP/DM + 1D/7D/14D/90D trends | ✅ PSA/BGS/CGC/TAG/ACE + half-grades | ❌ no free tier | API key | ⚠️ key visible | Same team as pokemontcg.io. $29/mo starter. Best data quality. |
| **TCG API (tcgapi.dev)** | ✅ (Pro tier +) | ✅ via PriceCharting bundle | 100/day free | `X-API-Key` | ⚠️ key visible | Per-condition is gated to Pro ($49.99/mo). Free tier is current-market only. |
| **Cardmarket API** | ✅ EU conditions (mt/nm/ex/gd/lp/pl/po) | ❌ | — | OAuth 1.0 | ⚠️ server only | Great for EUR users, overkill for US-focused app. Different condition taxonomy. |
| **PriceCharting** | partial (ungraded + grades, not NM/LP/MP) | ✅ strong | — | API key | ⚠️ key visible | Returns "ungraded / Grade 7-10" buckets, **not** the NM/LP/MP/HP/DMG grid we want. |
| **eBay Browse API sold comps** | — | — | — | — | — | Browse API **does not expose sold items** — official sold-comps endpoint doesn't exist. Dead end without a scraper. |

---

## Recommendation

### Primary: **PokemonPriceTracker.com** (extension-only mode)

- Fields map 1:1 to what Section 1 of todo.md needs:
  ```
  variants[printing].conditionUsed.{
    marketNearMint, marketLightlyPlayed,
    marketModeratelyPlayed, marketHeavilyPlayed,
    marketDamaged
  }
  ```
- Same response also returns PSA/BGS/CGC/SGC → **feeds Section 2 (graded) in the same call**. One source, both features.
- Batch endpoint `GET /api/v2/cards?tcgPlayerIds=A,B,C` → one request per scan instead of six.
- Free tier (100 credits/day, 60 req/min) covers personal-use scanning. Paid is $9.99/mo if the user wants headroom.
- Auth: `Authorization: Bearer <key>`. User enters their own key in extension options → stored in `chrome.storage.sync`.

**Lookup glue needed**: PokemonPriceTracker keys cards by `tcgPlayerId`. We identify by `base1-4` style IDs from pokemontcg.io. The pokemontcg.io response already includes `tcgplayer.url` (e.g. `https://www.tcgplayer.com/product/490294/...`) — grab the product ID from that URL during the same call we already make for the current single-number price. Zero extra round trips.

### Secondary: **JustTCG via local backend proxy** (power-user mode)

If the user is also running the `pokemon-auto-lister` dashboard (`npm start`), the extension can hit `http://127.0.0.1:3000/api/price-grid?identity=...` instead. The backend already has `JUSTTCG_API_KEY` configured and `extractNearMintUsd(card)` in `src/pricing/justTcg.js` — just need a small refactor to return the full `variants[]` structure instead of only NM USD.

Why bother:
- Project already pays for JustTCG → no new vendor relationship
- Key stays on the server → no "key visible in extension" worry
- Cross-reference against PokemonPriceTracker to detect bad data

Trigger: extension probes `GET http://127.0.0.1:3000/api/health` on popup open. If reachable, show "Pro Mode" badge and prefer backend pricing. Otherwise fall back to direct PokemonPriceTracker calls.

### Deliberate skip for now: **Scrydex**

- Data quality is best in class (half-grades, 1D/7D/14D/90D trends, population reports)
- But $29/mo minimum with no free tier → wrong price point for personal use
- Keep as the upgrade path if we ship this to more users and the free PokemonPriceTracker tier bottlenecks us

---

## Open questions before implementation

1. **Key management UX**: default to "no key configured → use pokemontcg.io single price only." Add an options page where the user pastes a PokemonPriceTracker key. Clear "get a free key here" link. OK?
2. **tcgPlayerId mapping cache**: once we extract a tcgPlayerId from pokemontcg.io, store it alongside the catalog so we don't re-parse the URL every scan. One-time pass over catalog.
3. **Rate-limit guard**: at 60 req/min + 100 credits/day free tier, a user who scans 20 pages a day of 6 cards each burns the day's budget by page 17. Need a visible counter in the popup ("23 / 100 lookups left today") and graceful fallback to pokemontcg.io single-price when exhausted.
4. **Price mismatch policy**: if PokemonPriceTracker (US) and JustTCG (via backend) disagree by more than 20%, which do we show? Prefer PokemonPriceTracker (fresher), but surface the delta as a "±X% other source" hint.
5. **Cache strategy**: current pricing cache is a flat 24h TTL. Per-condition data is more valuable to cache longer (NM/LP spreads are stable), but graded data moves faster. Split TTLs — 24h raw, 6h graded.

---

## Sources

- [JustTCG API docs](https://justtcg.com/docs)
- [Scrydex pricing + features](https://scrydex.com/)
- [PokemonPriceTracker API reference](https://www.pokemonpricetracker.com/api-docs)
- [TCG API (tcgapi.dev) tiers + comparison](https://tcgapi.dev/)
- [JustTCG vs TCG API comparison](https://tcgapi.dev/compare/justtcg/)
- [TCGPlayer API deprecation notice](https://tcgapi.dev/compare/tcgplayer-api/)
- [Cardmarket third-party API docs](https://cardmarketapi.com/docs)
- [eBay Browse API sold-listings guide](https://compsniper.com/guides/get-sold-items-ebay-api)
- [Pokemon card APIs 2026 overview](https://www.scrapingbee.com/blog/pokemon-card-api/)
- [Pokemon card condition definitions (NM/LP/MP/HP/DMG)](https://pokescope.app/condition-guide/)
