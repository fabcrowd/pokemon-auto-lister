# Chrome Web Store listing

## Name

Card Scanner & Price Checker for Pokémon TCG

## Short description (max 132 characters)

Find Pokémon cards in photos on the page you are viewing and see their prices. Card recognition runs on your device.

(116 characters)

## Full description

Card Scanner & Price Checker for Pokémon TCG finds Pokémon cards in the photos on a web page and shows what each one is and what it sells for.

How to use it
1. Open a page with card photos, such as a listing, a lot, or a binder page.
2. Click the toolbar icon.
3. Press Scan.

The extension marks each card it finds and shows its name, set, number, and price. When it is not sure which card it is, it shows a few close matches and asks you to pick. It remembers your choice.

What you get
- Single cards, lots of several cards, and photos of binder pages.
- Prices from public sources. You can add your own price-service API key for condition-based prices.
- A short list of likely matches when a card is unclear, with pictures.
- Export or clear your saved corrections at any time.

Privacy
- Card recognition runs on your device. Your full photos are never uploaded.
- No account. No analytics. No ads.
- Optional and off by default: "Help improve recognition for everyone" sends small pictures of cards you correct or confirm, and the card you chose. No page address, no full photo, no account.
- Only card identifiers are sent to the price sources.
- The first run downloads about 140 MB of recognition models. After that, scanning works without a download.

Optional site access
By default the extension scans a screenshot of the visible page. If you turn on "Read full-size photos on sites you scan", it can read the full-size photo for better accuracy. It asks for this permission only when you turn it on, either in the extension options or from the notice the popup can show after a scan that used a screenshot.

Prices are estimates from public sources. They are not offers or guarantees.

Not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company. Pokémon is a trademark of its owners and is used here only to describe the cards this extension works with.

## Category

Suggested: Shopping. Alternative: Tools.

## Single purpose

Find Pokémon trading cards in photos on the page the user is viewing, identify them on the device, and show their market prices.

## Permission justifications

**activeTab**
Lets the extension read the tab you are on when you click the toolbar icon and press Scan. It is used to take a screenshot of the visible page and to show the card markers on it. It does nothing until you click.

**scripting**
Used to add the card markers and the "which card is this?" picker to the page you chose to scan. The script is injected only after you press Scan. All scripts are packaged with the extension.

**storage**
Stores your settings, an optional PokemonPriceTracker API key, and a 24-hour cache of price lookups. Saved corrections and their crops use the browser's IndexedDB. Nothing is sent to us unless you turn on "Help improve recognition for everyone".

**Optional host access: all sites (`<all_urls>`)**
Read full-size photos on sites you scan, for better accuracy. It is requested only when you turn it on, in the options or from the optional notice in the popup. Without it, the extension uses a screenshot of the visible tab. Photos are fetched without cookies and are analyzed on the device.

**api.pokemontcg.io**
Look up card prices by card identifier.

**api.tcgdex.net**
Look up card prices by card identifier.

**www.pokemonpricetracker.com**
Look up condition-based prices by card identifier, using the API key you entered. Used only if you add a key.

**The developer's relay address (added to the store build only when the owner sets it)**
Receives the opt-in contributions of "Help improve recognition for everyone" and serves the signed update of combined card fingerprints. It is requested only in a build where the owner set the address, and nothing is sent to it unless the user turned the setting on.

**github.com/fabcrowd/pokemon-auto-lister/releases/download/*, objects.githubusercontent.com, release-assets.githubusercontent.com**
Download the recognition models and lookup data on first run (about 140 MB). They are published as GitHub release files. GitHub redirects the download to its file hosts. Each file is checked against a fixed SHA-256 hash.

**github.com/fabcrowd/card-scanner-data/releases/***
Once a day, the shared TCGPlayer price snapshot, and the signed learning pack when shared learning is on. The request is for a public file. Nothing about you is sent.

## Data usage (Privacy practices tab)

Collected, in the store's wording:

- **Website content.** Yes. Card photos and page images from the page you scan. Processed on the device and not transmitted off the device. Crops of cards you correct are stored locally.
- **Web history.** Yes, locally only. For each saved correction the extension stores the page address without the query string or fragment (site and path). It is not transmitted.
- **Website content, only if the user turns on "Help improve recognition for everyone" (off by default, explicit click, explained next to the toggle).** Small cropped pictures of cards the user corrected or confirmed (card only, about 320 px), where the card sits in the photo, the card chosen, the scanner's guess, a date, a random install id, a hash of the photo, and model version codes. Transmitted to the developer's relay, which saves it in a public GitHub repository (fabcrowd/card-scanner-data), where it is publicly visible and kept until deletion is requested by install id. No page address, no full photo, no account. Not sold, not used for anything else. Turning the setting off deletes the install id and the unsent queue.
- **User activity (corrections and confirmations).** The same opt-in contributions: which card the user picked or confirmed for a crop. Tick the matching boxes in the store form for the opt-in data above.
- **Authentication information.** Yes. The PokemonPriceTracker API key that the user enters. It is stored in the browser and sent only to www.pokemonpricetracker.com.

Not collected: personally identifiable information, health, financial or payment information, location, keystrokes or clicks, personal communications. The install id is random and not linked to a person.

Certifications to tick:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: [hosted URL of privacy-policy.md, chosen by the owner]

## Remote code

Does the extension execute remote code? **No.** All JavaScript and WebAssembly is packaged in the extension. The downloads are model weights and lookup data, pinned by SHA-256, and are never run as code.

## Disclaimer

Not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company.

## Images

- Icon: `tools/extension-wasm/icons/icon128.png` (source: `docs/store/icon.svg`, render with `node scripts/render-icons.mjs`).
- Small promo tile (440x280): `docs/store/promo-small-440x280.png`.
- Screenshots (1280x800, up to 5): to be captured from real runs (work package L3).
