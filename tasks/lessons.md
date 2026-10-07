# Lessons

## The photo is the card signal, not the title

Only identify a card after PokeGrade (or VellumAI) confirms a card in the photo (`identity.name`). 422 "could not identify a card" is a skip, not a retry.

## Collectr has no public Partner API — use private api-v2 + JWT

`getcollectr.com/api` is 404. Live path: `api-v2.getcollectr.com` with JWT from web `localStorage.collectrToken` (`COLLECTR_TOKEN` + `COLLECTR_USER_ID`). Portfolio: `GET /collections/{userId}/products`. Aggressive probing can trip WAF 401s / service-unavailable; back off and re-login if needed. CSV remains fallback.

## Agent: PowerShell is not bash

`&&` / bash heredocs fail in this shell. Use `;` between commands, set cwd with `Set-Location` first, and pass multi-arg `node --test` as separate paths (not a comma-joined string).
