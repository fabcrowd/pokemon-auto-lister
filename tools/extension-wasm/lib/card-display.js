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

// More than one possible set means the user has to pick before we quote, unless the scanner has made a
// best guess: that row is quoted like a settled one and marked until the user confirms or changes it.
export function isSetConfirmed(card) {
  return (card?.setChoices?.length || 0) <= 1 || card?.setConfirmed === true || Boolean(card?.bestGuess);
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
 * card (number, symbol, stamp) has settled it, and no printing is guessed. Shown as identified with a price range and a
 * "Pick printing" menu. A card with a guessed printing keeps that printing's price and the "Set?" menu.
 */
export function needsPrinting(card) {
  if (!isIdentified(card) || card.setConfirmed === true || card.bestGuess) return false;
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

// A range that already exists on the row for the condition being shown, or null.
function rowRange(card, condition) {
  const range = card?.setRange;
  if (!(range?.high > 0)) return null;
  return range.byCondition?.[condition] ?? (condition === 'NM' || !range.byCondition ? range : null);
}

/**
 * What the whole lot could be worth, for one condition: a confirmed price counts at both ends, a name whose
 * set or printing is still open counts as its price range, and everything else (a guess, an unrecognised
 * card, a card with no price) counts $0 until the user picks. Card backs are not cards and are left out.
 */
export function lotEstimate(cards, choiceFor, enabledConditions = ['NM']) {
  const condition = enabledConditions?.[0] || 'NM';
  const out = { low: 0, high: 0, identified: 0, total: 0, toIdentify: 0 };
  for (const card of cards || []) {
    if (card?.cardBack) continue;
    out.total += 1;
    const named = Boolean(card?.identity?.name || card?.identity?.id);
    if (!named || isOnlyAGuess(card)) {
      out.toIdentify += 1;
      continue;
    }
    out.identified += 1;
    const choice = choiceFor(card);
    const quote = quotedPrice(card, choice, enabledConditions);
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

/**
 * The scanner's top guess for a card it could not name: the closest catalog card, shown as a question with its price
 * so a whole lot can be priced at a glance. Null for a named card, a card back, or a card with no candidates.
 * It never names the card: identity, confidence and "identified" stay as they were.
 */
export function topGuessOf(card) {
  if (!card || card.cardBack || card.identity?.name || card.identity?.id) return null;
  const top = card.candidates?.[0];
  if (!top?.id || !top.name) return null;
  return { id: top.id, name: top.name, set: top.set || null, setCode: top.setCode || null, number: top.number || null };
}

/** Under this many pixels the reader saw so little of the card that its guess is a long shot (shown as a note). */
export const SMALL_READ_PX = 150;
export function readFromSmallCrop(card) {
  return card?.readHeight > 0 && card.readHeight < SMALL_READ_PX;
}

/** The price a guess counts at: a named card's own quote, else its top guess's price; null when there is none. */
export function guessPrice(card, choice, enabledConditions = ['NM']) {
  if (!card || card.cardBack) return null;
  if (card.identity?.name || card.identity?.id) {
    const quote = quotedPrice(card, choice, enabledConditions);
    if (quote) return quote.price;
    if (typeof card.market_price === 'number' && card.market_price > 0) return card.market_price;
    return card.setRange?.low > 0 ? card.setRange.low : null;
  }
  const price = card.topGuess?.price;
  return typeof price === 'number' && price > 0 ? price : null;
}

/**
 * The lot in three figures: what the identified cards are worth (lotEstimate, a range while a printing is open), what
 * the guesses would add if they are right, and the two together. Card backs are left out.
 */
// A guess priced above this is more likely a rare look-alike than the card: it is listed to check, not added.
export const GUESS_TOTAL_CAP = 50;

export function lotTotals(cards, choiceFor, enabledConditions = ['NM']) {
  const sure = lotEstimate(cards, choiceFor, enabledConditions);
  let guess = 0;
  let guessed = 0;
  let toCheck = 0;
  for (const card of cards || []) {
    if (!card || card.cardBack || isIdentified(card)) continue;
    const price = guessPrice(card, choiceFor(card), enabledConditions);
    if (price == null) continue;
    if (price > GUESS_TOTAL_CAP) {
      toCheck += 1;
      continue;
    }
    guess += price;
    guessed += 1;
  }
  return { sure, guess, guessed, toCheck, low: sure.low + guess, high: sure.high + guess };
}
