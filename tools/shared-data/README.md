# Shared learning: data repo template and relay

Users who opt in share the corrections they make. A Cloudflare Worker (`tools/relay/`) accepts them and
commits them to a separate GitHub data repo. A nightly GitHub Action in that repo (this folder) builds a
signed community pack of reference embeddings and scores it on held-out photos. Nothing here is deployed
by the code repo; you copy it.

## What goes where

| This repo | Copy to |
|---|---|
| `tools/relay/` | Deploy as a Cloudflare Worker with wrangler |
| `tools/shared-data/` (everything, including `.github/`) | The root of the new data repo |

## Owner setup

1. **Data repo.** Use `fabcrowd/card-scanner-data` (already created, public, empty). Copy the contents of `tools/shared-data/` to its root
   (`.github/workflows/nightly.yml`, `pipeline/`, `scripts/`, `tests/`, `pins.json`, `requirements.txt`).
   The repo is public, so contributions (card pictures, answers, install id) are public. The privacy policy says so.
2. **GitHub token for the relay.** Settings, Developer settings, Fine-grained tokens: resource owner you,
   repository access "Only select repositories" = the data repo, permission "Contents: Read and write".
   Nothing else. Set a calendar reminder for its expiry.
3. **Cloudflare.** Create an account, then `npm i -g wrangler` (or use `npx wrangler`) and `wrangler login`.
4. **Bindings.** In `tools/relay/`:
   - `npx wrangler r2 bucket create card-scanner-pending`
   - `npx wrangler kv namespace create RATE`, then paste the printed id into `wrangler.toml`.
5. **wrangler.toml values.** Set `DATA_REPO` (`fabcrowd/card-scanner-data`), `DATA_BRANCH`, and
   `ALLOWED_EXTENSION_IDS` (your extension's id from `chrome://extensions`; list the dev id and the store id
   separated by commas).
6. **Secret and deploy.** `npx wrangler secret put GITHUB_TOKEN`, then `npx wrangler deploy`. Note the
   `https://card-scanner-relay.<subdomain>.workers.dev` URL. The hourly Cron Trigger is in `wrangler.toml`.
   Until all settings are valid the Worker answers HTTP 500 and the cron run throws.
7. **Signing key.** On your own machine, outside any repo:
   `python scripts/keygen.py --out C:\secure\pack-signing-key.pem`. It prints the public key (base64 SPKI) on
   its last line and refuses to write inside a repo or overwrite an existing file. In the data repo add the
   PEM's full text as the Actions secret `PACK_SIGNING_KEY`. Keep the PEM file backed up; losing it means
   shipping a new public key in an extension update.
8. **Where packs are published.** The Action publishes releases in the data repo itself, which is public, so
   nothing more is needed. Only if you ever make the data repo private: set the Actions variable
   `PACK_RELEASE_REPO` to a public repo and the secret `PACK_RELEASE_TOKEN` to a fine-grained token with
   "Contents: Read and write" on that repo only.
9. **Extension config.** In the extension's `lib/shared-config.js` set:
   - `RELAY_URL` = `https://<worker>.workers.dev/v1/contributions` (the full endpoint)
   - `PACK_MANIFEST_URL` = `https://github.com/fabcrowd/card-scanner-data/releases/latest/download/manifest.json`
   - `PACK_PUBLIC_KEY` = the base64 SPKI line from step 7
10. **First run.** Actions tab, "nightly-pack", Run workflow. With no contributions it publishes an empty,
    valid pack, which proves the signing key and release path work.

## Contribution schema v1

```
{ "v": 1, "install": "<uuid>", "split": "teach"|"exam", "photoId": "<16 hex>", "day": "YYYY-MM-DD",
  "model": { "clip": "<16 hex>", "crop": <int> }, "catalog": "<16 hex>",
  "cards": [ { "box": [x,y,w,h], "crop": "<base64 JPEG, at most 40000 chars>",
               "answer": { "cardId": "<id>" } | { "notACard": true } | { "unknown": true },
               "scanner": { "cardId": "<id|null>", "confidence": 0..1, "stripe": "high"|"medium"|"low"|"none" },
               "source": "pick"|"wrong-card"|"confirm" } ] }
```

Request: `POST /v1/contributions` with `{ "v": 1, "contributions": [ up to 20 contributions ] }`, at most 1 MB. Any other body shape is a 400. Cards: 1 to 30
per contribution, box values in 0..1. Unknown fields are rejected.

**Split rule (exact).** `split` must equal `parseInt(photoId.slice(-8), 16) % 5 === 0 ? "exam" : "teach"`.
That is the low 32 bits of the photoId (its last 8 hex digits) mod 5: about 20% of photos are exam. The relay
rejects any other combination.

`model.clip` and `catalog` are the first 16 hex digits of the sha256 pinned in the extension's `setup.js` for
`clip_visual_int8.onnx` and `catalog.bin.gz` (currently `77538aade655907f` and `2f3c50cec84937ff`).
`model.crop` is `EMBEDDING_VERSION` (currently 2). The crop is the rectified card image, the same canvas
`embedCard` receives; the pipeline takes its own art strip from it.

Files land in the data repo as `contributions/<day>/<photoId>-<first 8 of install>-<n>.json`, one hourly commit.
`n` continues after existing files so nothing is overwritten.

## Relay behaviour

- CORS and access: only `chrome-extension://<id>` origins listed in `ALLOWED_EXTENSION_IDS`. Origin is
  spoofable by non-browser clients, so the real protection is validation plus rate limits.
- Limits (KV counters, approximate under concurrency): 200 cards per install per UTC day, 50 requests per IP
  per UTC hour (every POST counts, including invalid ones). Over the limit answers 429 with `Retry-After`.
  Override with `CARDS_PER_INSTALL_DAY`, `REQUESTS_PER_IP_HOUR`.
- Accepted items wait in R2 as `pending/<day>/<uuid>.json`. The hourly cron commits up to `MAX_ITEMS_PER_FLUSH`
  (100) of them in one commit through the Git Data API, moves the branch with `force: false`, and only then
  deletes them from R2. Any failure leaves them pending for the next hour. New files are sent as tree entries
  with inline `content`, which makes GitHub create the blobs itself in the same call (one request instead of
  one per file, which matters for Workers' subrequest limit).

## Pipeline (nightly)

0. Release assets live on github.com and redirect to objects.githubusercontent.com when downloaded; the
   manifest's `url` stays on github.com, the manifest's own origin, so the extension's origin rule is met, but the
   redirect target needs CORS/host permission on the extension side.
1. Load every `contributions/**/*.json`, drop invalid ones, drop answers whose card id is not in the catalog.
   Cards are merged by `(photoId, box rounded to 0.01)`; each install keeps its own latest vote, so the same
   photo is never counted twice but agreement between installs stays visible.
2. Embed every crop as the extension does (`pipeline/embed.py`: centred square of the top 45% strip, 224 px,
   CLIP normalisation, int8 model). `tests/test_drift.py` checks the constants against the extension source
   when this folder sits next to it.
3. TEACH consensus (`pipeline/consensus.py`). Crops are clustered at cosine 0.95. A cluster with any
   disagreement is held (a "not a card" vote disagrees with every card; "unknown" abstains). A clean cluster's
   card is promoted when at least two distinct installs voted for it, or one install did and the card is also
   in the catalog's top-20 neighbours of that crop. Rows promoted by two or more installs agreeing are exempt from any cap. Rows promoted by the neighbour rule
   alone (one install) are capped so no install owns more than 10% of all promoted rows (`MAX_INSTALL_SHARE`).
   The exam gate (`improved`: better than the plain catalog, on at least 30 exam cards) is the real safety check.
4. Only promoted TEACH crops become pack rows. EXAM contributions never enter the pack: `promote()` refuses
   anything that is not `teach`.
5. EXAM score. Exam contributions in which every card was answered (none `unknown`) are scored; `notACard`
   cards are skipped. A pack row wins as in `lib/references.js` (cosine at least 0.93 and ahead of the
   catalog's top score by 0.02) and, as in `background.js`, only when its card is already in the catalog's top
   20. Reported: top-1 accuracy before and after, and the wrong-at-high rate (a wrong answer carrying the
   "high" stripe by the `fusion.js` rule). Pack-promoted answers are tied with the top hit, so never high.
6. `manifest.json` is signed (ECDSA P-256, SHA-256) over its exact bytes. `manifest.sig` is the base64 of the
   64-byte raw `r||s` signature, which is what WebCrypto `verify` takes with `{name: "ECDSA", hash: "SHA-256"}`.
   The public key is imported as `spki`.

### manifest.json

```
{ "v": 1, "model": "<clip 16 hex>", "catalog": "<16 hex>", "crop": 2, "entries": N, "dim": 512,
  "sha256": "<pack sha256>", "url": "<pack download url>",
  "exam": { "before": 0.0-1.0, "after": 0.0-1.0, "n": N, "wrongAtHigh": { "before": .., "after": .. } },
  "improved": after > before && n >= 30 }
```

The extension should refuse a pack whose `model`, `catalog` or `crop` differ from its own, whose `sha256` does
not match the download, or whose signature fails. `improved` is the gate for using the pack at all.

### Pack byte format (v1)

```
bytes 0..3        little-endian uint32 N: length of the header
bytes 4..4+N      UTF-8 JSON {"v":1,"dim":512,"entries":N,"cardIds":[N strings]}
then              N * 512 int8, row-major; row i belongs to cardIds[i]
```

Each value is `round(127 * x)` of the L2-normalised component, clamped to -127..127; there is no scale field.
The file is exactly `4 + N_header + entries * 512` bytes. Same layout as `lib/community-pack.js`;
`tests/shared-data-pack.test.js` parses a pipeline-written fixture with the extension's own `parsePack`.
`pipeline/pack.py` is the reference reader and writer.

## Privacy note (for the opt-in screen and privacy policy)

Shared data is the card crops only: JPEG images of the cards, the box inside the photo, what the user said the
card is, what the scanner guessed, and a random install id. No page URLs, no listing text, no account or
device identifiers; the install id is a random UUID made on the user's device and not derived from anything
else. The relay does not keep IP addresses with contributions; an IP appears only inside a rate-limit counter key that expires after about 70 minutes. Contributions
sit in the data repo's git history, so deleting one means rewriting history.

**Deletion request.** The user finds their install id in the extension's settings and sends it to you. Then:
1. List the files: `git log` is not enough because names carry only the first 8 characters, so search file
   contents: `grep -rl '"install":"<full id>"' contributions/`.
2. Remove them and purge them from history with `git filter-repo --invert-paths --paths-from-file list.txt`,
   then force-push (temporarily allow it on the branch). Re-run the nightly workflow so the next pack no longer
   contains rows made from those crops.

## Tests

```
python -m unittest discover -s tests            # in the data repo
python -m unittest discover -s tools/shared-data/tests   # in the code repo
node --test tests/relay-*.test.js               # relay, in the code repo
```
