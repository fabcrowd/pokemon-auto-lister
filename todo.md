# TODO — Price condition grid + graded pricing + toggles + set/number + variant confirmation

Features that extend the existing `dist/extension-wasm/` scanner. No condition detection on the card reader side — just surface the full price grid per card and let the user filter.

---

## 0. Show set + number prominently, and confirm the variant before pricing

This is **the most important thing on this list** and belongs before the condition grid. The screenshot from the last build shows "Charizard  $928.06" on a Base-Set Charizard image. That number is TCGPlayer's **unlimited holofoil market price**. The exact same art prints as:

| Printing                          | Approx NM ungraded |
|-----------------------------------|--------------------|
| Base Set — Unlimited Holofoil     | ~$900              |
| Base Set — Shadowless Holofoil    | ~$4,000–$6,000     |
| Base Set — 1st Edition Shadowless | ~$20,000–$50,000+  |

CLIP sees identical pixels. The current pipeline has no way to pick the correct one — and showing one number without the printing context is actively misleading.

### What the user sees — v1 overlay badge
Three lines instead of two:

```
Charizard                 ← name
Base Set · #4             ← set + number (ALWAYS show)
Unlimited Holo · $928.06  ← variant + price
```

If multiple variants exist for the same art, add a chip row below the price indicating the ambiguity:

```
⚠ 3 printings · Unlimited $928 · Shadowless $4,500 · 1st Ed $38,000
          [confirm variant ▾]
```

Clicking the chip opens the popup results row anchored to that card with a radio-select for the variant. Once chosen, the overlay re-renders with the chosen price and remembers the choice for the session (per cardId).

### What drives the variants
- **Edition markers** on card itself: "1st Edition" stamp (bottom-left of art), presence/absence of drop shadow on art frame (= Shadowless), set symbol in bottom-right.
- The scanner reader cannot be asked to detect these (per prior constraint). So we ask the user, or we infer from image sharpness/dimensions if confident, but the safe default is **ask**.

### Data layer
Pokémon TCG printings are tracked across these fields:
- `set` + `number` → identifies the "card" at the product level
- `rarity` + `finish` + `edition` + `watermark` → identifies the **printing** (what actually determines price)

pokemontcg.io flattens some of this into `tcgplayer.prices.<variant>` keys like `1stEditionHolofoil`, `holofoil`, `reverseHolofoil`, `unlimitedHolofoil`. We're already enumerating these in `pricing.js VARIANT_ORDER` — but today we return the first non-null one and discard the rest.

**Fix**: `getPrice()` returns the **full** variant map, not just the first hit:

```js
{
  variants: {
    "1stEditionHolofoil": { price: 38000, low, mid, high, market },
    "holofoil":           { price: 928.06, ... },
    "unlimitedHolofoil":  { price: 850, ... },
    // ...
  },
  defaultVariant: "holofoil"   // best guess from art
}
```

The popup/overlay renders every variant that has a price. The user confirms which one they're actually holding.

### Pricing confirmation / sanity checks
Before shipping any price number, run cheap sanity checks and flag when something looks off:

- **Price spread flag**: if `max(variants) / min(variants) > 10`, show a visible warning badge ("variants range $X–$Y"). This is the signal that "same art, radically different prices" is in play.
- **Freshness flag**: if the TCGPlayer `updatedAt` is older than 7 days, mark the price as stale.
- **Sample-size flag**: when we move to per-condition / graded sources that report sample counts, show "N sales / 90d" and dim prices with n < 3.
- **Price source footer** on each number: "TCGPlayer · updated 2d ago". No invisible authority.

### Open questions
- Do we ask the user to confirm the variant **before** the first scan (e.g. a "mostly-raw / mostly-graded / mostly-vintage" preset) or **per card**? Per card is correct but higher friction. Maybe both — preset default, override per card.
- Is there any safe automated heuristic? E.g. seller-photo of a slabbed card → almost certainly graded, drop raw prices. Edge/corner darkening heuristics → maybe shadowless detection. Flag as "research later," don't block v1.
- When the user confirms a variant on a card, do we persist that choice forever for that cardId? Session-only is safer — they may scan a different physical copy next time.

---

## 1. Per-condition raw prices (NM / LP / MP / HP / DMG)

### What the user sees
For each identified card, the overlay badge and the popup results row show the market price per condition, not a single number. Example:

```
Charizard · Base Set · #4
NM  $928.06
LP  $695.00
MP  $510.00
HP  $320.00
DMG $140.00
```

Overlay compact view: show NM by default, expand on hover/click to a mini grid. Popup row: show the full grid inline.

### Data source — the real work
`pokemontcg.io` → `tcgplayer.prices.<variant>` only exposes `low / mid / high / market / directLow`. **It does not break out NM/LP/MP/HP/DMG.** Those live on TCGPlayer's product pages behind the public listings grid.

Options, in order of fidelity:

- **TCGPlayer product page scrape** via the `productId` returned in `tcgplayer.url`. Load the "Listings" tab, parse condition totals. Blocked by TCGPlayer's bot protection unless we add a proxy or use the API.
- **TCGPlayer API** (requires partner approval). Clean and official if we can get in.
- **JustTCG API** — the stable price feed `pokemon-auto-lister` already consumes server-side. Confirm it returns per-condition fields.
- **PriceCharting** — reliable per-condition data, no auth needed for cached values but TOS-sensitive for scraping.
- **eBay Browse API sold comps** — filter by condition facet. Needs an eBay dev account.

**Decision needed before coding**: which source(s) to use, in what priority, and how to merge when multiple return a condition.

### Implementation sketch
- `lib/pricing.js` returns a `grid: { NM, LP, MP, HP, DMG }` object with each slot either `{ price, source, sampleSize }` or `null`.
- Keep the existing `market_price` single-number field for backwards compatibility — it becomes `grid.NM` or whatever the user's default filter is.
- Cache strategy: cache the full grid under a single storage key per card id. 24h TTL stays.
- Fallback across the per-condition grid works the same way as the current per-set fallback: if the top-1 identity has no NM price, walk top-K same-named candidates.

### Open questions
- What's the authoritative source for Pokémon TCG per-condition market prices that we can call from an extension SW without a backend?
- Do we need user auth / API keys baked into the extension? If yes, where do they live? (chrome.storage.sync with user-provided keys, probably.)
- Latency budget: 6 cards × 1 request each × up to 300ms per request = ~2s cold. With a per-condition grid, we may be doing 2-3× that. Need to batch where possible.

---

## 2. Graded-copy pricing (PSA 10 / 9 / 8, BGS 10, CGC 10, ...)

### What the user sees
A second grid on each card: graded prices. Common grades to show:

```
PSA 10  $4,500
PSA 9   $1,800
PSA 8   $900
BGS 9.5 $3,200
CGC 10  $4,100
```

Not every card has recent graded sales. Show only grades with real data; mark older samples as stale.

### Data source
`pokemontcg.io` does not return graded data. Candidates:

- **PriceCharting** — the de-facto free source for graded sales history. Per-grade market numbers + last sale date. Rate-limited but workable.
- **eBay Browse API** — filter by `Graded=Yes` facet + grade string. Freshest signal, needs auth.
- **PWCC Marketplace** — has graded sold data but less API-friendly.
- **GemRate / Collectors.com (PSA)** — PSA has an auction prices endpoint. May require subscription.

**Decision needed**: pick a single primary source for v1. Mixing sources with different sample windows breaks user trust.

### Implementation sketch
- Separate `lib/graded-pricing.js` module — different cache namespace, different TTL (graded prices move more slowly than raw).
- `getGraded(identity) → { PSA10, PSA9, PSA8, BGS95, CGC10, ... }` with same `{ price, source, sampleSize, asOf }` shape as raw conditions.
- Prefer `last 90 days of sold comps` over "asking price." Asking is noise.
- Separate overlay badge section for graded, visually distinct from raw.

### Open questions
- Which grading companies to surface by default? PSA + BGS + CGC covers 95% of market volume. SGC / HGA are niche.
- Half-grades (PSA 8.5, BGS 9.5) matter a lot for high-end cards — budget space in the UI for them.
- Do we treat Pokémon Pocket cards (no physical copies) as "ungraded only"? Yes.

---

## 3. Toggleable price filters

### What the user sees
The popup gets a filter bar above the results list:

```
Raw: [NM] [LP] [MP] [HP] [DMG]     Graded: [PSA10] [PSA9] [BGS] [CGC]
```

Toggles are chip buttons. Multi-select. State persists in `chrome.storage.sync` so it follows the user across devices if they're signed in.

Behavior:
- Overlay badges show only the enabled conditions/grades
- Popup rows show only enabled columns
- "Total value" in the stats bar sums the first-enabled condition per card (NM-first unless the user disabled it)

### Default state
- Raw: NM on, everything else off (matches today's single-price behavior)
- Graded: all off (opt-in because graded data is noisier and may be slower)

### Implementation sketch
- New `lib/filters.js` module owning the toggles, backed by `chrome.storage.sync`
- Filters live in the popup UI; the SW doesn't need to know about them — it always returns the full grid, the popup/content.js decide what to render
- Popup renders the filter bar + wires `change` events to re-render results and re-send an updated `showOverlay` message to the content script
- Content script receives the current filter set in each `showOverlay` payload (keeps content.js stateless)

### Open questions
- Should "total value" be configurable (which condition to sum) or always default to the highest-priced enabled condition? Latter is more useful for a seller doing a quick lot estimate.
- Keyboard shortcuts for toggles? Probably not — this is a mouse-first popup.
- Do we persist per-page or globally? Globally — the user's preference shouldn't reset per site.

---

## Suggested ordering

1. **Fix the misleading-price problem first** (section 0). Return the full variant map from `getPrice`, show set + number in the overlay badge, add the ambiguity chip + per-card variant confirm. Nothing else matters if a user sees `$928` on a card worth `$38k`.
2. **Build the condition grid data pipeline** (section 1). Everything downstream depends on `getPrice` returning richer shape — section 0 already restructures the return shape, so land both together.
3. **Add graded pricing module** (section 2) — same shape, different source.
4. **Wire filters last** (section 3) — pure UI, no new data dependencies, easy to iterate.

Hold on the UI layout decisions (badge compact view, filter chip style) until the data pipelines are proven. Nothing kills a UI refactor like discovering mid-build that your data source can't deliver.

---

## Non-goals

- Automatic condition detection from the card image. (Explicitly rejected by user. Reader stays identification-only.)
- Price history charts. Nice but out of scope for this pass.
- Alerts / price-drop watching. Separate feature, needs background scheduling.
