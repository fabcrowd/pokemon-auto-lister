// What the popup and page overlay are allowed to show as a price.
// A card with several printings is not quoted until the user picks one.

import { variantChoice } from './variant.js';

const SOURCE_NAMES = {
  backend: 'JustTCG',
  ppt: 'Price Tracker',
  pokemontcg: 'TCGPlayer',
  tcgdex: 'TCGPlayer',
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function listPrintings(grid) {
  return Object.keys(grid?.variants || {});
}

export function isPrintingConfirmed(grid, choice) {
  const names = listPrintings(grid);
  if (names.length <= 1) return true;
  return typeof choice === 'string' && names.includes(choice);
}

/** Shown when the border says Shadowless, including when that price is not in the grid. */
export function editionNote(card) {
  if (card?.variant?.edition === "shadowless") return "Shadowless border";
  return null;
}

/** The variant the scan saw on the card itself, or null when the user has to pick. */
export function detectedVariant(card) {
  const names = listPrintings(card?.price_grid);
  const seen = card?.variant ? variantChoice(card.variant, card.price_grid?.variants).key : null;
  // No drop shadow can also be blur or glare, so Shadowless is named but not priced.
  if (seen && names.includes(seen) && !/shadowless/i.test(seen)) return seen;
  if (card?.firstEdition === true) return names.find((name) => /^1stEdition/.test(name)) ?? null;
  // A drop shadow means this Base Set card is not Shadowless. Pick Unlimited
  // only when that is the one remaining price.
  if (card?.shadow !== true) return null;
  const rest = names.filter((name) => !/^1stEdition/.test(name));
  return rest.length === 1 ? rest[0] : null;
}

export function marketRange(grid) {
  const values = Object.values(grid?.variants || {})
    .map((variant) => variant?.market)
    .filter((price) => typeof price === 'number' && price > 0);
  if (values.length === 0) return null;
  return { low: Math.min(...values), high: Math.max(...values) };
}

export function formatUsd(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

export function printingNote(grid) {
  const names = listPrintings(grid);
  if (names.length <= 1) return null;
  const range = marketRange(grid);
  if (!range || range.low === range.high) return `${names.length} variants`;
  return `${names.length} variants · ${formatUsd(range.low)}–${formatUsd(range.high)}`;
}

export function ageLabel(updatedAt, now = Date.now()) {
  const timestamp = Date.parse(updatedAt || '');
  if (!Number.isFinite(timestamp)) return null;
  const days = Math.floor((now - timestamp) / DAY_MS);
  if (days < 0) return null;
  return {
    stale: days > 7,
    text: days === 0 ? 'updated today' : `updated ${days}d ago`,
  };
}

export function sourceName(grid) {
  if (!grid?.source) return null;
  return SOURCE_NAMES[grid.source] || grid.source;
}

export function sourceFooter(grid, now = Date.now()) {
  const name = sourceName(grid);
  if (!name) return null;
  const age = ageLabel(grid.updatedAt, now);
  return age ? `${name} · ${age.text}` : name;
}

export function confTier(confidence) {
  if (confidence >= 0.80) return 'high';
  if (confidence >= 0.50) return 'medium';
  return 'low';
}

// More than one possible set means the user has to pick before we quote.
export function isSetConfirmed(card) {
  return (card?.setChoices?.length || 0) <= 1 || card?.setConfirmed === true;
}

/** The scanner is guessing: it abstained, the set is open, or confidence is low. */
export function isUnsure(card) {
  if (!card || card.cardBack || card.setConfirmed === true) return false;
  return card.unsure === true
    || Boolean(card.abstain)
    || (card.setChoices?.length || 0) > 1
    || confTier(card.confidence) === 'low';
}

/** A card the scanner named, is not guessing about, and whose set is settled. */
export function isIdentified(card) {
  if (!card || card.cardBack) return false;
  return Boolean(card.identity?.name || card.identity?.id) && !isUnsure(card) && isSetConfirmed(card);
}

/**
 * identified: named and settled. pick: shown with a "Which card is this?" menu.
 * unrecognised: nothing to name and nothing to offer, so there is nothing to pick from.
 */
export function classifyCard(card) {
  if (isIdentified(card)) return 'identified';
  if (card?.cardBack) return 'unrecognised';
  const named = Boolean(card?.identity?.name || card?.identity?.id);
  if (!named && !(card?.candidates?.length > 0)) return 'unrecognised';
  return 'pick';
}

/** Indexes of the cards for the main list and of those folded into "not recognised". */
export function splitByRecognition(cards) {
  const shown = [];
  const hidden = [];
  (cards || []).forEach((card, index) => {
    (classifyCard(card) === 'unrecognised' ? hidden : shown).push(index);
  });
  return { shown, hidden };
}

const plural = (n, one, many) => (n === 1 ? one : many);

/** "Found 15 cards: 2 identified, 13 need your pick". Empty when nothing was found. */
export function scanStatus(cards) {
  const list = cards || [];
  if (list.length === 0) return '';
  const counts = { identified: 0, pick: 0, unrecognised: 0 };
  for (const card of list) counts[classifyCard(card)] += 1;
  const parts = [
    counts.identified ? `${counts.identified} identified` : '',
    counts.pick ? `${counts.pick} ${plural(counts.pick, 'needs', 'need')} your pick` : '',
    counts.unrecognised ? `${counts.unrecognised} not recognised` : '',
  ].filter(Boolean);
  return `Found ${list.length} ${plural(list.length, 'card', 'cards')}: ${parts.join(', ')}`;
}

// A guess is not part of the total until the user confirms it.
function isOnlyAGuess(card) {
  if (card?.setConfirmed === true) return false;
  return card?.abstain === true
    || card?.unsure === true
    || (Number.isFinite(card?.confidence) && confTier(card.confidence) === 'low');
}

export function quotedPrice(card, choice, enabledConditions = ['NM']) {
  if (!isSetConfirmed(card)) return null;
  const grid = card?.price_grid;
  if (!isPrintingConfirmed(grid, choice)) return null;
  const names = listPrintings(grid);
  const printing = names.length <= 1 ? (names[0] || null) : choice;
  const conditions = grid?.variants?.[printing]?.conditions;
  const order = enabledConditions.length ? enabledConditions : ['NM'];
  if (conditions) {
    for (const condition of order) {
      if (conditions[condition] != null) return { price: conditions[condition], condition, printing };
    }
    return null;
  }
  if (typeof card?.market_price === 'number' && names.length <= 1) {
    return { price: card.market_price, condition: null, printing };
  }
  return null;
}

export function lotTotal(cards, choiceFor, enabledConditions = ['NM']) {
  let total = 0;
  let unconfirmed = 0;
  for (const card of cards || []) {
    if (isOnlyAGuess(card)) continue;
    const choice = choiceFor(card);
    if (!isSetConfirmed(card) || !isPrintingConfirmed(card?.price_grid, choice)) {
      unconfirmed += 1;
      continue;
    }
    const quote = quotedPrice(card, choice, enabledConditions);
    if (quote) total += quote.price;
  }
  return { total, unconfirmed };
}

const MODEL_FILE_LABELS = {
  'clip_visual_int8.onnx': 'card recognition',
  'card_detect.onnx': 'card finder',
  'catalog.bin.gz': 'card catalog',
  'meta.json': 'card names',
  'id_map.json': 'card index',
};

export function modelFileLabel(name) {
  return MODEL_FILE_LABELS[name] || 'model file';
}

export function explainScanError(message) {
  const raw = String(message || '');
  if (/receiving end does not exist|could not establish connection/i.test(raw)) {
    return 'Reload the Card Scanner extension, then try again.';
  }
  // The page can be read only after the user clicks the toolbar icon on it, or if site access was allowed.
  if (/cannot access (contents|a chrome)|must request permission|activetab|<all_urls>/i.test(raw)) {
    return 'Card Scanner cannot read this tab. Click the Card Scanner icon while you are on the page you want to scan.';
  }
  if (/models not loaded/i.test(raw)) {
    return 'The card models are still downloading.';
  }
  return raw;
}
