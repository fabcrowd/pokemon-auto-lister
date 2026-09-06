# VellumAI

Local Pokemon card **detection + identification** sidecar for Pokemon Auto-Lister.

- **Dual mode:** cross-check PokeGrade identity (`IDENTITY_MODE=dual`, `VELLUM_AI_ENABLED=true`)
- **Solo mode:** when PokeGrade free-tier quota opens the circuit, VellumAI IDs alone; comps stay Collectr / TCGPlayer / eBay
- **Grading:** stays on **PokeGrade** (cloud). VellumAI only does optional centering / glare QA — never claim PSA/CGC/BGS

## Quick start

```powershell
cd tools/vellum-ai
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python identify_server.py
```

Health: `http://127.0.0.1:8787/health`

In project `.env`:

```text
VELLUM_AI_ENABLED=true
VELLUM_AI_URL=http://127.0.0.1:8787
IDENTITY_MODE=dual
```

## Catalog + embeddings (accuracy)

```powershell
.\.venv\Scripts\python catalog\build_catalog.py --download-images
.\.venv\Scripts\pip install open-clip-torch faiss-cpu torch --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python catalog\embed_all.py
```

Keep `data/card-catalog/` **private** (TPC card art).

Weekly refresh task: `windows\install-catalog-refresh.ps1`

## Detector training

Role-aware classes (corner ≠ front):

| id | name | Use as listing front? |
|----|------|------------------------|
| 0 | `full_card` | Yes |
| 1 | `corner_closeup` | **Never** |
| 2 | `card_back` | No (back upload) |

1. Bootstrap labels from your real inbox (heuristics seed the YOLO boxes + classes):
   ```powershell
   .\.venv\Scripts\python detect\bootstrap_from_inbox.py --inbox $env:USERPROFILE\PokemonCardsInbox
   ```
2. Add synthetic full cards **and** corner macros (critical for teaching corner≠front):
   ```powershell
   .\.venv\Scripts\python detect\synth_bootstrap.py --count 280 --corner-ratio 0.45
   ```
3. Install train deps if needed: `pip install ultralytics onnx onnxruntime` (+ CPU/CUDA `torch`)
4. `python detect/train_detect.py` → writes `models/card_detect.onnx`
5. Gates:
   ```powershell
   .\.venv\Scripts\python detect\eval_detect.py
   .\.venv\Scripts\python detect\eval_corner_confusion.py
   ```
   Require mAP@50 ≥ 0.95 **and** corner→full_card rate ≤ 15% on val.
6. Runtime: `detect_and_rectify` sets `usable_as_front=False` when the top class is `corner_closeup`.

Hand-fix hard failures in `data/vellum-detect/` when heuristics mislabel — that is what locks corner≠front in production.

Backfill / coverage:

```powershell
.\.venv\Scripts\python catalog\backfill_coverage.py
```

Writes `data/card-catalog/coverage-report.json`. Note: TCGdex set shells `jumbo`/`rc`/`sp`/`wp` have 0 cards in the API.

Weights are gitignored; regenerate with the steps above after cloning.

## Calibration gate

Before enabling auto-draft with VellumAI:

```powershell
python calibrate_accept.py --holdout ..\..\data\vellum-holdout
```

Require **precision@accept ≥ 0.98**.

## Tests

```powershell
.\.venv\Scripts\python -m unittest discover -s tests -v
```
