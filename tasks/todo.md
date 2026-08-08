# Auto card lister — plan

## Scope (locked)

Personal Windows Pokémon **auto-lister**: phone LAN dashboard → pick front photo → PokeGrade `/value` + TCGPlayer market + eBay solds → Mercari and/or eBay **drafts only**.

## Will change

- Greenfield Node + Playwright + static dashboard repo
- Autopilot PRD (done) → tasks JSON → TDD execution

## Will not do (v1)

- Auto-publish, buying, sniper/heart watcher
- macOS launchd, tunnels, DB, React
- TCGPlayer sold scrapes / paid sold APIs

## Risk

- Mercari PerimeterX / sell-form selector drift
- eBay OAuth + draft API policy setup
- Comp identity matching (wrong TCGP/eBay query → false Needs review or bad price)

## Checklist

- [x] Clarifying questions (autopilot PRD)
- [x] PRD written: [docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.md](../docs/autopilot/pokemon-auto-lister/pokemon-auto-lister.md)
- [x] Human approves PRD
- [x] `/tasks` → `pokemon-auto-lister.json` (14 requirements)
- [x] `autopilot.json` init
- [ ] Confirm task deps / queue
- [ ] Execute via terminal `autopilot` (14 reqs — overnight-friendly)

## Review

Tasks generated. UI reference PNG saved beside PRD. Ready for autopilot TDD after dep confirmation.
