# Fix corner-as-front photo selection (2026-08-11)

## Plan
- [x] Restore mtime on download; sort flat inbox by IMG_####
- [x] Identify fronts/backs by content; next full-card = back; match closeups by similarity
- [x] Set front reprocesses identity; UI shows extras
- [x] Tests + README
- [x] Inbox front picker (Browse inbox photos)
- [x] Retrain Vellum detector multi-class (full_card / corner_closeup / card_back)

## Review
- Detector classes teach corner≠front; `usable_as_front` requires full_card @ conf≥0.35
- Bootstrap from inbox + 45% synth corners; corner→full rate 0% on val
- Hand-label hard failures in `data/vellum-detect/` for the next retrain

# Multi-card detection improvement (2026-09-06)

## Scope
Make contour multi-card detection reliable enough to split a table photo of 2–6 cards into individual rectified crops.

**Will change:** `tools/vellum-ai/vellum_ai/detect_multi.py`, `tools/vellum-ai/tests/test_detect_multi.py`, `src/photos/splitMultiCard.js` + JS tests if splitter behavior must change.

**Will not:** retrain YOLO, rewrite single-card `detect.py`/`rectify.py` except calling existing `rectify_card` with kept quads.

## Known failures (Claude left these mid-fix)
- [x] Grid tests fail: 5% max-area cap rejects cards that are 9–13% of a tight-grid canvas
- [x] 30°/45° tilt: `_score_quad_multi` used AABB aspect (square at 45°) — minAreaRect patch is in file, unproven
- [x] Contour finds quads then discards them; crops use AABB via `rectify_from_box` (background + no perspective)
- [x] Hardcoded warm-brown table mask (`H 5–35`) fails on other surfaces
- [x] 3-card unit test only requires 2/3; no JS tests for `splitMultiCard.js`
- [ ] Folder inbox path never calls the splitter (flat photos only) — left as-is; folders are already one-card drops

## Plan
- [x] Prove current pytest red: `python -m pytest tests/test_detect_multi.py -v` in `tools/vellum-ai`
- [x] Replace absolute 5% area cap with a scale that allows a single card in a 2–6 card frame (keep merged-blob rejection)
- [x] Keep minAreaRect aspect; keep perspective quads through to `rectify_card`
- [x] Drop or adapt the brown-table mask so it is not a hard dependency
- [x] Tighten tests: 3-card requires 3; grids and 15/30/45° stay required
- [x] Add JS unit tests for splitter (2+ crops → paths; 0/1/error → original)
- [x] Re-run pytest + `node --test` for the new JS file

## Success
- All `test_detect_multi.py` tests pass
- Splitter JS tests pass
- No ONNX / YOLO retrain
- Surgical diffs only

## Review
- `_MAX_AREA_FRAC` 0.05 → 0.35. Grid cards (~9–13%) kept; near-full-frame blobs still rejected. Merged pairs still die on aspect + landscape AABB (`W/H > 1.15`)
- Contour hits keep `quad`; crops use `rectify_card`. ONNX still AABB
- Removed brown `non_table` edge map
- Evidence: pytest 22/22; `tests/split-multi-card.test.js` 4/4
- Not done: folder inbox still does not split (intentional — one folder = one card). No live table-photo eval this pass

# Multi-card identity loop (2026-09-06)

Sequential / safe. Runbook: `.claude/plans/multi-card-identity-loop.md`

**Will change:** `tools/vellum-ai/vellum_ai/eval_score.py`, `tests/test_eval_score.py`, `tests/test_detect_identity.py`, `detect_multi.py` only if a new stage fails, `loop_stages.json`, plan notes.

**Will not:** YOLO, commits, catalog download.

## Plan
- [x] Confirm baseline: `test_detect_multi.py` 22/22; `ECC_HOOK_PROFILE` not disabled
- [x] Identity-weighted scorer (70% ID / 20% IoU / 10% count); wrong ID cannot pass on boxes
- [x] Stages 1–2: 2-card and 3-card verified IDs after detect+crop
- [ ] Stage 3: 2×2 grid IDs
- [ ] Stage 4: 3×2 grid IDs
- [ ] Stage 5: 30° tilt ID
- [ ] Stage 6: live queue/catalog or skip

## Stop
6 ticks, or stage 6 done, or two stalled ticks.

# Photo ID port — qtran pHash + spatial OCR + Didier grid (2026-09-06)

Plan: `.cursor/plans/photo_id_port_fdc3c1a5.plan.md` (do not edit). Full handoff: [`HANDOFF.md`](../HANDOFF.md).

## Plan
- [x] Phase 1: pHash rerank + catalog helper + tests
- [x] Phase 2: HP-anchor name OCR + tests
- [x] Phase 3: verify_grid + identify_multi imageUrl/grid + cycle `officialArtUrl` + worklist dual thumb + unit tests
- [ ] Browser-verify dual thumb on live dashboard (inject mock worklist row; server may already be on :3000)

## Review
- CLIP crop untouched; no commit
- pHash no-ops until `build_phash.py` populates sidecar
- Tests: pytest phash/ocr_names/verify_grid/identify_multi green; node official-art + ui-markup + cycle green
- Harden pass: local `pokemontcg_hires_url` (no resolve_card for art), clear TCG `identity is None` fallback, grid failures swallowed, dual-thumb DOM-verified
- Full notes: [`HANDOFF.md`](../HANDOFF.md)

# UI Scanner — ID + PRICE (2026-09-06)

## Plan
- [x] `scanAndPrice` shared core + `processCard` reuse
- [x] `POST /api/scan` + Scanner panel UI
- [x] Unit/integration tests
- [x] Live JustTCG pricing smoke (`scripts/scan-pricing-smoke.mjs`)

## Review
- Pricing pulls: JustTCG live $504.11 on Base Charizard #4
- Photo identify via UI needs `PGAI_KEY` set; without it scan returns config error (endpoint still works)
- Does not auto-list; no commit

# Optionals — backfill + phash + Vellum-first scanner (2026-09-06)

## Plan
- [x] Retry failed catalog art (`backfill_coverage.py`) — 401 recovered, 1478 still missing
- [x] Build `phash.json` — 21,669 entries
- [x] Enable Vellum in `.env`; `SCANNER_IDENTITY_MODE=local-only`
- [x] Fix identify `/health` (`__version__`); start server on `:8787`
- [ ] Do **not** rotate `PGAI_KEY`
- [ ] Optional later: re-embed 401 new images into FAISS

## Review
- Images on disk: 22,070; FAISS still 21,669 (new art not embedded yet)
- `npm run vellum-ai` prefers `.venv312`; `/health` ok + catalog loaded
- Scanner uses local-only resolver
- No commit; PG key unchanged
