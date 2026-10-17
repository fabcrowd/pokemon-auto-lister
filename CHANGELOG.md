# Changelog

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
