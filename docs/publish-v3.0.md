# Publishing v3.0 and checking it on a real Chrome (2026-10-23)

Everything below is ready locally. Nothing has been pushed or released: the push and `gh release create` were blocked by the permission system ("Create Public Surface"), so these steps need you, or a permission rule that allows `git push` and `gh release create` for this repo.

## What to publish
- Branch to push: `feat/image-pickers` (head `1e5d041`). It contains the whole chain: `feat/model-e` -> `feat/qa-fixes` -> `feat/stakes-confirm` -> `feat/image-pickers`, on top of the earlier integration work. Open a pull request into `main` from it.
- Release asset: `dist/release-v3.0/clip_visual_int8.onnx` (88,999,043 bytes) with `dist/release-v3.0/SHA256SUMS`. sha256 must be `0dba1302580da2a629936be835b765d6dba9019e677284257470d30070d9d52b`. The old candidate is kept beside it as `_F-clip_visual_int8.onnx.bak`: do NOT upload that one.
- Release notes: `docs/release-v3.0-notes.md`.

## Commands (run from the repo root)
```
git push -u origin feat/image-pickers
gh release create v3.0 dist/release-v3.0/clip_visual_int8.onnx dist/release-v3.0/SHA256SUMS --repo fabcrowd/pokemon-auto-lister --target feat/image-pickers --title "v3.0 — Reads small, blurry listing photos and asks when it isn't sure" --notes-file docs/release-v3.0-notes.md --latest=false
# verify the uploaded file
gh release download v3.0 --repo fabcrowd/pokemon-auto-lister --pattern clip_visual_int8.onnx --dir .tmp/verify-v3
certutil -hashfile .tmp/verify-v3/clip_visual_int8.onnx SHA256
```
Until the release exists, a fresh install of this build shows "This update isn't available yet" and cannot finish setup.

## Data repo (fabcrowd/card-scanner-data)
Update its `pins.json` to match `tools/shared-data/pins.json` (clip release v3.0, the sha256 above, cropVersion 3) so the nightly job builds and signs a bundle for model prefix `0dba1302580da2a6`. Until then the build runs without the shared adapter and shared memory (safe). Also publish the `prices` pre-release so the price snapshot URL stops returning 404. The nightly gate now mirrors the new confirm rule, so any stored gate figures measured under the old rule are stale and should be re-run.

## Store package
`scripts/build-wasm-extension.ps1 -Store` builds `dist/extension-wasm-store.zip` (manifest 3.1.0). Submit it only after the release above exists.

## Real Chrome check on your PC (the one thing I could not test)
The signed Facebook photo links can't be fetched outside your own browser, so the Facebook full-size path was never exercised. To check it:
1. Load `dist/extension-wasm` unpacked (or the store build), finish setup, and allow site access when the extension offers it.
2. Open one of your Facebook Marketplace lot listings with many cards and press Scan.
3. Look at: how many cards are confirmed (green) versus Choose (amber); whether "Open full-size photo" is offered and what it changes; the lot summary line ("Sure $x–$y · To confirm N"); that no card shows a price while it says Choose.
4. Tap a card in the To confirm list: the crop should sit beside card images with the best match highlighted; tapping an image confirms it and shows its price. Try "Review all" and "Tick all".
5. Note anything wrong, ideally with a screenshot, and the listing's photo size.
