// What the popup and page overlay are allowed to show as a price.
// A price is never chosen for something the extension does not know: an unconfirmed card has no price, and a card
// with several printings is a range until the user picks one (or confirms the printing the picture suggests).

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

/**
 * The printing settled by something the camera cannot fool: a finish read from the printed collector number or
 * the catalog (`finishSure`, set by the scanner). Null when the user has to pick or confirm one.
 */
export function detectedVariant(card) {
  const finish = card?.finishSure;
  if (!finish) return null;
  return variantChoice({ edition: null, finish, stamp: null }, card.price_grid?.variants).key;
}

/**
 * The printing the picture suggests (variant model, 1st Edition stamp template, drop shadow), or null. Glare can
 * fake a holo or hide a reverse, so this only preselects the menu: it never prices until the user confirms it.
 */
export function suggestedVariant(card) {
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

const EDITION_ROW = /^(1stEdition|shadowless)/i;
const FINISH_SUFFIX = { holofoil: 'Holofoil', reverse: 'ReverseHolofoil', normal: 'Normal' };

/** The lot-level edition choices, in the order the popup offers them. */
export const LOT_EDITIONS = [
  { id: 'unlimited', label: 'Unlimited' },
  { id: 'shadowless', label: 'Shadowless' },
  { id: 'first', label: '1st Edition' },
];

/**
 * A named, settled card whose finish was read from the printed number or catalog but whose grid also has
 * 1stEdition / Shadowless rows: the finish is known, the edition is not, so the row stays a range until one is chosen.
 */
export function needsEdition(card) {
  if (!card?.finishSure || !isIdentified(card) || !isSetConfirmed(card)) return false;
  return listPrintings(card.price_grid).some((name) => EDITION_ROW.test(name));
}

/** The grid row for a card's number-read finish in the given lot edition, or null when the grid has no such row. */
export function editionVariant(card, edition) {
  const suffix = FINISH_SUFFIX[card?.finishSure];
  if (!suffix) return null;
  const names = listPrintings(card.price_grid);
  const prefix = { first: '1stEdition', shadowless: 'shadowless', unlimited: 'unlimited' }[edition];
  if (!prefix) return null;
  const want = prefix.toLowerCase() + suffix.toLowerCase();
  const bare = edition === 'unlimited' && card.finishSure === 'normal' ? prefix : null;
  return names.find((name) => name.toLowerCase() === want || name === bare) ?? null;
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

const RANGE_CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];

// One condition for every candidate, so a range never mixes an NM price with another printing's played copy.
// A printing with no grid at all falls back to its legacy market price, which is a near-mint figure.
function pricesAt(item, condition) {
  const variants = Object.values(item?.price_grid?.variants || {});
  if (variants.length) return variants.map((v) => v?.conditions?.[condition]).filter((v) => typeof v === 'number' && v > 0);
  return condition === 'NM' && typeof item?.market_price === 'number' && item.market_price > 0 ? [item.market_price] : [];
}

/**
 * Lowest to highest price over the printings a name could be at the first enabled condition (NM by default).
 * `count` printings had that price out of `total` considered; null when none did.
 */
export function setRangeOf(items, enabledConditions = ['NM']) {
  const list = items || [];
  const condition = enabledConditions?.[0] || 'NM';
  const priced = list.map((item) => pricesAt(item, condition)).filter((prices) => prices.length);
  if (!priced.length) return null;
  const flat = priced.flat();
  return { low: Math.min(...flat), high: Math.max(...flat), count: priced.length, total: list.length };
}

/** setRangeOf at every condition, so the popup can word it for whichever conditions are switched on. */
export function setRangeSummary(items) {
  const byCondition = {};
  for (const condition of RANGE_CONDITIONS) {
    const range = setRangeOf(items, [condition]);
    if (range) byCondition[condition] = range;
  }
  const lead = byCondition.NM ?? Object.values(byCondition)[0];
  return lead ? { ...lead, byCondition } : null;
}

const priceSpan = (range) => (range.low === range.high ? formatUsd(range.high) : `${formatUsd(range.low)}–${formatUsd(range.high)}`);

const rangeAt = (range, enabledConditions) => (enabledConditions && range?.byCondition ? range.byCondition[enabledConditions[0] || 'NM'] : range);

/** "$4.00–$20.00" (or one price) for a set range at the first enabled condition; null when it has none. */
export function setRangeSpan(range, enabledConditions = null) {
  const shown = rangeAt(range, enabledConditions);
  return shown ? priceSpan(shown) : null;
}

export function setRangeNote(range, enabledConditions = null) {
  const shown = rangeAt(range, enabledConditions);
  if (!shown) return null;
  const total = shown.total ?? shown.count;
  const sets = total > shown.count
    ? `${shown.count} of ${total} ${plural(total, 'set', 'sets')} priced`
    : `${shown.count} ${plural(shown.count, 'set', 'sets')}`;
  return `${sets} · ${priceSpan(shown)}`;
}

/** "Pikachu ex · Surging Sparks #57 · $30.00": another version of the card, with its own price when it has one. */
export function versionLabel(entry, enabledConditions = ['NM']) {
  const open = (entry?.setChoices?.length || 0) > 1;
  const where = open ? '' : [entry?.set || entry?.setCode, entry?.number ? '#' + entry.number : ''].filter(Boolean).join(' ');
  const range = open ? setRangeNote(entry.setRange, enabledConditions) : (() => {
    const own = setRangeOf([entry], enabledConditions);
    return own ? priceSpan(own) : '';
  })();
  return [entry?.name, where, range].filter(Boolean).join(' · ');
}

const OWN_STATE = ['market_price', 'price_variant', 'price_grid', 'setChoices', 'setRange', 'setConfirmed', 'priceError'];

/** A version offered for the row, carrying everything needed to show it again: its identity, price and set state. */
function snapshotOf(card) {
  const identity = card.identity || {};
  return {
    ...identity,
    id: identity.id || card.openVersionId || `keep:${identity.name || ''}`,
    market_price: card.market_price ?? null,
    price_variant: card.price_variant ?? null,
    price_grid: card.price_grid ?? null,
    setChoices: card.setChoices,
    ...(card.setRange ? { setRange: card.setRange } : {}),
    ...(card.setConfirmed !== undefined ? { setConfirmed: card.setConfirmed } : {}),
    ...(card.priceError ? { priceError: card.priceError } : {}),
  };
}

/**
 * The row re-read as another version it offered. A version knows its own set state: one printed in several
 * sets stays set-unconfirmed, with its range and Set? menu, and one printed once is priced. The row it was
 * becomes one of the choices exactly as it stood, so swapping back restores it. Confidence is untouched.
 * Returns the same object when the id is not on offer.
 */
export function swapVersion(card, id) {
  const choices = card?.versionChoices || [];
  const entry = choices.find((c) => c?.id === id);
  if (!entry) return card;
  const identity = { ...entry };
  for (const key of OWN_STATE) delete identity[key];
  const open = (entry.setChoices?.length || 0) > 1 && entry.setConfirmed !== true;
  const rest = { ...card };
  for (const key of ['setRange', 'setConfirmed', 'setChoices', 'openVersionId']) delete rest[key];
  return {
    ...rest,
    identity: open ? { name: entry.name } : identity,
    market_price: open ? null : entry.market_price ?? null,
    price_variant: open ? null : entry.price_variant ?? null,
    price_grid: open ? null : entry.price_grid ?? null,
    setChoices: 'setChoices' in entry ? entry.setChoices : (card.setChoices ? [] : card.setChoices),
    ...(open ? { openVersionId: entry.id } : {}),
    ...(entry.setRange ? { setRange: entry.setRange } : {}),
    ...(entry.setConfirmed !== undefined ? { setConfirmed: entry.setConfirmed } : {}),
    versionChoices: [snapshotOf(card), ...choices.filter((c) => c !== entry)],
    pricing: false,
    priceError: open ? null : entry.priceError ?? null,
  };
}

const hasSetRange = (card) => card?.setRange?.high > 0;

// A best guess from the picture, or borrowed from the page's other cards, is not evidence about this card: only a
// page heading that names the set lets a guessed set be quoted, marked until the user confirms it.
const isPageGuess = (card) => card?.bestGuess?.source === 'hint';

// More than one possible set means the user has to pick before we quote, unless the page itself names the set.
export function isSetConfirmed(card) {
  return (card?.setChoices?.length || 0) <= 1 || card?.setConfirmed === true || isPageGuess(card);
}

/** The user accepted the guessed printing: it stops being a guess, and the Set? menu stays. */
export function confirmGuess(card) {
  if (!card?.bestGuess) return card;
  const next = { ...card, setConfirmed: true };
  delete next.bestGuess;
  return next;
}

/** The scanner is guessing: it abstained, the set is open with nothing to show for it, or confidence is low. */
export function isUnsure(card) {
  if (!card || card.cardBack || card.setConfirmed === true) return false;
  return card.unsure === true
    || Boolean(card.abstain)
    || ((card.setChoices?.length || 0) > 1 && !hasSetRange(card) && !card.bestGuess)
    || confTier(card.confidence) === 'low';
}

/** A card the scanner named, is not guessing about, and whose set is settled. */
export function isIdentified(card) {
  if (!card || card.cardBack) return false;
  return Boolean(card.identity?.name || card.identity?.id) && !isUnsure(card) && (isSetConfirmed(card) || hasSetRange(card));
}

/** True when the scan read more than one photo of a listing (its gallery). */
export function fromSeveralPhotos(cards) {
  return (cards || []).some((card) => card?.photo > 1 || card?.photos?.length > 1);
}

/** Which listing photo a card was read from: "Photo 3", or "Photos 1, 3" when it was seen in more than one. */
export function photoLabel(card) {
  const seen = Array.isArray(card?.photos) && card.photos.length > 1 ? card.photos : null;
  if (seen) return `Photos ${seen.join(", ")}`;
  return card?.photo > 0 ? `Photo ${card.photo}` : "";
}

/**
 * Named for sure, but which printing is still the user's call: several sets print the same art and nothing on the
 * card (number, symbol, stamp) has settled it, and no printing is guessed from the page's words. Shown as identified
 * with a price range and a "Pick printing" menu (a picture-only guess preselects it). A printing guessed from the
 * page keeps that printing's price and the "Set?" menu.
 */
export function needsPrinting(card) {
  if (!isIdentified(card) || card.setConfirmed === true || isPageGuess(card)) return false;
  return (card.setChoices?.length || 0) > 1;
}

/**
 * identified: named and settled. pick: the user is asked "Which card is this?", with the closest matches
 * when there are any. unrecognised: only a card back, which is not a card to identify.
 */
export function classifyCard(card) {
  if (isIdentified(card)) return 'identified';
  if (card?.cardBack) return 'unrecognised';
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

/** "Found 15 cards: 2 identified (1 to pick printing), 13 need your pick". Empty when nothing was found. */
export function scanStatus(cards) {
  const list = cards || [];
  if (list.length === 0) return '';
  const counts = { identified: 0, pick: 0, unrecognised: 0 };
  let printing = 0;
  for (const card of list) {
    counts[classifyCard(card)] += 1;
    if (needsPrinting(card)) printing += 1;
  }
  const parts = [
    counts.identified ? `${counts.identified} identified${printing ? ` (${printing} to pick printing)` : ''}` : '',
    counts.pick ? `${counts.pick} ${plural(counts.pick, 'needs', 'need')} your pick` : '',
    counts.unrecognised ? `${counts.unrecognised} not recognised` : '',
  ].filter(Boolean);
  return `Found ${list.length} ${plural(list.length, 'card', 'cards')}: ${parts.join(', ')}`;
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

// A range that already exists on the row for the condition being shown, or null.
function rowRange(card, condition) {
  const range = card?.setRange;
  if (!(range?.high > 0)) return null;
  return range.byCondition?.[condition] ?? (condition === 'NM' || !range.byCondition ? range : null);
}

// A price that stays out of the totals: it came from an old fallback grid.
const isStale = (card) => card?.price_grid?.stale === true;

/**
 * What the whole lot could be worth, for one condition: a confirmed price counts at both ends, a name whose
 * set or printing is still open counts as its price range, and everything else (a guess, an unrecognised
 * card, a card with no price) counts $0 and is counted in `toIdentify` (cards still to confirm) until the user
 * picks. A price from an old fallback grid is counted in `toCheck`. Card backs are left out.
 */
export function lotEstimate(cards, choiceFor, enabledConditions = ['NM']) {
  const condition = enabledConditions?.[0] || 'NM';
  const out = { low: 0, high: 0, identified: 0, total: 0, toIdentify: 0, toCheck: 0 };
  for (const card of cards || []) {
    if (card?.cardBack) continue;
    out.total += 1;
    if (!isIdentified(card)) {
      out.toIdentify += 1;
      continue;
    }
    if (isStale(card)) {
      out.toCheck += 1;
      continue;
    }
    const quote = quotedPrice(card, choiceFor(card), enabledConditions);
    out.identified += 1;
    if (quote) {
      out.low += quote.price;
      out.high += quote.price;
      continue;
    }
    const range = !isSetConfirmed(card) ? rowRange(card, condition) : setRangeOf([card], [condition]);
    if (range) {
      out.low += range.low;
      out.high += range.high;
    }
  }
  return out;
}

/** The lot's value as "$12.50" or "$14.00–$30.00", with the "2 of 3 cards identified" detail; value is null while no card is identified. */
export function lotValue(cards, choiceFor, enabledConditions = ['NM']) {
  const lot = lotEstimate(cards, choiceFor, enabledConditions);
  if (lot.total === 0) return { value: null, detail: '' };
  const pick = lot.toIdentify ? ` · ${lot.toIdentify} still to identify` : '';
  return { value: lot.identified ? priceSpan(lot) : null, detail: `${lot.identified} of ${lot.total} cards identified${pick}` };
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

/** Under this many pixels the reader saw so little of the card that its guess is a long shot (shown as a note). */
export const SMALL_READ_PX = 150;
export function readFromSmallCrop(card) {
  return card?.readHeight > 0 && card.readHeight < SMALL_READ_PX;
}

/** Whole days since the grid's own date when it is a stale fallback grid, else null. */
export function staleDays(grid, now = Date.now()) {
  if (grid?.stale !== true) return null;
  const stamp = Date.parse(grid.updatedAt || '');
  return Number.isFinite(stamp) ? Math.floor((now - stamp) / DAY_MS) : null;
}
