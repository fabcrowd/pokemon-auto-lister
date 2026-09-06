# Cursor notes — auto card lister

Guidance for Cursor Agent (and humans) working in this repo. Autopilot **task JSON already completed** via Claude Code CLI; use this file so future sessions do not re-litigate product decisions or re-scaffold.

## Product one-liner

Windows personal Pokémon **auto-lister** (sell) plus optional internal **Mercari sniper** (auto-heart). LAN dashboard / inbox → PokeGrade + comps → Mercari List and/or eBay drafts. Sniper is a sibling module under `src/sniper/`, gated by `SNIPER_ENABLED`.

## Do / don't

| Do | Don't |
|----|-------|
| Keep sniper never-buy / never-offer | Auto-buy or message sellers |
| Share one Mercari Chrome profile via `withMercariPage` mutex | Launch a second persistent profile |
| Mock external APIs in tests | Call live PokeGrade/eBay/TCGPlayer/Mercari in CI |
| Use real Chrome for Mercari (`channel: 'chrome'`) | Bundled Chromium for Mercari (PerimeterX) |
| Persist state as JSON under `data/` (`queue/` vs `sniper/`) | Add a database for v1 |
| Honor `config/listing-defaults.json` + `config/sniper-strategies.json` | Hardcode shipping/thresholds in drivers |
| Read [HANDOFF.md](../../HANDOFF.md) + [README.md](../../README.md) | Rebuild features that already pass tests |

## Stack conventions

- **Node ≥ 20**, `"type": "module"`
- Tests: `node --test` in `tests/*.test.js` — run `npm test` before claiming done
- Lint: `npm run lint` (eslint)
- Feedback loops: root [`autopilot.json`](../../autopilot.json)
- Secrets: `.env` only (gitignored); document new keys in `.env.example`

## Architecture map

```text
public/          → dashboard (vanilla HTML/CSS/JS) + Scalper panel
src/server.js    → multipart Add-card + stats/cards + /api/sniper
src/queue/       → durable sell card state machine
src/pricing/     → median comps, multipliers, 15% needs_review
src/pipeline/    → processCard orchestration
src/dispatch/    → mercari/ebay draft fan-out + partial success
src/mercari/     → Playwright session + mutex + sell fill
src/sniper/      → Mercari scan / deal math / auto-heart cycle
src/ebay/        → solds + Sell inventory draft
src/inbox/       → autolist-inbox watcher
src/service/windows/ → Task Scheduler install/uninstall
```

## Autopilot artifacts

| File | Role |
|------|------|
| [pokemon-auto-lister.md](./pokemon-auto-lister/pokemon-auto-lister.md) | Sell-side PRD |
| [pokemon-auto-lister.json](./pokemon-auto-lister/pokemon-auto-lister.json) | Sell tasks — **14/14 done** |
| [pokemon-mercari-sniper.md](./pokemon-mercari-sniper/pokemon-mercari-sniper.md) | Sniper PRD |
| [pokemon-mercari-sniper.json](./pokemon-mercari-sniper/pokemon-mercari-sniper.json) | Sniper requirements |
| [queue.json](./queue.json) | Project queue (entry done) |
| [draft-activity-ui-reference.png](./pokemon-auto-lister/draft-activity-ui-reference.png) | Dashboard visual target |

### Re-running or extending

```powershell
# Sell-side status (expect done)
autopilot-status docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.json

# Sniper is a sibling module — extend via its PRD, not by folding into sell queue
```

This repo is **not** wired to the Telegram-bot Singulr Conductor bridge. Use Gens-ai `autopilot` CLI or in-session TDD for small follow-ups.

## Pricing rules (sell — do not “simplify” away)

1. Collect PokeGrade value, Collectr, TCGPlayer market/mid, eBay last ≤5 sold median when possible.
2. Missing source or pairwise relative spread **> 15%** or low PokeGrade confidence → `needs_review`.
3. Else auto-list at median(available) × `mercariMultiplier` / `ebayMultiplier` (defaults `1.0`).

## Sniper deal rules (buy-side — separate)

1. Heart when market/ask ≥ **1.25×**; worklist **1.15–1.25×**; suspect ≥ **5×** (do not heart).
2. `seen` ≠ `hearted` ledgers under `data/sniper/` — never double-click a heart.
3. PokeGrade cache forever by Mercari item id (`data/pokegrade-item-cache.json`).

## Mercari automation invariants

- `channel: 'chrome'`, headful, persistent profile
- `ignoreDefaultArgs: ['--enable-automation']`
- `--disable-blink-features=AutomationControlled`
- Detect logged-out via **URL** poll (not DOM alone); wait for human login
- Sell + sniper share `createMercariSession().withMercariPage`

## Suggested next agent work

1. Live sniper smoke (README checklist) with `SNIPER_ENABLED=true`
2. Harden Mercari sell/search selectors if DOM drifts
3. Document eBay OAuth consent script if missing
4. Later phases (out of scope): eBay/Vinted alerts, ledger UI

## Session start checklist

1. `git status` / branch `pokemon-auto-lister`
2. Skim [HANDOFF.md](../../HANDOFF.md)
3. `npm test` if touching runtime code
4. Ask before enabling sniper in production or expanding past heart-only
