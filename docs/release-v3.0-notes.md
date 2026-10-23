## v3.0: reads small, blurry listing photos, and asks you when it isn't sure

`clip_visual_int8.onnx` (88,999,043 bytes, sha256 `0dba1302580da2a629936be835b765d6dba9019e677284257470d30070d9d52b`).

The recognizer was retrained on the whole catalog art plus real marketplace crops so it can read the small, compressed cards in lot photos from Marketplace, eBay-style listings, Mercari, HiBid, Craigslist, Poshmark and similar sites. The extension now behaves like a scanner: a card is either confirmed (name and price) or you are asked to choose, by tapping the image of the card it most likely is. A price is never guessed for a card that isn't confirmed.

Upgrading from v2: the setup screen appears once and downloads only the recognizer (about 89 MB). The catalog and other files stay cached, and the old recognizer is removed only after the new file passes its hash check.

### What changed
- **Choose by image.** An unsure card shows your crop beside the closest card images (art, name, set, number), best match highlighted, one tap to confirm. Printing, version and finish choices are image strips and one-tap chips (each finish chip shows its price). "Review all" lets you check many cards side by side and confirm them together.
- **Confirmation depends on size and price.** Under 200 px a card is never confirmed from the picture alone. From 200 px up it is confirmed when the match is strong and clearly ahead of the nearest different card. Between 100 and 199 px a card is confirmed only when its price is $5 or less (a mistake costs cents). A card worth $50 or more that is not a very strong match is asked about instead of confirmed.
- **Bigger photos.** On Mercari, HiBid, ShopGoodwill, Craigslist and Poshmark the extension asks for the site's largest version of a listing photo (checked live on all five). Facebook's full-size original is used as before when site access is allowed.
- **Pricing.** No price for a card that isn't confirmed. If the printing is open you see a price range until you pick the printing. Old prices (older than 30 days) are flagged and kept out of totals.
- Smaller fixes: Clear resets everything, ShopGoodwill photos are readable, tag text no longer truncates, plain wording throughout.

### Measured (held-out photos, same method for each comparison)
Owner's saved Facebook lot photos (182 labelled cards). "Top guess" means the right card was the first suggestion:

| | previous model | v3 |
|---|---|---|
| right card is the top guess (screenshot / full photo) | 28 / 31 | 145 / 154 |
| right card is in the top 5 | 33 / 37 | 166 / 165 |
| cards confirmed (previous build with the earlier rule → v3) | 18 / 19 | 48 / 49 |
| confirmed but wrong (picture-confirmed) | 1 / 1 | 0 / 0 |

Of the 34 and 36 cheap cards confirmed by the price rule, 1 was wrong each time (a Frosmoth read as Froslass, shown at $0.46 and $0.88).

Blind-labelled sample of 125 photos from five marketplaces (88 cards labelled with high confidence):
- The top guess is right for 79 of 88 (90%) and the right card is in the top 5 for 82 (93%). The previous model scored 64 and 68 of 88 under the earlier scoring, which did not treat "Basic Water Energy" and "Water Energy" as the same card.
- Cards confirmed rose from 341 to 477 (screenshot) and from 332 to 479 (full photo). Of the 16 and 18 confirmed cards that could be checked against labels, none were wrong.

Held-out HiBid and Goodwill photos with geometry-verified labels, wrong names shown as confirmed (lower is better), measured with the earlier confirm rule: 5 / 7 / 11 at 300+ / 250 / 200 px, against 10 / 30 / 26 for the previous model.

Card backs: on 153 held-out card backs, 88% are recognised with no false alarms.

### Limits you should know about
- Results above come from a few hundred labelled cards, not thousands. Small differences are noise.
- Stacked or overlapping cards with no clear boundary are not expected to be found.
- eBay and OfferUp blocked our test downloads, so small-crop accuracy there is not measured, and there is no eBay-specific larger-photo rule.
- Facebook's full-size photo path was not exercised in testing (the signed links can't be fetched outside your browser). Lots shot at about 960 px wide show many cards under 150 px, where most cards still ask you to choose. Check your own Facebook listing with site access allowed.
- On set-listing pages (a grid of clean card thumbnails) valuable cards still ask: with Base Set, Jungle and Fossil pages in testing, roughly 10 to 20 more tiles per page asked before the last price tweak, and about half of those no longer do.
- Prices come from TCGdex and can be up to a week old until the daily price snapshot is published.
- The shared learning bundle built for the previous model is ignored until a bundle for v3 is published.
- A card that isn't in the catalog (newer set, other language, merchandise) can still be mistaken for a similar card at moderate confidence. Cards worth $50 or more that aren't a very strong match are asked about for this reason.
