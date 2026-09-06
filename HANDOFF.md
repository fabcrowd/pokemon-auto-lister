# Handoff — Pokémon Auto-Lister

Updated: 2026-08-10  
Branch: `pokemon-auto-lister`  
Workspace: `C:\repos\projects\auto card lister`

## Status

Sell-side autopilot complete (Mercari List + LIVE UI). **Mercari scalper (sniper)** is wired as an internal sibling module — default **off** (`SNIPER_ENABLED=false`). Scalper dashboard is a full ops panel (not a thin status strip).

## What was built

1. LAN dashboard — phone upload, front select, marketplace checkboxes, **Go** + LIVE toast
2. Queue + pricing — PokeGrade ⊕ VellumAI identity, Collectr api-v2 portfolio sync (CSV fallback), TCGPlayer/eBay when keyed, 15% Needs-review
3. Mercari driver — Playwright + Chrome profile; **List** when `mercariAutoPublish: true`
4. eBay draft client — Sell/Inventory APIs (unpublished)
5. Inbox watcher — Shared album pairing; Collectr sync (or CSV watcher if no token)
6. Windows Task Scheduler scripts
7. **Sniper** — `src/sniper/` scan → PokeGrade → heart ≥1.25×; mutex shared with sell drafts
8. **Scalper UI** — Live Activity–style panel: OFF/ARMED/SCANNING badge, threshold chips, stats, strategy chips, deal tables (hearts / worklist / suspects) with thumbs + Mercari links

## Decisions

| Topic | Choice |
|-------|--------|
| Mercari sell | Auto-publish (List), not draft |
| eBay | Draft only until publish OAuth wired |
| Go button | Needs-review confirm → live Mercari |
| Flip back | `mercariAutoPublish: false` in listing-defaults |
| Sniper | Same process + Chrome profile; `SNIPER_ENABLED` gate; never buy |
| Scalper UI | Match Live Activity ops chrome; three deal lanes, not bullet lists |

## Ops

1. `npm start` — dashboard `http://127.0.0.1:3000/`
2. First Mercari run: log in once in the dedicated Chrome profile
3. Needs review → edit price → **Go** → LIVE toast with listing link
4. Optional scalper: `SNIPER_ENABLED=true` → badge **ARMED**; see README smoke checklist + Scalper panel

## Key paths

| Path | Role |
|------|------|
| `src/mercari/fill.js` | Form fill + List |
| `src/mercari/mutex.js` | Serialize sell vs sniper on one page |
| `src/sniper/` | Deal math, search, heart, cycle, scheduler |
| `config/sniper-strategies.json` | Queries + thresholds |
| `data/sniper/state.json` | seen / hearted / worklist / suspects |
| `src/queue/queue.js` | `listed` + `markListed` |
| `public/index.html` | Live Activity + Scalper panel markup |
| `public/app.js` | Go + LIVE toast + Scalper tables / badges |
| `public/styles.css` | Scalper table / threshold / badge styles |
| `config/listing-defaults.json` | `mercariAutoPublish` |
| `docs/autopilot/pokemon-mercari-sniper/` | Sniper PRD |

## Next

- Live smoke: one real Mercari heart with `SNIPER_ENABLED=true` (confirm badge + deal rows fill)
- Confirm live PokeGrade graded field shapes if PSA comps come back empty
- Harden search/heart selectors if Mercari DOM drifts
