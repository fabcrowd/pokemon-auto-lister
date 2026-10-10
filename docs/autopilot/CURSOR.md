# Cursor notes — Pokémon card scanner

Guidance for Cursor Agent (and humans) working in this repo.

## Product one-liner

Windows personal Pokémon **card scanner**. Phone photo → multi-card detect → PokeGrade + VellumAI identity → Collectr / JustTCG / eBay comps → price grid per card.

## Stack conventions

- **Node ≥ 20**, `"type": "module"`
- Tests: `node --test` in `tests/*.test.js` — run `npm test` before claiming done
- Lint: `npm run lint` (eslint)
- Secrets: `.env` only (gitignored); document new keys in `.env.example`

## Architecture map

```text
public/          → dashboard (vanilla HTML/CSS/JS) + Scanner panel
src/server.js    → multipart scan upload + /api/scan
src/pricing/     → median comps, 15% needs_review threshold
src/scan/        → scanAndPrice orchestration (identity → comps → grid)
src/identify/    → identity resolver + VellumAI client
src/pokegrade/   → PokeGrade /value API client + quota circuit
src/collectr/    → Collectr api-v2 + CSV fallback
tools/vellum-ai/ → local CLIP/FAISS detect+ID sidecar (Python 3.12)
data/card-catalog/ → embeddings.faiss + meta.json + phash.json
```

## Pricing rules (do not "simplify" away)

1. Collect PokeGrade value, Collectr, JustTCG, PokéWallet, eBay last ≤5 sold median when possible.
2. Missing source or pairwise relative spread **> 15%** or low PokeGrade confidence → `needs_review`.
3. Else surface median(available) in the Scanner panel price grid.

## Session start checklist

1. `git status` / check current branch
2. Skim [HANDOFF.md](../../HANDOFF.md)
3. `npm test` if touching runtime code
