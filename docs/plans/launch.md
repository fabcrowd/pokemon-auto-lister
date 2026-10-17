# Launch plan — Chrome Web Store

Owner: Claude (PM), started 2026-10-16. Publishing, pushing, and hosting stay with the user.

Source: the store-readiness audit of 2026-10-16. The policy citations are in the commit messages of the packages that fix them.

## L1 — Packaging and permissions (code)

Status: done (ef11ec4). The store build is `scripts/build-wasm-extension.ps1 -Store`; `tests/store-build.test.js` pins its permissions and hosts.

- **Self-contained build.** `build-wasm-extension.ps1` fails when `vendor/` (onnxruntime-web) is missing, and it says how to fetch it (`scripts/setup_vendor.ps1`). The upstream files are copied unmodified. Remove the unused threaded wasm files (`numThreads = 1`).
- **Pin every download.** Every download in `lib/setup.js` gets a `sha256`.
- **Drop the content script.** Remove the `<all_urls>` content-script block from the manifest; it is injected on demand already.
- **Drop the `tabs` permission.** Use `chrome.runtime.getContexts` instead.
- **Optional site access.** Move `<all_urls>` to `optional_host_permissions`.
  - Ask for it in setup and in options as "Read full-size photos on sites you scan (more accurate)".
  - Without it, the scan uses the screenshot path.
  - Add `https://api.tcgdex.net/*` explicitly.
- **Store vs dev build.**
  - The store build drops the localhost dashboard host permissions and UI, test-set collection, and `importReferences`.
  - The dev build (the default for this repo's tests) keeps them.
  - The `-Store` flag on the build script produces `dist/extension-wasm-store` plus a zip.
- **Cleanup.**
  - Remove `web_accessible_resources`.
  - Move the PPT key to `storage.local`, migrating it from `sync` once.
  - Remove the `window.__cardScanner` test hook if no test needs it, otherwise gate it to the dev build.
- **Truthful copy.** The description reads: card recognition runs on your device; prices come from public APIs.
- **Name and disclaimer.** The name is "Card Scanner & Price Checker for Pokémon TCG". The options page and listing carry the disclaimer: "Not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company".

## L2 — Listing and policy assets (docs + images)

Status: docs done (5d4d99c, `docs/store/`), except hosting the privacy policy and the contact email, which the owner provides.

- `docs/store/privacy-policy.md` matches what the code actually does. It must be hosted at a public URL; the user picks where.
- `docs/store/listing.md` holds the description, single-purpose statement, permission justifications, data-use answers, and the remote-code answer.
- An original icon replaces the Poké Ball, with 96×96 artwork inside a 128 canvas, plus 48 and 16 sizes.
- Store images: up to 5 screenshots at 1280×800, taken from real-world runs, and a 440×280 promo tile.

## L3 — Real-world testing (dev data, never the sealed set)

Status: done with `scripts/realworld-run.mjs` on 28 dev pages and 30 held-out pages. Results are summarised in `HANDOFF.md`. Dev run (off mode): high rows 22 -> 3, rows with a name and a price 33 -> 89; held-out run: 0 high rows, 0 scan errors, 0 blocked pages. Known weak spots: dead listings, Japanese cards (wrong names at medium), lot photos in screenshot mode, a 50-card fan photo (0 rows), look-alike versions.

- **Pages:** about 30 public pages scanned with the store build, sequentially, at low volume, without logging in. They cover eBay search and listing pages, Mercari, HiBid, TCGplayer, Pokellector, ShopGoodwill, and PriceCharting.
- **Use cases:**
  - single-card listing
  - multi-card lot photo
  - graded slab
  - binder page
  - search-results thumbnail grid
  - modern card
  - Japanese card (should abstain)
  - card back
  - sealed product (should not detect)
- **Each page runs twice:** with and without optional site access.
- **Per page:** scan success, time, cards detected, cards identified, unsure count, priced count, console errors, and a screenshot.
- **Weak correctness check:** the identified name against the listing title.
- **Output:** results go in `data/realworld/<date>/`, which is gitignored. A summary lists the top failure modes, and each failure mode becomes a fix ticket.

## Gates before handing to the user

- `npm test` and the Python suite are green, and lint adds no new errors.
- The store build passes from a clean checkout.
- The L3 run has no crash-level failures on any site.
- Every audit blocker is closed or documented as the user's decision. Those decisions are the name, the icon, privacy-policy hosting, and the Chrome Web Store developer account.

## Remaining owner items

- Manual test of the store zip (`dist/extension-wasm-store.zip`), including the site-access permission prompt.
- Contact email for the privacy policy and listing.
- Host the privacy policy at a public URL.
- Chrome Web Store developer account.
- Approve the name and the icon.
- Push and publish (nothing is pushed).
- Deploy the relay and data repo for shared learning (`tools/shared-data/README.md`), then fill `lib/shared-config.js`.
