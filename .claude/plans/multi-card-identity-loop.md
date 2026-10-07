# Multi-card identity loop (sequential / safe)

Started: 2026-09-06  
Pattern: **sequential**  
Mode: **safe**  
Model: same session model only (do not spawn Other Models — they hit the org usage limit)

## Repository / branch

- Branch: `main` (dirty working tree; research/sniper/facebook already in progress)
- Isolation: only `tools/vellum-ai/**`, `tests/split-multi-card.test.js`, this plan, `tasks/todo.md`.
- **Do not commit. Do not push. Do not open PRs.** (not `continuous-pr`)
- Do not touch Facebook / HiBid / research / Collectrics / public UI

## Why this loop

Contour tests only scored box IoU on solid rectangles. A crop that is the wrong card would still pass. The product is a **verified card ID** (name + number + set when known), matching `eval_queue_cards.py` / PokeGrade truth.

Weights (`vellum_ai/eval_score.py`):

| Signal | Weight |
|--------|--------|
| Identity recall (verified ID match) | 0.70 |
| Mean matched IoU | 0.20 |
| Count accuracy | 0.10 |

Gate: **score >= 0.85**. A perfect box with the wrong name/number scores ~0.30 and fails.

No local catalog and no queue JSON exist today (`data/` is gitignored and empty of those). Stages 1–5 use painted cards bound to verified IDs. Stage 6 uses live PokeGrade/catalog when those files appear.

## Stages

See `tools/vellum-ai/detect/loop_stages.json`.

1. Two spread cards — both IDs (done in tick 0)
2. Three spread cards — all three IDs (done in tick 0)
3. 2×2 grid — ≥3/4 IDs
4. 3×2 grid — ≥4/6 IDs
5. 30° tilt — recover ID from the crop
6. Live queue/catalog photos — skip if data missing

## Tick protocol (one stage per tick)

1. Read this runbook + `.claude/plans/SHARED_TASK_NOTES.md` + `loop_stages.json`
2. Add the next pending stage as a **failing-then-passing** test in `tests/test_detect_identity.py` (do not loosen the 0.85 gate or identity weights)
3. Run: `python -m pytest tools/vellum-ai/tests/test_eval_score.py tools/vellum-ai/tests/test_detect_identity.py tools/vellum-ai/tests/test_detect_multi.py -q`
4. If red: smallest detector fix in `detect_multi.py` only
5. Re-run the same pytest. Also `node --test tests/split-multi-card.test.js` if splitter files change
6. Update `loop_stages.json` status + SHARED_TASK_NOTES (score, what changed)
7. Stop if a stop condition hits

## Quality gates (safe)

- `test_eval_score.py` + `test_detect_multi.py` stay green every tick
- Wrong-identity fixture must keep scoring < 0.50
- No new edge maps. No YOLO retrain. No lowering IoU / gate
- Two failed fixes on the same assertion → stop and escalate (do not stack heuristics)

## Stop conditions (any one)

- `current_stage` > 5 and last two ticks passed the gate
- **6 ticks** completed
- Two consecutive ticks with the same failing test and no score change
- User says stop

## Hooks

`ECC_HOOK_PROFILE` was unset (defaults to `standard`, not disabled). Safe mode uses **strict** for this loop session only — do not write it into `~/.claude/settings.json`.

```powershell
$env:ECC_HOOK_PROFILE = "strict"
```

## Start / monitor

From repo root:

```powershell
$env:ECC_HOOK_PROFILE = "strict"
python -m pytest tools/vellum-ai/tests/test_eval_score.py tools/vellum-ai/tests/test_detect_identity.py tools/vellum-ai/tests/test_detect_multi.py -q
```

Cursor loop sentinel: `AGENT_LOOP_TICK_multicard-id`  
Notes file: `.claude/plans/SHARED_TASK_NOTES.md`  
Stage file: `tools/vellum-ai/detect/loop_stages.json`

To stop: kill the sleeper PID and do not re-arm.
