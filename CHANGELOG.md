# Changelog

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
