// Price never decides whether a card is confirmed. A card is CONFIRMED only by the picture/name rule (lib/fusion.js) or by
// the user; the dollar amount is shown, not used to move a card between CHOOSE and CONFIRMED. This module holds:
//   - the price of a Choose card's best match (bestMatchPrice), shown on its row marked unconfirmed, and the lot's
//     separate "Unconfirmed" figure (unconfirmedTotal);
//   - the non-state "High value, double-check" flag (isHighValue);
// A correction-memory confirm uses the per-band confirm bar C (reference-bars.js) whatever the price.
// The nightly gate (tools/shared-data/pipeline/gate.py) does not mirror this: its rows have no heights and no prices.

import { detectedVariant, isGridStale, quotedPrice, suggestedVariant } from "./card-display.js";
import { chooseState } from "./choose-flow.js";

export const HIGH_STAKES_MIN_USD = 50;

const isPrice = (value) => typeof value === "number" && Number.isFinite(value);

/** The "High value, double-check" flag: a card the user has not confirmed whose typical price is $50 or more. Not a state. */
export function isHighValue(card, typicalPrice) {
  return !card?.userConfirmed && isPrice(typicalPrice) && typicalPrice >= HIGH_STAKES_MIN_USD;
}

/**
 * What a Choose card's best match (the preselected candidate) is worth, from that candidate's priceCard answer (resp).
 * Printing-specific, never a range: the settled printing (printed number, single printing) is quoted; else the suggested
 * variant's price (the "pick printing" prompt stays); else the typical (lower middle) price, marked 'typical'.
 * null while resp is not loaded; kind 'none' when the candidate has no price. stale: the grid is older than 30 days.
 */
export function bestMatchPrice(card, resp, enabledConditions = ["NM"]) {
  if (!resp || resp.error) return null;
  const probe = {
    identity: resp.identity, setChoices: [], setConfirmed: true, price_grid: resp.price_grid, market_price: resp.market_price,
    variant: card?.variant, firstEdition: card?.firstEdition, shadow: card?.shadow, numberRead: card?.numberRead,
  };
  const stale = isGridStale(resp.price_grid);
  const settled = quotedPrice(probe, detectedVariant(probe), enabledConditions);
  if (settled) return { price: settled.price, kind: "quoted", stale };
  const suggested = suggestedVariant(probe);
  const quote = suggested ? quotedPrice(probe, suggested, enabledConditions) : null;
  if (quote) return { price: quote.price, kind: "suggested", stale };
  const typical = priceTypicalOf(probe, null, enabledConditions);
  return typical == null ? { price: null, kind: "none", stale } : { price: typical, kind: "typical", stale };
}

/** The lot's unconfirmed figure: best-match prices of Choose cards (not skipped, not stale, not unpriced). */
export function unconfirmedTotal(cards, matchFor) {
  let total = 0;
  let count = 0;
  (cards || []).forEach((card, idx) => {
    if (chooseState(card) !== "choose") return;
    const match = matchFor(card, idx);
    if (!match || match.stale || !isPrice(match.price)) return;
    total += match.price;
    count += 1;
  });
  return { total, count };
}

/**
 * What the card is likely worth, for the demotion rule: its quoted price when the printing is settled, otherwise the
 * median (the lower middle value for an even count) of the printings' prices at the first enabled condition (one printing: that price). Null when no printing has
 * a price. The range high (priceHighOf) is wrong for this: it includes the 1st Edition and Shadowless printings, so a
 * Most copies in a lot are the common printing, so an even count takes the lower middle price: $0.34 and $103.66 must not
 * average to a misleading $52. A Potion with four printings (cheapest $0.21, range high $103.66) was demoted though the name was right, which cost
 * 12-51 extra confirmations per grid fixture. Promotion keeps the conservative high; demotion follows the likely price.
 */
export function priceTypicalOf(card, choice, enabledConditions = ["NM"]) {
  const quote = quotedPrice(card, choice, enabledConditions);
  if (quote) return quote.price;
  const condition = enabledConditions?.[0] || "NM";
  const variants = Object.values(card?.price_grid?.variants || {});
  const prices = variants.length
    ? variants.map((v) => v?.conditions?.[condition])
    : [condition === "NM" ? card?.market_price : null];
  const sorted = prices.filter((p) => typeof p === "number" && Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[(sorted.length - 1) >> 1];
}
