# TODO — Price condition grid + graded pricing + toggles + set/number + variant confirmation

Proposal for the standalone `dist/extension-wasm/` scanner. That directory is generated/ignored according to `README.md`; before implementation, locate or establish its tracked source/build path. No condition detection on the card reader side — just surface the full price grid per card and let the user filter.

The existing backend `GET /api/price-grid` is documented as a JustTCG price-grid endpoint. This proposal's NM/LP/MP/HP/DMG and printing-variant data shape is a separate, not-yet-verified extension feature; confirm the actual JustTCG response before selecting a source or promising these fields.

---

## V. Variant detection from the card itself (2026-10-12)

The popup now says "Choose variant". These steps let the scan pick the variant when the card shows it.

### V1. 1st Edition stamp — DONE (uncommitted)
- `tools/extension-wasm/lib/edition-stamp.js`: masked template match of the real stamp (cut from a Jungle Marowak photo, `lib/first-edition-stamp.js`) in the area left of the stat bar, below the art. Card resized to 375x525, 8 stamp sizes, 134 ms per card.
- It runs only when the card's set (or a set the user may pick) had a 1st Edition: base1, base2, base3, base5, gym1, gym2, neo1–neo4. It also needs the card to be at least 400 source px tall.
- Stamp found:
  - The popup preselects the `1stEdition*` price and notes "1st Edition stamp found". The user can still change it.
  - Set choices are narrowed to 1st Edition sets. When one remains, the card is priced at once (Marowak: Jungle / Aquapolis / Fates Collide / Base Set 2 → Jungle).
- No stamp: nothing changes; the user picks.
- Measured on 154 ShopGoodwill crops (35 stamped, 25 lots fetched with `scripts/fetch-goodwill-lot.mjs`):
  - 33/35 stamps found and 0/119 false stamps.
  - Stamps score 0.68–0.94; the best non-stamp scores 0.63; the threshold is 0.70.
  - Misses: one stamp under holo glare, one partial close-up.
- Gap: TCGdex has no 1st Edition price for Base Set (`base1-4` has only `holofoil`), so a stamped Base Set card stays "Choose variant" until V3.
- Open: when no stamp is seen on a sharp (≥600 px) card from a 1st Edition set, preselect Unlimited?
  - That would save a pick on most WotC cards.
  - Cost: about 1 in 12 real 1st Editions would be priced low (glare).
  - Needs a decision.

### V2. Shadowless (Base Set only)
- Cue: Unlimited Base Set cards have a dark drop shadow along the right edge of the art frame; Shadowless and 1st Edition Base Set do not (seen on the 279630487 Ivysaur vs the 276846227 Squirtle).
- Measure first, as for V1:
  - Labelled set: the base1 cards in lots 279630487/279630443 (Unlimited) against 273298162, 274640714, 274639003, 276846227, 277838115, 279336484, 279118621 and 276737413 (Shadowless; already downloaded).
  - Feature: the luminance profile across the art frame's right border, in rows 20–38% of card height. Shadow means a dark band between the gold frame and the card body. Locate the frame edge per crop; the finder's boxes are loose.
  - Ship only if it separates like V1 does (no false Shadowless at the chosen threshold).
- Only for `base1`. A 1st Edition stamp on base1 already implies Shadowless.
- Result values: `shadowless: true | false | null`. `false` = shadow seen, so Unlimited can be preselected; that is safe because it is the cheaper price.

### V3. Price source for Shadowless and Base Set 1st Edition (TCGCSV)
- TCGdex/pokemontcg.io have one Base Set price (Unlimited). [TCGCSV](https://tcgcsv.com) mirrors TCGplayer daily, keyless:
  - Group 604 is "Base Set".
  - Group 1663 is "Base Set (Shadowless)". Each product there has "Unlimited Holofoil" (= Shadowless) and "1st Edition Holofoil" rows, e.g. Charizard 106999: Shadowless $2,257.87; 1st Ed has no market price, only low/mid.
- Plan:
  - `lib/tcgcsv.js`: fetch `/tcgplayer/3/1663/products` + `/prices` once a day into `chrome.storage.local`, keyed by card number (`extendedData` Number "4/102").
  - For `base1-*` cards, add the variants `shadowless` and `1stEditionHolofoil` / `1stEditionNormal` to the grid next to the TCGdex Unlimited price.
  - Use market price, then mid; mark "few sales" when market is missing.
  - Add `https://tcgcsv.com/*` to `host_permissions`.
- Tests: parser on a saved TCGCSV sample (products + prices), base1 number join, missing-market fallback, non-base1 untouched.

### V4. Promo and other stamps (plan only; build after V2/V3)
- Stamp kinds seen or known:
  - Prerelease, Staff, and W (Wizards promo) stamps on the art.
  - League / Championship stamps.
  - Set-logo stamps on reverse holos (e.g. Crystal Guardians stamped reverse holo, which abstains today).
  - Pokémon Center stamps.
- Before building:
  - Check that a price source lists the stamped versions separately (TCGplayer usually has separate products, e.g. "Prerelease"). Without a price, detecting a stamp only adds a label.
  - Collect positives per stamp from ShopGoodwill searches ("prerelease pokemon", "staff stamp"). The same template approach applies, with one template per stamp and an area per layout era.
- Order: Prerelease/Staff (fixed spot on the art, high price impact), then reverse-holo set stamps.

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
