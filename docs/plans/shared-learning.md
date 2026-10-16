# Shared learning

Status: implemented in the extension (client side). The relay and the data pipeline are built elsewhere (`tools/relay/`, `tools/shared-data/`) and must match the contracts here.

Users who opt in help every user: the corrections and confirmations they make become a shared set of card fingerprints. A held-out slice of photos decides, with numbers, whether a new set is allowed to ship.

## Owner checklist

Fill these in `tools/extension-wasm/lib/shared-config.js`. Each empty string keeps its feature off.

| Constant | Meaning |
|---|---|
| `RELAY_URL` | https address that receives contributions (POST). Empty: the options toggle reads "Not available in this build" and nothing is queued or sent. |
| `PACK_MANIFEST_URL` | https address of the pack `manifest.json`. `manifest.sig` must sit in the same directory. Empty: no pack is fetched. |
| `PACK_PUBLIC_KEY` | The pack signing key: ECDSA P-256 public key, SPKI DER, base64. Empty: no pack is trusted. |

The store build (`scripts/lib/store-package.mjs`) adds the origin of each non-empty https address to `host_permissions`. It stops if an address is not https. With all three empty the store manifest is unchanged.

## Flow

1. Each photo scanned gets `photoId`, a 64-bit difference hash (dHash, 9x8 grid of average luma, 16 hex digits). The grid averages every source pixel, so the same picture hashes the same at any size. Code: `lib/photo-id.js` (`scripts/lib/dhash.mjs` re-exports the same function).
2. `split = parseInt(photoId.slice(-8), 16) % 5 === 0 ? "exam" : "teach"`. The low 32 bits of the id, mod 5. About one photo in five is exam. The relay validates the same rule.
3. Teach photos: every picker pick and "Wrong card?" correction is saved as before (IndexedDB corrections store) and, if the user opted in, queued as a one-card contribution.
4. Exam photos: answers are held out. A pick or fix on an exam photo is remembered with the scan only (not saved as a correction, never embedded, never used for reference matching). After the scan the popup shows "Help check: is every card here right?" with "All right" and a dismiss button. The existing "Wrong card?" fixes rows first. "All right" sends one contribution per exam photo with every row: the user's fix where there is one, otherwise what the row shows (`confirm`). A row with no card is answered `unknown`; a card back is `notACard`. Nothing is sent if the user never confirms. The prompt appears only for opted-in users and never blocks anything.
5. Queue (`lib/share-store.js`, `lib/upload-queue.js`): IndexedDB database `card-scanner-share`. At most 200 contributions wait; past that the oldest are dropped. Batches of at most 20 per request. Retry with exponential backoff (1 minute doubling to 6 hours) for network errors, 5xx, 408 and 429. Any other refusal (4xx) drops that batch, because the relay will never accept it.
6. Opt-in (`lib/sharing.js`): off by default, enabled only by an explicit click on the options toggle, with the explanation next to it. `crypto.randomUUID()` creates the install id when the setting is turned on (`storage.local` key `shareInstall`). Turning it off deletes the id and the queue.

### Request to the relay

`POST RELAY_URL`, `Content-Type: application/json`, no credentials, body:

```json
{ "v": 1, "contributions": [ <contribution>, ... up to 20 ] }
```

Any 2xx means the whole batch was accepted. A 4xx other than 408/429 drops the batch.

## Contribution schema v1

```json
{ "v": 1, "install": "<uuid>", "split": "teach|exam", "photoId": "<16 hex>", "day": "YYYY-MM-DD",
  "model": { "clip": "<first 16 hex of the CLIP model sha256>", "crop": <EMBEDDING_VERSION int> },
  "catalog": "<first 16 hex of the catalog sha256>",
  "cards": [ { "box": [x, y, w, h],
               "crop": "<base64 JPEG>",
               "answer": { "cardId": "<catalog id>" } | { "notACard": true } | { "unknown": true },
               "scanner": { "cardId": "<id or null>", "confidence": 0.0-1.0, "stripe": "high|medium|low|none" },
               "source": "pick|wrong-card|confirm" } ] }
```

- No other keys are allowed at either level.
- `split` must equal the rule above applied to `photoId`.
- `model.clip` and `catalog` are the first 16 hex digits of the sha256 pins in `lib/setup.js` (`clip_visual_int8.onnx`, `catalog.bin.gz`). `model.crop` is `EMBEDDING_VERSION` in `lib/embed.js`.
- `day` is the UTC date.
- `box` is `[x, y, w, h]` as fractions (0..1) of the photo, with `x + w <= 1` and `y + h <= 1`.
- `crop` is the card only, long side 320 px, JPEG quality 0.8 (lowered only if needed), at most 40000 base64 characters.
- `stripe` is the confidence tier the popup shows (`high` >= 0.80, `medium` >= 0.50, `low`), or `none` when the scanner found no card.
- `cards` holds 1 to 30 rows. A teach contribution holds the one card the user picked. An exam contribution holds every card row of the photo.
- `source`: `pick` is a choice from the candidate list or search; `wrong-card` is a fix started from "Wrong card?"; `confirm` is a row accepted with "All right".

The validator is `validateContribution` in `lib/contribution.js`; the same module builds contributions and refuses to build an invalid one.

## Community pack (download side)

Code: `lib/community-pack.js`. The extension checks at most once a day. Nothing about the user is sent.

Files, all on one https origin (the pack URL must share the manifest's origin):

- `manifest.json`: the exact bytes that are signed.
- `manifest.sig`: base64 of a detached ECDSA P-256 / SHA-256 signature over the exact bytes of `manifest.json`, raw `r || s` (64 bytes; the WebCrypto / IEEE P1363 form, not DER). It sits in the same directory as `manifest.json`.
- the pack file, at `manifest.url` (relative to the manifest's address, or absolute on the same origin).

Manifest:

```json
{ "v": 1, "model": "<16 hex>", "catalog": "<16 hex>", "crop": 2, "entries": 1234, "dim": 512,
  "sha256": "<64 hex of the pack file>", "url": "pack-1.bin",
  "exam": { "before": 0.71, "after": 0.74, "n": 400 }, "improved": true }
```

`model` is the first 16 hex of the CLIP model sha256 (the same value as `model.clip` in contributions); `catalog` and `crop` likewise.

Pack file (all integers little-endian):

```
offset 0      uint32  H, the byte length of the header JSON
offset 4      H bytes UTF-8 JSON  { "v": 1, "dim": 512, "entries": N, "cardIds": [N catalog ids] }
offset 4+H    N * dim int8, row-major
```

Row i belongs to `cardIds[i]`. Each value is `round(127 * x)` of the L2-normalised float embedding, clamped to -127..127. The embedding is the one `lib/embed.js` makes for the card's art crop at `crop` version `EMBEDDING_VERSION`. The file is exactly `4 + H + N * dim` bytes; the header's `entries` and `dim` must equal the manifest's.

### Gating rule

The pack is used only when all of these hold:

1. the signature verifies against `PACK_PUBLIC_KEY`;
2. `model`, `catalog` and `crop` equal this build's values;
3. `improved === true` (the pipeline sets it only when the exam score of the new pack beat the previous one on held-out exam photos);
4. the pack file's sha256 equals the signed `sha256`, and its layout checks out.

Otherwise it is not used. A pack that no longer matches this build, or whose manifest now says `improved: false`, is deleted. A failed check (network, signature, bad hash) keeps the pack already stored, which was verified when it arrived.

Pack rows are matched with `referenceHit` in `lib/references.js` under the same thresholds and rules as the user's own references: they can only reorder cards the catalog already returned, at the catalog's own top score, and never override it. They do not need the "Recognize cards I corrected before" setting, because the gate above has already measured them.

## Privacy

What is sent and what is not is in `docs/store/privacy-policy.md` and `docs/store/listing.md`. In short: small card crops, the chosen card, the scanner's guess, a date, a random install id, a pixel hash and model codes, only after an explicit opt-in. No page address, no full photo, no account. Contributions are committed to the public repository fabcrowd/card-scanner-data, so they are publicly visible and kept indefinitely unless deletion is requested by install id (a GitHub issue or the contact email; the id is shown on the options page). IP addresses are used only for hourly rate-limit counters. Opting out deletes the install id and the queue from the browser, not contributions already received. The exam split keeps the check honest: exam answers are never learned from, here or in the pipeline.
