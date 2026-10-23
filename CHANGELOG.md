# Changelog

## 2026-10-22

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
