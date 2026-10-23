## Recognizer v3: better at small, blurry cards

`clip_visual_int8.onnx` (88,999,043 bytes, sha256 `d15ade1768efb9c395d39fe0f4b513e06ce503116d01a28d7cf2833e5f811e6c`).

The model that reads a photo was retrained to cope with the small, compressed card crops that Marketplace, eBay and similar listings produce. The card catalog is unchanged. Builds of the extension that point at v3.0 download only this one file; the catalog, card finder and other files stay cached, and the old recognizer is removed only after the new file passes its hash check.

### Measured
Held-out Facebook Marketplace lot photos (182 cards, one run, small sample). Top-1 means the right card was the first guess. "Previous model" is the old recognizer measured without the shared learning adapter, so the comparison is model against model:

| | previous model | v3 |
|---|---|---|
| right card is the top guess (screenshot / full photo) | 28 / 31 | 127 / 131 |
| shown as sure, right / wrong | 16 / 0 | 16 / 1 |

Held-out HiBid and Goodwill photos with geometry-verified labels (wrong names shown as sure, lower is better):

| crop height | previous model | v3 |
|---|---|---|
| 300 px and up | 10 | 3 |
| 250 px | 30 | 5 |
| 200 px | 26 | 11 |

Card-back detection was re-fitted for v3: on held-out photos it finds 91.5% of card backs with no false positives.

### Known limits
- Cards under about 150 px are shown as guesses with a pick list, not as sure matches. This release raises how often the right card is the first guess or in the top 5; it does not make tiny crops certain.
- The small-crop numbers come from a small set of Facebook photos. Results on other sites' small crops are not yet measured.
- The shared learning bundle built for the previous model is ignored until a bundle for v3 is published.
