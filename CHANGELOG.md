# Changelog

## 2026-10-23 (copy or download the confirmed lot; Near Mint label)

### Added
- Popup lot strip: "Copy N confirmed" and "Download CSV (N)" buttons for the confirmed cards only (the same cards the Sure total counts: named and settled, not demoted to Choose, not priced from an old grid). Hidden when N is 0; the tooltip says how many more cards still need confirming and are not included. No new permission or host: the click writes the clipboard (`navigator.clipboard.writeText`, falling back to a hidden textarea and `execCommand("copy")`) or saves a Blob through a temporary link, as the options page already does.
- `lib/lot-export.js` (pure): one row per card + printing + condition with Qty; columns Name, Set, Number, Printing (or "open"), Finish, Condition, Qty, Price, Low, High, Price source, Price date, Price age days, Basis ("raw, English, <condition>"). An open printing leaves Price blank and gives the range as Low/High. CSV is RFC 4180, UTF-8 with BOM, CRLF, `card-lot-YYYY-MM-DD.csv` (local date); a cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading apostrophe (CSV and the tab-separated copy). No page address, image or seller data.
- The est. value header and the lot strip show the active condition (NM by default) as a small label, with a tooltip that prices are Near Mint market prices unless the user's price-service key provides other conditions.

### Changed
- `isStale` in `lib/card-display.js` is exported so the export and the lot total share one predicate.
- Store privacy policy and listing: one sentence each about the click-to-copy/download.

### Tests
- New `tests/lot-export.test.js`; popup e2e cases for the buttons, tooltip, hidden at 0, Copy, clipboard fallback, Download (name, BOM, CRLF) and the Near Mint label. No existing test changed.

## 2026-10-23 (picker fixes: art for every printing, a version tap stays confirmed, focus stays in the strip)

### Fixed
- Printing tiles for Scarlet & Violet sets showed a card back: `background.js` built `setChoices` (two places), the per-version set choices and the version entries without `imageUrl`, and `thumbUrl` then asked pokemontcg.io for TCGdex set codes (`sv03`; pokemontcg uses `sv3`), which answers with a card-back picture. New `choiceSummary` (`lib/set-choice.js`) carries the catalog row's `imageUrl` into all of them. `thumbUrl` prefers `imageUrl`; with none it uses the catalog's own TCGdex host for `sv`/`me` set codes, pokemontcg.io only for the older series whose ids agree, and nothing (a text tile) otherwise. The learning-bundle rows (`lib/bundle.js`) already carry `imageUrl`. A tile whose picture decodes narrower than 20 px now falls back to a text tile like a failed load.
- Tapping the other-version tile on a row the user had confirmed sent it back to Choose (`swapVersion` kept `unsure: true`). The tap is the user's answer: `unsure: false`, `userConfirmed: true`; price and range logic and saved corrections unchanged.
- Focus after a pick stays in the strip: on the chosen finish chip (it jumped to the printing tile), and on the newly checked printing or version tile (it landed on "Wrong card?").

### Tests
- `card-display.test.js` (swapVersion of an unsure row), `card-picker.test.js` (`thumbUrl` never builds a pokemontcg.io URL for TCGdex codes), `set-choice.test.js` (`choiceSummary`), popup e2e (sv printing strip requests the catalog art and never pokemontcg.io, speck image fallback, version tap stays confirmed, focus in the strip).

## 2026-10-23 (image-first pickers: printings, versions and finishes are tapped, not named)

### Changed
- Popup: the Set? / Pick printing menu is a strip of card thumbnails (catalog art, set name and number under each; same `thumbUrl` as the candidate cards, no new host). One tap runs the same `saveCorrection` (`via: "set-menu"`) and `pickSet` as the old select. The suggested printing is ringed with the existing "Suggested" tag and the "?" confirm.
- Popup: "Other version?" is the same strip with the version name under each tile (the shown card first, checked); a tap swaps the row exactly as the old select did.
- Popup: the Variant menu is large chips, each with the finish label and its price at the first enabled condition (label only when it has none), the chosen one highlighted, the suggested one ringed with its "?" confirm. A tap sets the printing like the old select.
- Strips scroll horizontally with scroll-snap; more than 8 choices show 8 and a "More +N" tile that expands in place ("Fewer" collapses). Art that fails to load becomes a text tile (name and set). Each strip and chip group is a `radiogroup` with an accessible label; tiles are `radio` buttons with `aria-checked`; Arrow keys/Home/End move, Enter/Space select, focus returns to the row after a pick.
- The top status line ("Found N cards: ...") is recomputed from the current cards whenever a promotion, demotion or pick changes them, while the scan status is what the bar shows (a pick's own "Getting price..." message still replaces it).
- Tapping the picture of a suggested printing confirms it through the same path as the "?" (saveCorrection `via: "guess-confirmed"`, same price update); the suggested finish chip already did. Tapping an already confirmed tile or chip does nothing and sends nothing; a different tile picks that one.
- The lot-level Base Set edition control is unchanged (still a compact select).

### Added
- `lib/option-strip.js`: pure view models (`setTiles`, `versionTiles`, `finishChips`, `splitMore`) and markup (`renderTileStrip`, `renderChipGroup`); `formatPrinting` moved here from `popup.js`.

### Tests
- New `tests/option-strip.test.js`. `extension-wasm-popup.spec.js`: new cases for the strips, taps, keyboard, More, image fallback, version swap, finish chips and the status line; updated the three Set? `toHaveValue` checks, the Variant `?` test and the Base Set edition test (they read the removed selects). `tests/e2e/live-scan.mjs` set pick now taps a tile.

## 2026-10-23 (price decides how much picture evidence a card needs)

Product stays at two user-visible states (CONFIRMED / CHOOSE). QA D-1: two wrong cards were auto-confirmed with real prices at cosine 0.73 ('Regice ex' Hidden Legends #97 $303.75 at read height 312; 'Regirock ex' Emerald #99 $179.99 at 334).

### Changed
- `lib/fusion.js` `CONFIRM_ROWS` raised to the floor analysis (`card-scanner-data/data/reports/fusion-study-E/floor/README.md`): under 200 px never; 200-249 T 0.68 / G 0.03; 250-299 T 0.72 / G 0.03; 300-349 T 0.74 / G 0.02; 350 and up T 0.76 / G 0.02 (was 0.62/0.03, 0.60/0.01, 0.69/0.00, 0.72/0.00). `UNKNOWN_HEIGHT_ROW` is still the 200 row, so it is now 0.68 / 0.03. The two QA cases (0.73 at 312 and 334 px) no longer confirm.
- `tools/shared-data/pipeline/gate.py` `CONFIRM_ROWS` mirrors the new rows (drift test and gate tests updated). `SMALL_ROWS` and the price rules are not mirrored: nightly rows carry no read height and no price.

### Added
- `lib/fusion.js` `SMALL_ROWS` (100-149 px T 0.68 / G 0.05; 150-199 px T 0.65 / G 0.05; lead over the best different-name card, no title demotion) and `smallRowDecision`. A read under 200 px that passes its row stays CHOOSE but carries `smallRow: true` and `smallRowCos` (also when the older gate abstained). Under 100 px nothing is flagged.
- `lib/stakes.js`: `LOW_STAKES_MAX_USD = 5`, `HIGH_STAKES_MIN_USD = 50`, pure `stakesDecision` ('promote' | 'demote' | 'keep'), `priceHighOf`, `promoteCard`, `demoteCard`, `isDemotable`. Promote: a CHOOSE card with `smallRow` whose top candidate costs at most $5. Demote: a picture-confirmed card that is not "high", not title-confirmed, not read from a printed number, priced at $50 or more (single price, or the high end of the open range). A card the user confirmed (`userConfirmed`: pick, search, accepted guess, bulk confirm) is never changed; an unknown price changes nothing.
- Popup: after a scan, only `smallRow` CHOOSE cards fetch the price of their top candidate through the existing `priceCard` call (at most 6 at a time, cached per candidate id, no new host). A promoted card is built like a pick, marked `autoConfirmed`, saves no correction and sends nothing for learning; "Wrong card?" still works. A demoted card becomes a CHOOSE card (`valueCheck`, its own name preselected) with a "Check: high value" chip; the overlay tag reads "Check: high value". Lot totals follow (promoted = Sure, demoted = To confirm). Evaluated on every scan and rescan.
- `background.js` carries `smallRow` / `smallRowCos` from the read and attaches `candidates` / `ranked` / `crop` to confirmed cards the stakes rule could demote.

### Tests
- `confirm-rule.test.js` (new rows, boundaries 199/200/249/250/299/300/349/350, QA D-1 regression, small rows), new `stakes.test.js`, `fusion.test.js` (two expectations moved with the rows), `test_gate.py`, popup e2e (stakes cases).

## 2026-10-23 (QA fixes: Clear, octet-stream photos, wording, tags, wizard size, version 3.0.0)

### Fixed
- Popup: Clear now hides and empties the lot summary line and the full-size notice (`resetResults`), so the popup returns to its empty state (QA D-2).
- `background.js` `loadPhotoSource`: a response typed `application/octet-stream` or with no content-type is accepted only when its bytes sniff as an image (JPEG, PNG, WebP, GIF, AVIF; `lib/photo-fetch.js` `photoTypeVerdict` / `sniffImageType`). ShopGoodwill serves pictures that way, so its rendition upgrade and original read were dead. Host, redirect, size and time caps are unchanged; other types are still rejected (QA C-1).
- Overlay tags (`content.js` `tagRows`, `fitPrice`, `fitName`): a Choose tag collapses to "Choose" when "Tap to choose" does not fit; a small confirmed tag shows the name (cut with an ellipsis only if three letters still show), else the whole price, else "from $low"; a price is never cut mid-number (QA D-3).
- Setup wizard quotes the size of the assets actually missing (`missingAssets`, `downloadSizeText`), e.g. "about 89 MB" when only the recognizer is needed; the fixed "(1-3 minutes)" is gone.

### Changed
- Leftover "guess" wording removed from user-visible text: To confirm tooltip, "Best guess" tag and aria-labels now say "Suggested" / "Suggested set"; the picture-based set reason reads "suggested from the picture" (QA D-4).
- Candidate art boxes get a neutral skeleton background (QA D-5).
- Extension version 2.1.0 to 3.0.0 (`tools/extension-wasm/manifest.json`); `tests/store-build.test.js` version pins updated deliberately.
- `tools/shared-data/README.md`: no longer quotes an old clip hash; points at `pins.json` and `setup.js`.

## 2026-10-23 (unknown read height uses the 200 px confirm row)

### Changed
- `lib/fusion.js` `confirmDecision`: an unknown read height (0, missing or not finite: grid-page tiles, legacy scan path) now uses the 200-249 px row (T 0.62, G 0.03, exported as `UNKNOWN_HEIGHT_ROW`) instead of the native row (T 0.72, G 0.00). The native G=0 was fitted on large crops and confirmed a Double Colorless Energy tile as Lightning Energy with no lead, while T=0.72 was too strict for ~140 px thumbnails and sent correctly-read Mixed tiles to CHOOSE. Known heights are unchanged.
- `tools/shared-data/pipeline/gate.py` mirrors it (`UNKNOWN_HEIGHT_ROW`): regression and exam rows, which carry no height, are replayed on the 200 row. `test_drift.py` compares the unknown-height row choice between both files.

## 2026-10-23 (model E and the per-height confirm rule)

### Changed
- The shipped recognizer is model E (`fastE_all/epoch16-ema-int8.onnx`, release `v3.0`, 88,999,043 bytes, sha256 `0dba1302580da2a629936be835b765d6dba9019e677284257470d30070d9d52b`; tag prefix `0dba1302580da2a6`). Pinned in `lib/setup.js` and `tools/shared-data/pins.json`; `CACHE_NAME` and the catalog are unchanged. Tests that echo the pin updated. Staged release files in `dist/release-v3.0/` replaced (old file kept as `_F-clip_visual_int8.onnx.bak`); `docs/release-v3.0-notes.md` has the new sha and model description, and says E results are pending.
- `CARD_BACK` re-derived for E from the 71 verified training backs (`cardback-E/cardback_vector.json`); `CARD_BACK_BUILT_FOR` is `0dba1302580da2a6` / crop 3. `BACK_MIN` stays 0.84 (held-out precision 1.000, recall 0.882).
- `lib/fusion.js`: the accept gate and the height caps are replaced by the per-height confirm rule (`confirmDecision`, table `CONFIRM_ROWS`, fitted for E per `card-scanner-data/data/reports/fusion-study-E/README.md`; refit whenever the model, crop or catalog changes). Confirm needs a card height of at least 200 px, `a_top >= T(h)` and a lead of at least `G(h)` over the best card with a different name, where a candidate loses 0.05 when the title line spells another catalog name. Under 200 px nothing confirms. An unconfirmed read that the previous gate could name is a CHOOSE (unsure, 0.49, guess first); otherwise it abstains as before. The high tier (`HIGH_TIER_SIM` / `HIGH_TIER_GAP`) and `CLEAR_GAP` are unchanged.
- `background.js`: the title line is read before the decision for crops of 200 px and up (`TITLE_MIN_HEIGHT` 200, was 150) and its contradiction demotes candidates inside the rule. A title that agrees adds nothing (no bonus), so it no longer lifts a CHOOSE to identified; contradiction handling after the decision is unchanged.

### Removed
- `capSmallSource`, `MIN_RELIABLE_HEIGHT`, `MIN_NAME_HEIGHT` (replaced by the confirm rule and `markChoose`).

## 2026-10-23 (review all: scores, printing-only pairs, Tick all)

### Changed
- Every card that gets candidates now carries `ranked` as `[{ id, rank, score }]` (`score` is the cosine similarity; `rank` as before), attached where the candidate list is built (`recognizeCard` records the hits, the scan's candidate step attaches them). Existing `{ id, rank }` consumers are unaffected; the page set prior still only sees the cards it saw before.
- Review all: the lead is measured on `score` (rank for older rows) between the preselected candidate and the best candidate with a different card name, `>= CLEAR_GAP` (value unchanged), so clear pairs exist beyond the abstain and re-rank paths. No scores: not decisive unless the name agrees.
- Review all: when every candidate is the same card (only the printing is open) the pair starts unticked with "Check"; the printing is the user's pick.

### Added
- Review all: a "Tick all" / "Untick all" button beside the note. It only changes the ticks; "Confirm N" still needs its own press.

## 2026-10-22 (choose flow refinements)

### Changed
- Popup, To confirm: a candidate whose name agrees with the photo's name-box read (`titleConfirmed`, `titleReranked`, `titleContradicts`) is preselected: it comes first and carries the "Best match" tag and its name check. A candidate the title contradicts is never preselected while another exists. No title evidence changes nothing.
- Review all: a pair is ticked by default only when its preselected candidate agrees with the photo's name or leads the best candidate with another card name by at least `CLEAR_GAP` (now exported from `lib/fusion.js`, value unchanged; scores come from the card's `ranked`). Every other pair starts unticked with a "Check" label; a card with no scores is not decisive. "Confirm N" counts ticked pairs; with none ticked it is disabled and says "Tick the ones that look right". New line under the title: "Ticked pairs look like clear matches; check the others yourself."
- Review all thumbnails (photo crop and candidate art) are 63 x 88 px so they can be compared.
- `lib/set-choice.js`: a leading "Basic" is ignored on Energy names only (`choiceName`, `nameAgrees`, `titleConfirmsName`), so "Basic Water Energy" and "Water Energy" are the same card. Every "Basic ..." name in the catalog is a basic Energy; "Basic Charizard" stays distinct.

## 2026-10-22 (choose flow)

Two identification states (branch `feat/choose-flow`): Confirmed and Choose.

### Added
- Popup: a "To confirm (N)" group first in the list. Each card below the bar shows its crop beside up to 5 candidate cards (art when the catalog has it, name, set, number, printing when known), the best match preselected with a one-press "Confirm <name>" button, any other candidate confirmed with one tap, and "None of these? Search". A candidate whose name agrees with the photo's name line (existing title verdict: `titleConfirmed`, `titleReranked`, `titleContradicts`) carries a check mark.
- Popup: "Review all N" opens an in-popup panel with every card to confirm beside its preselected candidate, a keep/skip checkbox per pair (default keep) and one "Confirm N" button. Skipped pairs stay in Choose; Escape or Cancel closes; Tab stays inside the panel.
- `lib/choose-flow.js`: `chooseState`, `overlayStateOf`, `nameAgreesWithPhoto`, `candidateView`, `candidatesOfCard`, `bulkPairs`, and the candidate and group renderers.

### Changed
- The page overlay has no guess tier: a card to choose is amber with the tag "Choose" / "Tap to choose", no name and no price; its hover label says "Choose a card". Confirmed cards keep green (blue while the printing is open); card backs stay grey ("Not recognised" / "Turn it over").
- A row to choose shows "Card N", no name and "—" for the price; confirming goes through the existing pick path (same saveCorrection, `via: candidates`, same price lookup), so teaching and shared learning receive exactly what they did.
- Tests updated for the removed guess tier: `tests/content-pure.test.js` (tag, label and state assertions), `tests/guess-first.test.js` (`topGuessOf` test removed, guess fixtures now candidate-based), `tests/e2e/extension-wasm-popup.spec.js` (row order puts the choice first, picker sub-line, fixture without `topGuess`).

### Removed
- `topGuessOf`, the popup's "Top guess" chip and italic guess styling, the overlay `guess` state and its dashed outline. Thresholds, fusion, detector, price rules, manifest, permissions and host lists are unchanged.

## 2026-10-22

Rendition upgrade (branch `feat/rendition-upgrade`).

### Added
- `lib/rendition.js` `upgradeRenditionUrl`: the largest rendition a listing site serves, from measured URL rules (Mercari drops `/thumb` and the width/quality query; HiBid `w=0&h=0&sz=MAX`; ShopGoodwill `t<k>.jpeg` to `<k>.jpg`; Craigslist 50x50c / 300x300 / 600x450 to 1200x900; Poshmark `s_`/`m_` to `l_`, `_wp_` webp twins kept). Same host, https only, null for anything else. The photo read, gallery photos and the tile source look try it first and fall back silently to the shown URL; `largerRendition` counts it as a known larger rendition. No new hosts or permissions.

## 2026-10-22

Rendition upgrade (branch `feat/rendition-upgrade`).

### Added
- `lib/rendition.js` `upgradeRenditionUrl`: the largest rendition a listing site serves, from measured URL rules (Mercari drops `/thumb` and the width/quality query; HiBid `w=0&h=0&sz=MAX`; ShopGoodwill `t<k>.jpeg` to `<k>.jpg`; Craigslist 50x50c / 300x300 / 600x450 to 1200x900; Poshmark `s_`/`m_` to `l_`, `_wp_` webp twins kept). Same host, https only, null for anything else. The photo read, gallery photos and the tile source look try it first and fall back silently to the shown URL; `largerRendition` counts it as a known larger rendition. No new hosts or permissions.

## 2026-10-22 (earlier)

Pricing guards (branch `feat/pricing-guards`).

### Added
- Lot-level Base Set edition control in the popup (Unlimited / Shadowless / 1st Edition, "Apply to all"), shown only when a settled row has its finish read from the number or catalog but its grid has 1stEdition / Shadowless rows. It sets that edition on every such row the user has not set on its own Variant menu; an individual pick wins. The star-only promo path is unchanged.
- Popup e2e tests for the Variant "?" confirm, the "To confirm N" lot cell, the lot edition control and a page-borrowed set; the startup test now waits for the background's readiness instead of sampling the scan button early.
- A named row whose printing is still open is priced at its default printing's NM price (holofoil, then normal, then reverse; chosen over median, 25th percentile, cheapest and geometric mean on lot-level error), shown as "~$x" and counted under Guesses, never Sure. A confirmed printing keeps its exact quote.
- Top guesses on a multi-printing grid get the same default-printing "~" price instead of "no price".
- A pokemontcg.io fallback grid whose own date is over 30 days old carries `stale: true`; the price still shows with an "Old price: N days old" tooltip.

### Changed
- A 1st Edition stamp match (template score on pixels) that narrows a card to the one 1st Edition set no longer prices it: the set choices stay open as a range, the stamp's set is the preselected Set? suggestion (`suggestedSetId`, "1st Edition stamp seen on the card"), and "?" confirms it. A page heading still wins over it.
- A stale-grid price is listed "to check" and left out of Sure and the totals, like a guess over $50.
- Owner rule: a price is never chosen for something the extension does not know. This replaces the guess pricing above.
  - A card whose identity is not confirmed (top guess, asked name, not recognised) shows its name to confirm and "—" (tooltip "Confirm the card to see a price"); it adds nothing to any total. The page overlay tag says "Guess · tap to confirm".
  - A name that is sure with its printing open shows a range (set range, or the range over its printings) until the user picks the printing in the menu or confirms the suggestion with its "?" button.
  - A printing is auto-priced only from non-visual evidence: a single printing, a finish read from the printed collector number or the catalog (`finishSure`), or a set settled by number, code, symbol or stamp text. A printing inferred from the picture (variant model, 1st Edition stamp template, drop shadow) is the menu's preselected suggestion only; the new "?" button next to Variant confirms it. `detectedVariant` is the settled printing, `suggestedVariant` the picture's.
  - A best-guess set whose source is `image` keeps its set range and the preselected Set? menu, and prices only after "?" confirms it. A set borrowed from the page's other cards (`page` source) now behaves the same way. Only a page heading that names the set (`hint`) still prices directly.
  - Lot summary: Sure (confirmed rows plus ranges) and "To confirm N". No Guesses or Together figures.

### Removed
- Default-printing "~" pricing (`guessQuote`, `guessPrice`, `defaultPrintingPrice`), top-guess prices (the background `priceCard` fetch in the popup), the Guesses and Together totals (`lotTotals`), and the $50 picture-guess cap (`GUESS_TOTAL_CAP`): their purpose is covered by not pricing unconfirmed cards.

### Fixed
- A name from a picture-only best guess (`bestGuess.source === 'image'`) priced over $50 no longer counts in Sure; it is listed "to check". Page and hint best guesses are unchanged.

## 2026-10-21

Facebook Marketplace accuracy and UI pass (branch `feat/fb-accuracy-ui`, 899ba40 … 4c4aae5). The numbers, the rationale and the rejected experiments are in `HANDOFF.md` under "Facebook accuracy and UI pass".

### Added
- Guess-first. A card with no sure name shows its top guess and that card's price ("Pikachu? ~$1.20"): lighter amber, dashed outline. Clicking the tag opens its picks in the popup. A "small photo" chip shows under 150 px read height. (ba59d38)
- Lot totals: Sure / Guesses ~ / Together. A guess priced over $50 is listed "to check" and not added. (ba59d38, 5a02883)
- Full-size offer. When most cards in a photo were read small and a larger rendition is known (a srcset `w` entry or a Facebook `ctp` original), the popup bar and overlay pill offer to open the full-size photo and scan it. (ba59d38)
- Gallery scan. With site access, every photo of a listing is read (≤8, 45 s), and a card seen in several photos is kept once. (b032a2b)
- Site-access offer after a screenshot fallback: this site's photo hosts, all sites, or not now. (4eeb10f)
- Title-line OCR as a second opinion on crops ≥150 px. (e554499)
- On fbcdn hosts, the Facebook original is read (`ctp=` dropped, up to 2048 px), falling back to the shown photo. (2dc8aec)
- `docs/blurry-training-plan.md`. (4c4aae5)

### Changed
- A sure name with an open printing shows as identified, priced as a range, with "pick printing". Names now show from 200 px crops. (899ba40)
- Overlay tags are coloured by the list's verdict and placed without overlap. They are bigger: 13–16 px, bolder, with a shadow. A page-started rescan updates the popup. (49600f0, 9377d62)
- One search link per popup row. (e06cc24)

### Fixed
- Card pieces cut off by the photo edge no longer produce wrong names. (e48c421)
- The first scans after install wait for the photo adapter bundle. (226ba94)

### Results (FB11 source read, right (sure) / wrong (sure))
- main 69 (5) / 21 (1) → branch 74 (57) / 17 (3).
- Marketplace-style fixtures 14 / 11 → 39 (34) / 13 (3).
- Facebook-CDN original of photo-1: 3 / 10 → 12 / 9.

## 2026-10-18 (evening)

Extension accuracy pass on grid pages (branch `fix/extension-only`: 4ba6689, a1a93e6, bf83b31, 2ffb802, da083e2, 7f99f35). Details and numbers in `HANDOFF.md`; plan in `docs/improvement-plan.md`.

### Added
- Best guess on grid tiles: a tile the gate would call Unknown is shown as its best guess, marked unsure, pre-selected in the "Which card is this?" pick-list with the closest cards after it. Pokellector Base Set fixture: 0 Unknown (was 25), 13 of the 25 guesses right, sure-wrong unchanged at 12.
- Soft multi-set page prior (`lib/set-prior.js`): re-orders unsure guesses toward the sets the page's settled cards share; a boost, not a filter. Mixed 3-set page: guesses right 10 -> 14.
- Source-image refinement (`lib/refine.js`): unsure grid tiles are re-read from the page's own picture, fetched by the service worker with existing host access (max 40 tiles and 30 s per scan, stops after 3 failures, no manifest change). Live Pokellector Base Set, same page layout: right names shown 73-78 -> 88-94 of 102, wrong shown 24-31 -> 8-15, +6-16 s.

### Fixed
- Whole-page scan counted the same grid tile twice when live ads shifted the layout between screens: rows 102-120 -> 102 (a1a93e6).
- Each grid tile was read twice (the image and its slot): fixture scan 82 s -> about 35-50 s (bf83b31).

### Changed
- Lint cleanup in `tools/extension-wasm` with no behavior change (repo lint 47 -> 41 problems).

### Not reproduced
- The 97-98 of 102 identified figure for Pokellector Base Set (2026-10-18 entry above) was not reproducible on a Linux box at DPR1: 68-77 identified of 102 with the same code (about 65 right). Real Chrome on the owner's PC is still to check. A multi-crop averaging experiment was tried and reverted (more confident wrong names, no more right names).

## 2026-10-18

Store-build debug pass (1536670, 654a132, era-restricted search).

### Added
- Whole-page scan (d4f8c12): any page except a single listing is scanned screen by screen (up to 12 screens, 200 cards, with a popup note when the cap cuts it short). Cards seen on two screens or read twice on one are deduped, the user's scroll is restored, one scan runs per tab, a mid-scan navigation aborts cleanly, and a capture quota error is retried once. Pokellector Base Set: 102 found, 97-98 identified, about 48 s. S&V 151 and Paldea Evolved hit the 200 cap with 191-193 identified at about 3 min. Single listings and HiBid lots unchanged.

### Fixed
- Overlay labels are clamped to the card width; under 140 px a card shows the price only.
- "151" is no longer read as a set from card numbers.
- Star cards are no longer grouped with plain names.
- The first scan waits for the number reader.
- Overlay frames and prices stay on their cards while scrolling and after resize (c118fe5).
- A rescan no longer captures the previous overlay. Pokellector Base Set grid identified 47 then 13 before, 47 and 47 now. "Scan again" after allowing site access always hit this (9a4b98f).

### Changed
- A set named in the page heading, breadcrumb or title is now the best guess for open rows. Pokellector Base Set grid: rows guessed Base Set 10 to 33. HiBid lots unchanged. Near-ties go by catalog order.
- Search is restricted to the page's era. Era 1999-2003 on that grid: 3 to 47 identified, no out-of-era suggestions. The store build no longer requests `variant.onnx`.

## 2026-10-17

Branch `feat/card-picker-sealed-test`.

### Added
- `lotValue` (one est. value for the popup) and `setRangeSpan` in `lib/card-display.js`.
- Lot value estimate for 3 or more cards: "Estimated lot value $X–$Y · N of M cards identified · K still to identify". Unpicked and unpriced cards count $0.
- Every unrecognised card (except card backs) asks "Which card is this?" with its 5 closest matches and search.
- Best guess for a card whose set is still open: the set the page's settled cards share, otherwise the printing the picture matched best. It is priced as that printing, never shown as high, keeps the Set? menu, and a "?" next to the name confirms it (reason in the tooltip). Confirming it, or picking from the Set? menu, is saved as a correction.
- Collector number read from the source photo's bottom corners for open-set cards at least 400 source px tall (`lib/corner-read.js`, `lib/set-codes.js` for printed Scarlet & Violet codes).

### Changed
- Detector boxes up to 1.82 wide/tall are kept (cards tilted to 45° or lying sideways). On 67 HiBid lot photos: +9 cards found, +6 right names, wrong names 13→14, no losses, 0 extra boxes on sealed-product negatives.
- Popup shows one price per card and one est. value in the action bar; the era picker sits there too.
- Filter chips moved to Settings > Prices; the popup reads them from `chrome.storage.sync` and updates live.
- Harness scripts updated for the new popup.
- The extension points at the live relay and the live signed community bundle.
- The photo adapter only ranks matches; accept, abstain and high still use the raw similarity. The bundle gate scores what users see.
- On 67 reviewed HiBid lot photos (186 matched cards, used for tuning before): rows with the set open 94 -> 0; exact card 48 -> 100 (51 settled by evidence, 49 best guesses right, 43 wrong); wrong confirmed set 3 -> 3; wrong name 13 -> 13. Page-prior guesses right 6 of 6, picture guesses 43 of 93. On 48 synthetic binder pages across all eras (432 cards): exact 155 -> 391, page-prior guesses right 38 of 42, picture guesses 86 of 117, wrong confirmed set 0 -> 0. Scan time on the 67 HiBid photos: median 3.4 s -> 3.8 s, total 310 s -> 401 s.

### Removed
- Model and source pills, API-key hint, ms/cards stats, condition grid and warning sentences from the popup; explanations are in tooltips instead.

## 2026-10-16

Branch `feat/card-picker-sealed-test` (not pushed).

### Added
- Chrome Web Store package (`scripts/build-wasm-extension.ps1 -Store`) with minimal permissions, optional site access, pinned downloads, privacy policy, listing copy and an original icon.
- Listing-photo focus: the scan reads the listing's own photo, finds related-item sections from their headings, and reads the largest rendition of the photo the page offers.
- Card picker: asks which card it is when unsure, orders choices by the listing title, and offers look-alike versions (ex / V / VSTAR / Dark) and other sets with price ranges.
- Popup offer for full-size photo access after a screenshot-only scan.
- Repeat guard: three or more boxes with the same name in one photo go to the picker.
- Optional look-alike penalty (off; built locally by `scripts/build-hub-penalty.py`).
- Opt-in shared learning: relay (`tools/relay`), data repo template (`tools/shared-data`), signed community pack with consensus, exam and regression gates.
- Signed bundle replaces the pack-only manifest (manifest v2): memory, photo adapter, "is this a card" check and new-set cards, each downloaded only when its sha256 changes and hot-loaded without a reload (`lib/bundle.js`, `lib/adapter.js`). Nightly pipeline writes all parts, gates them against the live bundle, and adds new TCGdex sets (`pipeline/new_sets.py`, at most 500 cards a night).
- Real-world harness `scripts/realworld-run.mjs`.
- Plans: `docs/plans/launch.md`, `docs/plans/shared-learning.md`, `docs/plans/self-learning.md`.

### Changed
- Card art is cropped the way the catalog was embedded. On 190 reviewed HiBid boxes exact card 26.3% -> 43.2%, right name 57.4% -> 70.5%.
- "High" confidence needs similarity >= 0.82 and a lead >= 0.025. On 28 real pages high rows fell 22 -> 3 and rows with a name and a price rose 33 -> 89.
- Rows whose only doubt is the set or version now show name and price (a range) instead of a blocking picker.
- Popup folds unrecognised cards into one row and counts only real identifications.
- The relay writes only to an `inbox` branch; the nightly job is split into a build job without secrets and a signing job; manifests carry `seq` and `issuedAt`.

### Fixed
- Version swaps pinned one printing's price; the listing title swapped versions on every box of a lot photo.
- Full-size photo fetches could name any public host; they are now limited to hosts the page already loaded images from, with bounded time and size and re-checked redirects.
- Carousel and heading caches outlived a scan on single-page apps.
- A forged crop or a single install could enter the community pack; install ids are hashed and replayed packs are rejected.
