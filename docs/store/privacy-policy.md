# Privacy Policy: Card Scanner & Price Checker for Pokémon TCG

Effective date: 2026-10-16

This extension finds Pokémon TCG cards in photos on web pages and shows their prices. This policy says what data it handles. It is short because there is little to say.

## The short version

- Card recognition runs on your device. Your full photos are never uploaded to us or to anyone else.
- We have no analytics, no ads, and no tracking.
- One optional setting, "Help improve recognition for everyone", is off until you turn it on. If you turn it on, small pictures of cards you correct or confirm, and the card you chose, are sent to a server we run. See "Shared learning" below.
- With that setting off, nothing you scan leaves your device, and everything the extension stores stays in your browser. You can delete it at any time.
- We do not sell your data.

## What stays on your device

- **Photos and screenshots.** When you press Scan, the extension reads the card photos on the current page. It may take a screenshot of the visible part of the tab. It reads them in memory to find and recognize cards. The recognition models run inside the browser.
- **Corrections.** When you pick the right card from the list the extension shows, it saves your choice. It stores the choice, a small cropped image of that card, and the page address (the site and path, without the query string or fragment). This lets the extension learn from your corrections. It is stored in the browser's IndexedDB.
- **Recent scans.** It keeps the pictures from your last two scans so the picker still works after the browser pauses the extension.
- **Card memory.** "Use my corrections" is on unless you turn it off. While it is on, the extension also stores a numeric fingerprint (an embedding) of each corrected crop, the card it had guessed that you said was wrong, and a short record of why it was confident (similarity scores, the size of the card in the photo, which kind of evidence it used, the price shown, and the model version). Earlier answers for the same card are kept for up to three changes of mind, and at most 400 corrections are kept (the oldest ones that you have not repeated or recently confirmed are removed first). All of this stays on your device in the browser's IndexedDB. The optional shared learning described below is unchanged: it stays off unless you turn it on, and it does not send this record.
- **Skipped cards.** When you press "Can't price this" on a card, it is stored on your device with your corrections: the cropped image, its fingerprint and the same short record, so a similar card is not confirmed for you later. It counts toward the same 400 limit, is removed by Clear, and is never sent anywhere, including by shared learning.
- **Settings.** Your settings and a cache of price lookups are kept in the browser's extension storage. Price lookups are cached for up to 24 hours.
- **Your API key.** If you enter a PokemonPriceTracker API key, it is stored in the browser's extension storage. It is used only to ask that service for prices.
- **Copy and download of your lot.** The popup can copy the confirmed cards (card names and prices) to your clipboard, or save them as a CSV file in your downloads folder, but only when you click Copy or Download CSV. Nothing is sent anywhere.
- **Model files.** The recognition models are downloaded once and kept in the browser's cache.

Developer builds of the extension include an optional test-photo collection feature. It is not part of the version in the Chrome Web Store.

## What leaves your device

With "Help improve recognition for everyone" off, only the following requests are made. None of them include your photos, screenshots, or crops. Shared learning, when you turn it on, adds the requests described in the next section.

| To | What is sent | Why |
|---|---|---|
| api.pokemontcg.io | A card identifier (for example a set and number) | Look up prices |
| api.tcgdex.net | A card identifier | Look up prices |
| www.pokemonpricetracker.com | A card identifier and your own API key, if you entered one | Look up condition-based prices |
| github.com and its download hosts (objects.githubusercontent.com, release-assets.githubusercontent.com) | A normal file request. No personal data is sent by us. | Download the recognition models on first run, and once a day the shared price snapshot (and the learning pack) from the public data repository. |
| images.pokemontcg.io and assets.tcgdex.net | A normal image request for a card picture | Show card thumbnails in the "which card is this?" list |
| The image address on the page you scan | A plain request with no cookies or login | Fetch a full-size copy of a photo, only if you turned on optional site access |

Like any web request, these reach servers run by others. They can see your IP address and the time of the request. They have their own privacy policies. We do not control them.

The extension does not send your browsing history anywhere.

## Shared learning (optional, off by default)

The options page has a setting called "Help improve recognition for everyone". It is off. You turn it on by clicking it, next to a one-line explanation of what it sends. When it is on:

- **What is sent.** For cards you correct with "Wrong card?" or pick from the list, and for results you confirm with "All right", the extension sends: a small cropped picture of that card only (a JPEG, about 320 pixels on its long side), where the card sits in the photo as four fractions, the card you chose, what the scanner guessed and how sure it was, the day (a date, no time), a random install id, a short code for the photo (a 64-bit hash of its pixels, which cannot be turned back into the photo), and the version codes of the recognition models and catalog.
- **What is not sent.** No page address, no site name, no full photo or screenshot, no account, no name or email, no browsing history, and no prices or API keys.
- **The install id.** A random identifier made when you turn the setting on. It is not linked to you. It lets us limit abuse and lets you ask for your contributions to be deleted. It is shown on the options page as "Your sharing id". Turning the setting off deletes it from your browser and everything still waiting to be sent.
- **Which photos.** About one photo in five is picked by its hash to be an exam photo: the scanner is checked against your confirmed answers and never learns from them. The rest teach. This split is the same for every user.
- **Where it goes.** To a small relay run by the developer (its address is the one listed in the extension's permissions), which saves each contribution in a public GitHub repository, fabcrowd/card-scanner-data. **Contributions are public and permanent in the repository's history unless removed on request**: anyone can see the card pictures and your answers. Your install id is not published as such: the relay stores only a scrambled form of it (a keyed hash), which still lets the developer find your files when you send the id with a deletion request. The developer also publishes a combined, signed set of card fingerprints that the extension may download.
- **What comes back.** The extension checks once a day for a signed update of those combined fingerprints and downloads it from the developer's GitHub releases. That request carries no data about you. The extension uses it only if the signature is valid, it was made for the same models, and it scored better than the previous one on the exam photos.
- **Retention.** Contributions stay in the public repository, and in its history, indefinitely unless you ask for them to be deleted. Turning the setting off stops new ones and deletes the ones not yet sent, but does not remove ones already received.
- **IP addresses.** The relay briefly keeps IP-based counters (for about an hour, and a day for a daily card count) to limit abuse. The IP address is not saved with contributions and is not published.

## Optional site access

The extension asks to read all sites only if you turn on "Read full-size photos on sites you scan", in the options or from the notice the popup can show after a scan that used a screenshot. The notice has an "Allow" button and a "Not now" link, and if you pick "Not now" it does not appear again for 14 days (the date is kept in the extension's local storage). It uses this to fetch full-size photos from the page you scan, for better accuracy. Without it, the extension uses a screenshot of the visible tab. You can turn it off at any time in your browser's extension settings.

## What we do not do

- We run a server that receives data only if you turn on shared learning, and then only what that section lists.
- We do not use analytics, advertising, or tracking.
- We do not sell your data.
- We do not share your data with third parties, except for the requests listed above that you trigger by using the extension, and the shared-learning contributions you chose to send to our own server.
- We do not use your data for anything other than the single purpose of recognizing cards and showing prices.
- We do not use or transfer data to determine creditworthiness or for lending.
- Humans do not read your data. With shared learning off we have no access to it. With it on, the developer can see the contributions on the server; they hold the crops and answers listed above and nothing that names you.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. We use data only to provide the single purpose described above.

## Deleting your data

- **Corrections, saved crops, and card memory:** Open the extension's options page and press Clear in the corrections section. You can press Export first to keep a copy. The pictures of your last two scans are replaced by newer scans, and removed when you uninstall.
- **Shared learning:** Turn the setting off in the options page. That deletes your install id and anything not yet sent. Contributions already received stay public until you ask for their deletion: send your sharing id (shown on the options page, with a Copy button, while the setting is on) in a GitHub issue on fabcrowd/card-scanner-data or to the contact email below. Copy the id before you turn the setting off, because turning it off deletes it from your browser. We then remove the matching files from the repository and its history.
- **API key:** Open the options page and press Disconnect.
- **Everything:** Remove the extension in `chrome://extensions`. Chrome deletes its storage, including IndexedDB and the cached models.

## Children

The extension is not directed at children under 13 and does not knowingly collect their data.

## Changes

If this policy changes, we will update the effective date above.

## Contact

fabcrowd@gmail.com

## Not affiliated

This extension is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company. Pokémon and related names are trademarks of their owners. They are used here only to describe what the extension works with.
