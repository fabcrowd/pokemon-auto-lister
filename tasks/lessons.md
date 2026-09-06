# Lessons

## Collectr has no public Partner API — use private api-v2 + JWT

`getcollectr.com/api` is 404. Live path: `api-v2.getcollectr.com` with JWT from web `localStorage.collectrToken` (`COLLECTR_TOKEN` + `COLLECTR_USER_ID`). Portfolio: `GET /collections/{userId}/products`. Aggressive probing can trip WAF 401s / service-unavailable; back off and re-login if needed. CSV remains fallback.

## Mercari drafts need a human login once (by design)

Mercari blocks automated login. Confirm/Go opens a **dedicated** Chrome profile (`data/mercari-chrome-profile`), not the user’s everyday Chrome. Session cookies persist; keep one Playwright context for the process lifetime.

## Do not close Chrome after each listing

Own a long-lived `createMercariSession` so login is not repeated per card.

## Mercari sell form uses data-testid, not name= selects

Live `/sell/`: `Title`, `Description`, `ConditionLikeNew`, `SellCategoryFieldButton`, `MercariShipping`, `SelectShipping`, `ListButton`, `SaveDraftButton`. Category: **Toys & Collectibles > Trading Cards > Single Cards** (suggested after title). Prepaid often auto-picks First-Class Envelope. Click the **button** that contains category text (not the inner `<p>`), or the category dialog stays open and blocks later clicks.

## Auto-publish is intentional

`mercariAutoPublish: true` clicks **List**. Dashboard must surface LIVE confirmation (`listingUrl` + toast). Set `false` to Save draft instead. eBay remains draft-only.

## Error status without pricedCache means identity hard-failed

If a queue card is `status=error` and `pricedCache` is null, `processCard` threw during PokeGrade/Vellum identity evaluation (not a comps disagreement). Use **Rescan all cards** or fix front photo / PG circuit — don't assume pricing logic failed.

## Needs Review inbox browse must not poll() after load

`createActionButton` default `poll()` rebuilds `#needs-review-body` and wipes an open inbox grid. Browse inbox uses `{ refresh: false }`; open pickers restore via `data-card-id` + `_expandInboxPicker`.
