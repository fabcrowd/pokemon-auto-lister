# Self-learning plan

Status: approved 2026-10-16. Step 1 (security fixes) is done; steps 2-4 are not started.
Builds on [shared-learning.md](shared-learning.md) (relay, data repo, signed community pack).

## Goal

Recognition improves for every user automatically from their opt-in picks, without retraining big models and without users reinstalling. All learning sits on top of the frozen CLIP embeddings the scanner already computes. The CLIP and YOLO models do not change.

## The loop

1. Users' picks and confirmations upload through the relay (opt-in, small card crops plus the chosen card).
2. The relay writes them to the `inbox` branch of the data repo.
3. A nightly job promotes corrections that pass the security rules, then trains three small add-ons, adds seed data, and adds new sets.
4. One gate decides whether the result ships.
5. If it passes, the job publishes one signed "bundle" release.
6. Every extension checks daily and hot-loads only the parts that changed.

## The three add-ons

All three train on CPU in GitHub Actions in minutes.

- **Memory.** The existing community pack: kNN reference rows built from promoted real-photo crops.
- **Photo adapter.** A small linear map (512x512, about 0.25 MB as int8) applied to both the query embedding and the catalog embeddings. It is trained contrastively on promoted crops, seed photos, and synthetic photo-like augmentations of catalog images (glare, sleeve sheen, blur, slight tilt, warm light, JPEG noise). It closes the clean-scan to photo gap for cards nobody has scanned yet.
- **"Is this a card?" check.** Logistic regression on embeddings. Negatives come from `notACard` answers, positives from confirmed cards. It removes false cards on sealed boxes, sleeves, and playmats.

## Detector limit

Learning to find missed cards needs whole photos with boxes. We upload only crops (a privacy decision), so detection only learns to drop false boxes, through the check above. Missed-card recall stays a manual retrain shipped in an extension update.

## Items

### 1. Signed bundle replaces the pack-only manifest

- The manifest lists catalog, memory, adapter, and check, each with a sha256.
- The extension downloads only changed parts, verifies signature, `seq` and `issuedAt` (the existing `lib/community-pack.js` rules), and hot-loads them.
- Bundles are keyed to the CLIP model and the crop version only, not to the catalog, so catalog changes do not invalidate learning.
- The CLIP and YOLO models stay pinned in the extension; changing them goes through a normal Chrome auto-update.

### 2. New sets automatically

The nightly job checks the card sources the extension already uses (pokemontcg.io and TCGdex, see `tools/extension-wasm/lib/pricing.js`) for new cards, embeds their images with the same model and crop, and appends them to the catalog asset in the bundle.

### 3. Seeded, self-learning nightly

- Seed from existing labelled, non-sealed real crops, except HiBid. HiBid reviewed boxes are the fixed regression exam and are never trained on. Add synthetic augmentations.
- Each night: promote corrections (security rules), train the three add-ons, add new sets.

## One gate

A candidate bundle must:

- beat the live bundle on the fixed HiBid regression set;
- beat it on the community exam once n >= 30;
- never add wrong "high" answers.

Otherwise the live bundle stays. Pack and adapter matches are advisory and are never "high".

## Status reporting

`STATUS.md` in the data repo is rewritten nightly. Per run it shows before/after scores, contributors, cards learned, new sets, and whether the bundle shipped.

## Build order

1. Security fixes. Done (commits 87f2d0e, 58a9c93).
2. Signed bundle.
3. Seed, three add-ons, gate, `STATUS.md`.
4. New sets.

Each step is TDD. Sonnet subagents build; Opus plans and reviews. A measured gain on HiBid is reported before anything ships. Owner setup is unchanged (see `tools/shared-data/README.md`) except the branch ruleset on `main` and building `regression.npz` once.

## Risks and open questions

- **Sybil poisoning.** Bounded by: matches are advisory, top-20 plus margin, multi-day agreement, and the regression gate.
- **Cold start.** The community exam is not trusted until n >= 30; until then only the HiBid regression set gates.
- **Chrome store policy.** Models and data are data, not code; the extension already downloads models at setup.
