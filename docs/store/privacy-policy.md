# Privacy Policy: Card Scanner & Price Checker for Pokémon TCG

Effective date: 2026-10-16

This extension finds Pokémon TCG cards in photos on web pages and shows their prices. This policy says what data it handles. It is short because there is little to say.

## The short version

- Card recognition runs on your device. Your photos are not uploaded to us or to anyone else.
- We run no servers. We have no analytics, no ads, and no tracking.
- We do not collect, sell, or share your data.
- Everything the extension stores stays in your browser. You can delete it at any time.

## What stays on your device

- **Photos and screenshots.** When you press Scan, the extension reads the card photos on the current page. It may take a screenshot of the visible part of the tab. It reads them in memory to find and recognize cards. The recognition models run inside the browser.
- **Corrections.** When you pick the right card from the list the extension shows, it saves your choice. It stores the choice, a small cropped image of that card, and the page address (the site and path, without the query string or fragment). This lets the extension learn from your corrections. It is stored in the browser's IndexedDB.
- **Recent scans.** It keeps the pictures from your last two scans so the picker still works after the browser pauses the extension.
- **Card memory.** If you turn on "Recognize cards I corrected before", it also stores a numeric fingerprint (an embedding) of each corrected crop.
- **Settings.** Your settings and a cache of price lookups are kept in the browser's extension storage. Price lookups are cached for up to 24 hours.
- **Your API key.** If you enter a PokemonPriceTracker API key, it is stored in the browser's extension storage. It is used only to ask that service for prices.
- **Model files.** The recognition models are downloaded once and kept in the browser's cache.

Developer builds of the extension include an optional test-photo collection feature. It is not part of the version in the Chrome Web Store.

## What leaves your device

Only the following requests are made. None of them include your photos, screenshots, or crops.

| To | What is sent | Why |
|---|---|---|
| api.pokemontcg.io | A card identifier (for example a set and number) | Look up prices |
| api.tcgdex.net | A card identifier | Look up prices |
| www.pokemonpricetracker.com | A card identifier and your own API key, if you entered one | Look up condition-based prices |
| github.com and its download hosts (objects.githubusercontent.com, release-assets.githubusercontent.com) | A normal file request. No personal data is sent by us. | Download the recognition models on first run, about 140 MB. Each file is checked against a fixed SHA-256 hash. |
| images.pokemontcg.io and assets.tcgdex.net | A normal image request for a card picture | Show card thumbnails in the "which card is this?" list |
| The image address on the page you scan | A plain request with no cookies or login | Fetch a full-size copy of a photo, only if you turned on optional site access |

Like any web request, these reach servers run by others. They can see your IP address and the time of the request. They have their own privacy policies. We do not control them.

The extension does not send your browsing history anywhere.

## Optional site access

The extension asks to read all sites only if you turn on "Read full-size photos on sites you scan". It uses this to fetch full-size photos from the page you scan, for better accuracy. Without it, the extension uses a screenshot of the visible tab. You can turn it off at any time in your browser's extension settings.

## What we do not do

- We do not run servers that receive your data.
- We do not use analytics, advertising, or tracking.
- We do not sell your data.
- We do not share your data with third parties, except for the requests listed above that you trigger by using the extension.
- We do not use your data for anything other than the single purpose of recognizing cards and showing prices.
- We do not use or transfer data to determine creditworthiness or for lending.
- Humans do not read your data. We have no access to it.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. We use data only to provide the single purpose described above.

## Deleting your data

- **Corrections, saved crops, and card memory:** Open the extension's options page and press Clear in the corrections section. You can press Export first to keep a copy. The pictures of your last two scans are replaced by newer scans, and removed when you uninstall.
- **API key:** Open the options page and press Disconnect.
- **Everything:** Remove the extension in `chrome://extensions`. Chrome deletes its storage, including IndexedDB and the cached models.

## Children

The extension is not directed at children under 13 and does not knowingly collect their data.

## Changes

If this policy changes, we will update the effective date above.

## Contact

[contact email]

## Not affiliated

This extension is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company. Pokémon and related names are trademarks of their owners. They are used here only to describe what the extension works with.
