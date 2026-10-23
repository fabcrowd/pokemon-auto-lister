// Price decides how much picture evidence a card needs. The product keeps two user-visible states (CONFIRMED and
// CHOOSE, lib/choose-flow.js); this module only moves a card between them when the cost of a mistake says so:
//   - a small-photo card (smallRow, lib/fusion.js SMALL_ROWS) is promoted when its price is at most LOW_STAKES_MAX_USD:
//     a wrong cheap card costs little, and asking about every cheap card costs the user more than it saves;
//   - a card the picture alone confirmed, without the "high" tier or a title line that agrees, is demoted when its
//     price is at least HIGH_STAKES_MIN_USD: a wrong expensive card is what the QA drive found (D-1).
// A card the user confirmed (pick, "Wrong card?" search, accepted guess, bulk confirm) is never changed, and an unknown
// price changes nothing. The nightly gate (tools/shared-data/pipeline/gate.py) does not mirror this: its rows have
// no heights and no prices.

import { confTier, isSetConfirmed, quotedPrice, rowRange, setRangeOf } from "./card-display.js";
import { BELOW_HIGH_CONFIDENCE, SMALL_SOURCE_CONFIDENCE_CAP } from "./fusion.js";
import { choiceName } from "./set-choice.js";

export const LOW_STAKES_MAX_USD = 5;
export const HIGH_STAKES_MIN_USD = 50;

const isPrice = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * 'promote' | 'demote' | 'keep'.
 * @param {{state: 'confirmed'|'choose'|'back', tier: string, titleConfirmed?: boolean, smallRow?: boolean,
 *   userConfirmed?: boolean, priceHigh: number|null|undefined}} input priceHigh is the single quoted price, or the
 *   high end of the price range while the printing is still open; null/undefined when the price is unknown.
 */
export function stakesDecision({ state, tier, titleConfirmed = false, smallRow = false, userConfirmed = false, priceHigh } = {}) {
  if (userConfirmed || !isPrice(priceHigh)) return "keep";
  if (state === "choose" && smallRow === true && priceHigh <= LOW_STAKES_MAX_USD) return "promote";
  if (state === "confirmed" && tier !== "high" && !titleConfirmed && priceHigh >= HIGH_STAKES_MIN_USD) return "demote";
  return "keep";
}

/**
 * The most this card could be worth at the first enabled condition: its quoted price, or the high end of the range over
 * the printings it could still be. Null when it has no price at all.
 */
export function priceHighOf(card, choice, enabledConditions = ["NM"]) {
  const quote = quotedPrice(card, choice, enabledConditions);
  if (quote) return quote.price;
  const condition = enabledConditions?.[0] || "NM";
  const range = !isSetConfirmed(card) ? rowRange(card, condition) : setRangeOf([card], [condition]);
  return range ? range.high : null;
}

/**
 * A picture-confirmed card that the stakes rule may demote: named by the picture, not read from the printed number,
 * not "high", not confirmed by the title line, and not already an answer of the user's or of this rule.
 */
export function isDemotable(card) {
  if (!card || card.cardBack || card.abstain || !(card.identity?.name || card.identity?.id)) return false;
  if (card.userConfirmed || card.autoConfirmed || card.titleConfirmed || card.numberRead) return false;
  return confTier(card.confidence) !== "high";
}

/**
 * The CHOOSE card became a confirmed one: built like a pick (the candidate's identity and price, no other sets, set
 * settled) but marked autoConfirmed, not userConfirmed. Its candidates stay, so "Wrong card?" works as on any row.
 * resp is the priceCard answer for the candidate.
 */
export function promoteCard(card, resp) {
  const next = {
    ...card,
    identity: resp.identity,
    market_price: resp.market_price,
    price_variant: resp.price_variant,
    price_grid: resp.price_grid,
    setChoices: [],
    setConfirmed: true,
    bestGuess: undefined,
    abstain: false,
    confidence: BELOW_HIGH_CONFIDENCE,
    autoConfirmed: true,
    pricing: false,
    priceError: null,
  };
  delete next.unsure;
  delete next.valueCheck;
  return next;
}

/**
 * The confirmed card became a CHOOSE card: unsure, flagged valueCheck, its own card preselected among its candidates.
 */
export function demoteCard(card) {
  const own = card.identity || {};
  const list = card.candidates || [];
  const at = list.findIndex((c) => (own.id && c.id === own.id));
  const byName = at >= 0 ? at : list.findIndex((c) => own.name && choiceName(c.name) === choiceName(own.name));
  const first = byName >= 0 ? list[byName] : own.id ? { ...own } : null;
  const rest = byName >= 0 ? list.filter((_, i) => i !== byName) : list;
  return {
    ...card,
    candidates: first ? [first, ...rest] : rest,
    unsure: true,
    valueCheck: true,
    setConfirmed: false,
    confidence: Math.min(card.confidence ?? 0, SMALL_SOURCE_CONFIDENCE_CAP),
  };
}
