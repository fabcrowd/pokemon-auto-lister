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

// More than one possible set means the user has to pick before we quote.
export function isSetConfirmed(card) {
  return (card?.setChoices?.length || 0) <= 1 || card?.setConfirmed === true;
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
  if (/models not loaded/i.test(raw)) {
    return 'The card models are still downloading.';
  }
  return raw;
}
