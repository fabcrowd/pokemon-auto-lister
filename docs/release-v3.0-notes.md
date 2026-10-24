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

### Measured

What is and is not held out. The test photos were never used to train the recognizer. But the recognizer was trained on the catalog art of every physical card, so every card in these photos was a card it had already seen as catalog art. The numbers below are "known cards in new photos", not "unseen cards". The choice of this model over the runner-up, and the confirm thresholds, were also made by looking at these same Facebook and marketplace photo sets, and one Facebook photo was viewed while choosing. Treat them as development sets, not a clean exam. The sealed test set has not been scored for this release, so there is no fully untouched number.

All counts are cards. Intervals are 95% intervals.

**Owner's saved Facebook lot photos** (5 of the 7 saved photos; 182 cards labelled out of 189 detected; the other 2 photos are lighters and were left out). "Top guess" means the right card was the first suggestion. The previous model is the v2 recognizer, tested without the shared learning bundle.

| | previous model | v3 |
|---|---|---|
| right card is the top guess (screenshot / full photo), of 182 | 28 / 31 | 145 / 154 |
| right card is in the top 5, of 182 | 33 / 37 | 166 / 165 |

Confirmation is a different comparison: the v3 recognizer with the earlier confirm rule against the same recognizer with the rule described above, over all 189 detected cards (screenshot / full photo). Confirmed cards went from 18 / 19 to 48 / 49.

Wrong confirmations in this set (labelled cards only):
- Confirmed from the picture alone: 14 right and 0 wrong (screenshot), 13 right and 0 wrong (full photo). Zero wrong of 13 or 14 is not evidence of a low error rate. With that few cards the true rate could still be about 21 to 23% (95% upper bound).
- Confirmed by the cheap-card price rule: 33 labelled cards (screenshot) and 35 (full photo), 1 wrong in each: a Frosmoth read as Froslass, shown at $0.46 and $0.88. That is about 3% wrong, with an interval of roughly 0.5 to 15%.
- Scored on a build from before the last few confirm-rule and display changes. Not re-run on the release build.

**Blind-labelled sample of marketplace photos** (125 photos from five marketplaces, about 1,530 detected cards; 88 of them labelled with high confidence by reviewers, with no second check of the labels, so only the easy, legible cards are scored):
- The top guess is right for 79 of 88 (90%, interval about 82 to 95%) and the right card is in the top 5 for 82 of 88 (93%).
- Confirmed cards rose from 341 to 477 (screenshot) and from 332 to 479 (full photo). These counts cover all detected cards, most of which have no label. They show how many more cards get a price, not how many are right.
- Of the 62 (screenshot) and 60 (full photo) labelled cards that were confirmed, 0 were wrong (95% upper bound about 5%). Of the 16 and 18 of those confirmed by the cheap-card price rule, 0 were wrong (upper bound about 17 to 19%).
- The previous model scored 64 and 68 of 88 on the top guess, but under an earlier scoring that did not treat "Basic Water Energy" and "Water Energy" as the same card. The 79 uses the newer scoring, so the pair is not a like-for-like comparison.
- Same timing caveat as above: scored before the last confirm-rule and display changes.

**Wrong names shown as confirmed, HiBid and Goodwill photos** (354 boxes from 55 listings; labels made automatically by matching boxes to catalog art, boxes 300 px and larger, shrunk to test smaller sizes). Scored with the earlier confirm rule, not the shipped one. Wrong confirmed names out of confirmed cards, at 300+ / 250 / 200 px: v3 recognizer 5 of 345 / 7 of 342 / 11 of 333; previous model 10 of 318 / 30 of 295 / 26 of 251. Cross-fitting the same data put the wrong rate at about 3 to 5% at 150 to 250 px, so the lower figures are optimistic.

**Card backs:** 135 of 153 labelled card backs recognised (88%) with 0 false alarms among 3,647 non-back boxes. The previous recognizer scored 124 of 153 (81%) with 1 false alarm.

### Limits you should know about
- **Non-English cards.** In our marketplace samples about 1 in 10 detected cards were not English (50 of 500 hand-classed boxes; 14 of the 30 Japanese boxes came from one listing, so this is not a population figure). A non-English card can be read as a similar English card and priced as English unless you catch it. In a test, 7 of those 50 boxes could have been confirmed as an English card with an English price. Nothing flags a card as non-English yet. If you see one, press "Can't price this".
- **Graded cards in slabs and sealed product** are not detected. A slabbed card is read as the card inside and shows the raw card price, not a graded price. Sealed product (boosters, boxes) can show a wrong price or none.
- **Cards that aren't in the catalog** (newer set, other language, merchandise) can be mistaken for a similar card. In a synthetic test with 979 recent cards removed from the catalog, about 5 to 8% of the removed cards were still confirmed as something else (16 to 29% of those whose name appears nowhere else in the catalog), using confirm rules close to the shipped ones. Cards worth $50 or more that aren't a very strong match are asked about for this reason. A card between $5 and $49 has no such check.
- **Cheap cards confirmed from small photos** (100 to 199 px): the price rule looks only at the best guess. If the real card is much more expensive than the one it was read as, you see a low price and are not asked.
- **Stacked or overlapping cards** with no clear boundary are not expected to be found, and a stack can still be read as one card and confirmed. In the marketplace sample they were about 10% of detected boxes (28% on Mercari).
- **"Can't price this" and your corrections.** "Can't price this" is on cards that ask you to choose. It takes the card out of the totals and the export, and the extension remembers it so a similar card isn't confirmed for you later. A card that was confirmed wrongly is fixed with "Wrong card?". "Use my corrections" is on by default and can be turned off in settings. While it is on, the extension keeps on this device only a small picture and fingerprint of each card you corrected or skipped (up to 400), and a very similar card can later be confirmed because of your correction. A mistaken click is remembered too. Clear removes all of it. Skipped cards are never sent anywhere. Corrections are sent only if you turn on shared learning, a separate setting that is off by default. The similarity cut-offs for "your correction" were set on 666 pictures and checked on the same pictures, so they are not independently tested.
- **Your work isn't kept when the popup closes.** Clicking outside the popup discards unconfirmed picks, printing choices and skips. Scan again to start over.
- Results above come from a few hundred labelled cards, not thousands. Small differences are noise and the intervals are wide.
- eBay and OfferUp blocked our test downloads, so small-crop accuracy there is not measured, and there is no eBay-specific larger-photo rule.
- Facebook's full-size photo path was not exercised in testing (the signed links can't be fetched outside your browser). Lots shot at about 960 px wide show many cards under 150 px, where most cards still ask you to choose. Check your own Facebook listing with site access allowed.
- On set-listing pages (a grid of clean card thumbnails) valuable cards still ask: with Base Set, Jungle and Fossil pages in testing, roughly 10 to 20 more tiles per page asked before the last price tweak, and about half of those no longer do.
- Prices come from TCGdex and can be up to a week old until the daily price snapshot is published. They are market estimates for Near Mint, not offers.
- The shared learning bundle built for the previous model is ignored until a bundle for v3 is published.
- If you turn on "Help improve recognition for everyone", the card pictures you share are cut from other sellers' listing photos and are kept in a public GitHub repository, with no review step, until removal is requested. See the privacy policy.
