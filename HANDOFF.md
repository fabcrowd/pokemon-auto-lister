# Handoff — UI Scanner + Photo ID port + catalog embeddings

Updated: 2026-09-06 (optionals: backfill + phash + Vellum-first scanner)  
Workspace: `C:\Users\daroo\Desktop\Repos\cardscanner\pokemon-auto-lister`

## Catalog embeddings (done)

- Python **3.12** venv: `tools/vellum-ai/.venv312` (torch 2.14 CPU + open-clip + faiss-cpu)
- Ran `catalog/embed_all.py` → **21,669** vectors
- Artifacts in `data/card-catalog/`:
  - `embeddings.faiss` (~42 MB)
  - `embeddings.npy` (21669 × 512)
  - `meta.json` (aligned to embedded cards only)
  - `meta.full.json` (full TCGdex metadata backup, 23,548 rows)
  - `images/` (**22,070** webp after backfill; **401** recovered, **1,478** still missing — mostly Pocket/unpublished)
  - `phash.json` (**21,669** entries, aligned to embedded meta)
  - `coverage-report.json` (backfill summary)

## Vellum-first Scanner (done)

- `.env`: `VELLUM_AI_ENABLED=true`, `SCANNER_IDENTITY_MODE=local-only`, `IDENTITY_MODE=dual` (listing/inbox still dual)
- `src/index.js` uses a separate `scannerIdentityResolver` for `POST /api/scan` only
- Start identify: `npm run vellum-ai` (prefers `.venv312`) or `tools/vellum-ai/.venv312/Scripts/python identify_server.py`
- Start dashboard: `npm start` → http://127.0.0.1:3000
- **PGAI_KEY left as-is** (do not rotate unless asked)

## UI Scanner

- `POST /api/scan` + dashboard Scanner panel
- Local path uses Vellum + catalog above; PokeGrade still used for listing dual / sniper photos

## Not done yet

- Re-embed the **401** newly recovered images into FAISS (they sit on disk only)
- Sniper photo ID remains PokeGrade-only unless changed separately
