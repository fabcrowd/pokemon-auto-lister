# QA smoke report

Pokémon Card Scanner, working tree `pokemon-auto-lister`. Product code was not changed. No commit, revert, or stash. Models were not downloaded. No live marketplace scan.

## Build under test

| Item | Value |
| --- | --- |
| Commit | `48e2b76230ae16beb0a845306ec1c0bb872cf933` (`48e2b76` Docs: record the extension accuracy pass…) |
| Dirty | Dirty. `git status -sb` at audit start: `## main...origin/main` with modifications to `HANDOFF.md`, `README.md`, `docs/store/listing.md`, `docs/store/privacy-policy.md`, `scripts/lib/store-package.mjs`, `tasks/lessons.md`, `tasks/todo.md`, `tests/condition-pricing.test.js`, `tests/content-pure.test.js`, `tests/e2e/extension-wasm-popup.spec.js`, two e2e screenshots, `tests/store-build.test.js`, `tests/store-transform.test.js`, `tools/extension-wasm/background.js`, `content.js`, `lib/condition-pricing.js`, `lib/pricing.js`, `lib/shared-config.js`, `options.js`, `popup.html`, `popup.js`, plus untracked `tests/e2e/screenshots/ext-wasm-popup-ask.png`, `tests/price-snapshot.test.js`, `tools/extension-wasm/lib/price-snapshot.js`, shared-data price files, and `tools/vellum-ai/models/card_detect_v7/`. Audit screenshots under `tasks/qa-smoke/` were added after that status. |
| OS | Windows 10.0.26100 |
| Playwright | 1.63.0 |
| Chromium | 153.0.8010.12, headed |
| Extension loaded | `C:\Users\daroo\Desktop\Repos\cardscanner\pokemon-auto-lister\tools\extension-wasm` |
| Why that path | Source and `dist/extension-wasm` copies of `popup.js`, `popup.html`, `content.js`, `options.js`, `options.html`, and `background.js` share the same size and last-write time (`content.js` 2026-10-18 22:13:42, 44416 bytes). Source booted, so dist was not loaded. |
| Extension id | `glelmmehhcnicljmgmhkaddndalaeelg` |
| Manifest | Pokémon Card Scanner 2.1.0 |

Screenshots: `tasks/qa-smoke/`. Console listeners were attached before each navigation, on the page and on the service worker.

## Flows

| Flow | Result | Screenshot |
| --- | --- | --- |
| Popup initial paint at 420×640 | pass | `popup-empty.png` |
| Setup wizard step 1 when models are absent; SCAN PAGE disabled | pass | `popup-empty.png` |
| CLEAR while the wizard covers it | blocked | `popup-clear-while-wizard.png` |
| Wizard Not now (`#btn-wiz-access-skip`) | blocked | `popup-wizard-after-ready-stub.png` |
| Wizard “I’ll do this later” with no API key and no model download | pass | `popup-wizard-step2.png`, `popup-wizard-later.png` |
| Era picker: choose 1999–2003, value sticks in storage and after reload | pass | `popup-era-open.png`, `popup-era-selected.png`, `popup-era-after-reload.png` |
| CLEAR on the empty state | pass | `popup-clear-empty.png` |
| Results without a live scan: priced, no price, unsure, list scrolls | pass | `popup-results.png`, `popup-results-scrolled.png` |
| Hover a result row (sends highlight) | pass | `popup-row-hover.png` |
| Exam dismiss | pass | `popup-exam-strip.png` |
| Exam All right | pass (handled message, no throw) | `popup-exam-yes.png` |
| CLEAR restores the empty hint | pass | `popup-cleared.png` |
| Post-scan access notice, Not now | pass | `popup-access-notice.png`, `popup-access-skipped.png` |
| Gear opens Settings | pass | `options-initial.png` |
| Options 1100×800, no horizontal overflow | pass | `options-initial.png` |
| Options 480×700, no horizontal overflow | pass | `options-480.png`, `options-480-viewport.png` |
| Condition LP, PSA on then off | pass | `options-psa-on.png`, `options-psa-off.png` |
| Site-access toggle off | pass | `options-site-access.png` |
| Save and test with an empty key | pass | `options-empty-key.png` |
| Reduce look-alikes on then off | pass | `options-lookalikes.png` |
| Share opt-in on | pass | `options-share-on.png` |
| Advanced local dashboard, nothing on :3000 | pass | `options-dashboard.png` |
| Corrections and test-photo counts; Export not run because it is disabled at zero; Clear not clicked | pass | `options-corrections.png` |
| Overlay three cards, real `content.js` `showOverlay` | pass | `overlay-three-cards.png` |
| Overlay corners follow resize | pass | `overlay-after-resize.png` |
| Overlay corners and highlight label stay with the cards on scroll | pass | `overlay-after-scroll.png` |
| highlightCard | pass | `overlay-highlight.png`, `overlay-labels.png` |
| clearOverlay | pass | `overlay-cleared.png` |
| hideOverlay then restoreOverlay | pass | `overlay-hidden.png`, `overlay-restored.png` |
| Card under 140px: corners sit on the card; label is not price-only and is not clamped | fail | `overlay-narrow.png`, `overlay-narrow-highlight.png` |
| Card 200px wide (over 140): long label leaves the card | fail | `overlay-wide-hover.png`, `overlay-wide-highlight.png` |
| Live page scan | blocked | none |
| Wizard Allow, and post-scan Allow | not clicked | none |

Popup overflow at 420×640: `scrollWidth` 420, `clientWidth` 420. Options at 1100×800: `scrollWidth` 1085, `clientWidth` 1085 (scrollbar). Options at 480×700: `scrollWidth` 465, `clientWidth` 465. No horizontal overflow on those three viewports.

## What the screenshots show

**Popup.** With no models, the setup overlay is visible and `#btn-scan` is disabled. Those match. Logo reads CARD SCANNER, button reads SCAN PAGE, step 1 reads “Download the AI models” and “about 140 MB”. There is no Skip on step 1. Download was not clicked.

After the test told only the popup that models were ready (so the later wizard steps could be reached without a download), the price-key step appeared. “I’ll do this later” hid the wizard and did not throw. The access step did not appear: this unpacked manifest already has `<all_urls>` in `host_permissions`, so the optional-access step is skipped. `#btn-wiz-access-skip` is in the page and was not shown.

The closed era control is 96px wide and shows `1999-2003 ·`. The full option is `1999–2003 · Base Set to e-Card`. The year range is readable, the stored value is `wotc`, and it is still `wotc` after reload. The open native menu is not inside the page bitmap (`popup-era-open.png` shows the focused closed control).

Injected scan response, rendered by the real popup click handler: Charizard `$420.00`, Blastoise `—`, Zapdos unsure with “WHICH CARD IS THIS?”, best guess, and a second choice. Status: “Found 11 cards: 10 identified, 1 needs your pick.” Estimate `$476.00`. The list scrolls (`scrollHeight` 830, `clientHeight` 460). Hovering the first row sent `{ action: "highlightCard", index: 0, scroll: false }`. CLEAR removed the rows and brought the empty hint back.

Exam “All right” showed the red status “Couldn't send that. Try again later.” and left the strip up. No page error. That is the popup’s catch when `confirmExam` returns not ok. Sharing was still off, and the scan id `qa-scan` was never stored by the background. Not filed.

The post-scan notice was shown only after `chrome.permissions.contains(<all_urls>)` was forced false for that click. Copy: “Allow reading full-size photos on sites you scan — finds more cards in lots and binders.” Not now hid it and did not throw. Allow was not clicked, because it calls `chrome.permissions.request`.

**Options.** Initial page matches the settings layout: pokemontcg.io Always on, PokemonPriceTracker Not connected, condition Near Mint, graders off, full-size photos On, look-alikes off, dashboard collapsed as Not detected, share off, “Corrections: 0 saved”, “0 references”, “Test photos: 0 saved (about 0 MB)”. Export and Clear are disabled at zero. Clear was not clicked.

Empty key: red “Paste a key first.” LP is stored. PSA checked on, then off, and storage ends with PSA false and raw LP true. Turning site access off left it On, with “Chrome would not remove it here. You can remove it in chrome://extensions under Details, Site access.” That is the path for a manifest host permission. No permission prompt appeared. Look-alikes toggled on (“Scans will steer away from look-alike cards.”) and back off. Share turned on: “On. Thank you.” plus a sharing id and Copy. Dashboard opened: status Not detected, body “Not reachable. If you installed the dashboard, make sure `npm start` is running and `JUSTTCG_API_KEY` is set in your `.env`.” No page error.

**Overlay.** Real `content.js` was injected with `chrome.scripting.executeScript`. `findCards` saw the three images. `showOverlay` used viewport boxes and the page’s `innerWidth` / `innerHeight`.

Without a pointer, three corner frames sit on the magenta image edges: green (high), amber (medium), dashed gray (abstain). Labels are not drawn until hover or highlight. On a short name, the highlight label “Blastoise / $18.00” sits inside the card, and it stays at the top of that card after a viewport change from 1280×800 to 1000×700 and after a 220px scroll. `clearOverlay` removes the canvas. `hideOverlay` sets visibility to hidden (corners gone, response `{ hidden: true }`). `restoreOverlay` shows the corners again.

The narrow card’s corners also sit on the 110×154 image (green bounds within 1px of the element). The label does not.

## Console

No uncaught page errors on popup, options, the service worker, or the fixture.

**Popup** `chrome-extension://glelmmehhcnicljmgmhkaddndalaeelg/popup.html`

- error: `[prices] snapshot not updated: price snapshot answered 404`
- location: `lib/price-snapshot.js` line 131

**Service worker** `chrome-extension://glelmmehhcnicljmgmhkaddndalaeelg/background.js`

- error: `[prices] snapshot not updated: price snapshot answered 404`
- location: `lib/price-snapshot.js` line 131

The client fetches `https://github.com/fabcrowd/card-scanner-data/releases/download/prices/prices.json`, catches a non-OK response, and logs that line. The popup still painted and the injected prices still rendered. This is the remote `prices` release answering 404, not a missing model file. Filed as QA-2 because it is a console error on popup open.

**Options** `chrome-extension://glelmmehhcnicljmgmhkaddndalaeelg/options.html`

- error: `Failed to load resource: net::ERR_CONNECTION_REFUSED`
- location: `http://127.0.0.1:3000/api/health`

`probeBackend` fetches that health URL and catches the refusal. Nothing is listening on port 3000. The on-page copy is the Not detected text above. No page error. Not filed. The dashboard check the brief asked for is a pass.

**Fixture** `http://127.0.0.1:8766/`

- warning: `Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true.`

That readback is the audit script sampling the canvas. `content.js` does not call `getImageData`. Not a product warning.

## Defects

### QA-1 — Overlay label leaves the card

**Severity:** major

**Steps:**

1. Load `tools/extension-wasm` unpacked.
2. Open a local page with card-shaped images.
3. Inject `tools/extension-wasm/content.js`.
4. Send `showOverlay` with a high-confidence card whose `display.price` is `420.5` and whose name is `Charizard VMAX Rainbow Rare`. Box matches the image.
5. Hover the image, then send `highlightCard` for that index.

**Expected:** The label stays on the card. Under 140px wide, a price-only or clamped label is the intended behavior.

**Actual:** Both widths draw the full name and the price, and the pill runs past the right edge.

- 200px card (over 140): the pill covers the right border and overlaps the next card. `overlay-wide-hover.png`, `overlay-wide-highlight.png`.
- 110px card (under 140): same two-line pill, not price-only, about 40px past the card (measured label width 143px on a 110px card). `overlay-narrow.png`, `overlay-narrow-highlight.png`.

Corner brackets on these same cards line up with the image edge. A short name (“Blastoise”, `$18.00`) does fit inside a card about 220px wide (`overlay-labels.png`).

**Console:** none for this flow.

### QA-2 — Price snapshot 404 is logged on popup open

**Severity:** minor

**Steps:** Open `popup.html` in a fresh profile. Do not scan.

**Expected:** A missing remote price file does not log an error when the popup itself has opened.

**Actual:** Popup and the service worker each log `console.error`:

`[prices] snapshot not updated: price snapshot answered 404`

Source: `lib/price-snapshot.js` line 131. URL in `lib/shared-config.js`: `https://github.com/fabcrowd/card-scanner-data/releases/download/prices/prices.json`. The wizard still showed and SCAN PAGE stayed disabled, so this did not break the popup. Screenshot of that screen: `popup-empty.png`.

## Not tested, and the blocker

- **Live scan.** Models are not ready. Step 1’s only action is Download models (about 140 MB). That button was not clicked. SCAN PAGE stays disabled until models are ready.
- **Wizard “Not now” (`#btn-wiz-access-skip`).** The control exists. The access step never became the visible step. With models reported ready, onboarding still on step 1, and `<all_urls>` already granted by the manifest, the wizard went straight to the price-key step.
- **Wizard Allow and the post-scan Allow.** Both call `chrome.permissions.request`. Not clicked, so a browser permission prompt would not be left on screen.
- **Turning site access on.** It was already On. The off toggle was the one clicked. Chrome did not remove the manifest host permission.
- **Export of corrections and test photos.** Both buttons are disabled at “0 saved”. They were not forced. Clear was not clicked.
- **Recognition accuracy and marketplace pages.** Out of scope. `data/sealed-test` was not read.

Results in the popup were produced by stubbing the `scanPage` reply and clicking SCAN PAGE, so `popup.js` rendered them. They are not a camera or page scan. The overlay messages were the real `chrome.tabs.sendMessage` calls: `showOverlay`, `highlightCard`, `clearOverlay`, `hideOverlay`, `restoreOverlay`, `findCards`.

## Ship call

**Ship with fixes.**

Popup, settings, and the overlay frames behaved as exercised: wizard matches the disabled scan button, era choice sticks, empty CLEAR is quiet, injected rows scroll and clear, empty-key validation is the red “Paste a key first.” line, and corner boxes follow resize and scroll. QA-1 is visible on the page overlay for a normal long card name, including a card wider than 140px, so this tree should not ship until that label stays on the card.
