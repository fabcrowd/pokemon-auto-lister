# Known limits and open decisions (owner's page)

One line each. "Where" says where to look or change it.

## Limits of the product
- **Non-English cards can be priced as English.** About 1 in 10 detected cards in our marketplace samples; 7 of 50 foreign boxes could confirm. No flag exists; the only remedy is the user pressing "Can't price this". Where: `card-scanner-data/data/reports/foreign/README.md` (sections 1, 5 and 6, which propose a flag plus a confirm gate, not built); `docs/release-v3.0-notes.md` Limits. Decision: build the flag/gate or keep the disclosure only.
- **Slabs and sealed product are not detected.** A slab shows the raw card price. Where: `docs/team-goals.md` G10; release notes Limits.
- **Cards missing from the catalog false-confirm.** 5-8% of absent cards (16-29% of those with an unseen name) in a synthetic test; cards at $50+ get an extra check, $5-$49 do not. Where: `card-scanner-data/data/reports/fusion-study-E/floor/README.md` s3(a), s5; `tools/extension-wasm/lib/fusion.js`, `lib/stakes.js`.
- **Cheap-card promotion looks at the top guess only.** A $100 card read as a $0.30 look-alike is confirmed cheap. Where: `lib/stakes.js:37`.
- **High-tier confirm cut-offs (0.82 / 0.025) were fitted on an older model.** Not refit for the v3 recognizer. Where: `lib/fusion.js`, `tools/shared-data/pins.json` `highTier`.
- **Popup state is lost when the popup closes.** Unconfirmed picks, printing choices and skips are not saved; skipped cards return as "Choose" on rescan. Where: `popup.js` (in-memory `_lastResult`), `docs/team-goals.md` G5.
- **Stacked cards** may be read as one card and confirmed. Where: release notes Limits.
- **eBay and OfferUp accuracy is unmeasured** (downloads blocked); no eBay larger-photo rule. Where: release notes Limits.
- **Corrections memory cut-offs were set and checked on the same 666 pictures**, and a mistaken click is remembered. Where: `lib/reference-bars.js`, `card-scanner-data/data/reports/g12/measurements.md`. "Use my corrections" is on by default (`background.js` `useReferences !== false`).

## Evidence gaps
- **No untouched score.** The Facebook and marketplace sets were used to choose the model and confirm rows; the sealed set has not been scored for this release (`node scripts/sealed-score.mjs`, only when you ask). Where: release notes Measured.
- **Release-build figures are stale.** Facebook and marketplace confirm numbers come from an earlier build; cross-source numbers use the earlier confirm rule. Rerun on the release commit. Where: `.tmp/gate2/score4-tables.md`, `card-scanner-data/data/reports/cross-source`.
- **Real-Chrome check outstanding.** The Facebook full-size photo path has only been tested with a stand-in. Where: `docs/publish-v3.0.md` ("Real Chrome check on your PC").

## Privacy and store submission
- **Privacy-policy URL is a placeholder (TODO-OWNER).** Host `docs/store/privacy-policy.md` at a public https URL, paste it into `docs/store/listing.md`, and link it from the options page. The store requires it.
- **The relay is public and unmoderated.** Anyone who can forge an Origin header can post JPEGs into a public, permanent GitHub repository; there is no review or takedown process beyond emailing a sharing id. Shared crops come from third-party sellers' listing photos. Decision: private inbox branch or a review gate. Where: `tools/relay/src/handler.js`, `validate.js`; policy "Shared learning".
- **Relay token and branch protection are unverified.** Confirm `main` protection and the `pack-signing` environment on `fabcrowd/card-scanner-data`.
- **Price snapshot is unsigned** (the learning pack is signed). Where: `lib/price-snapshot.js`.
- **Build and publish steps not done:** release v3.0 asset upload, `pins.json` update in the data repo, and a rebuild with `-Store` at the release commit. Where: `docs/publish-v3.0.md`.
