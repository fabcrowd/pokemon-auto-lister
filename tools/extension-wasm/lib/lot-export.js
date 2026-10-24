// The confirmed lot as rows a seller can paste into a sheet or open in Excel. Pure: popup.js owns the clipboard
// and the download. Only cards the lot total counts as "Confirmed value" are included (named, settled, not an old price), so
// the file equals the screen. No page address, image or seller data is ever part of a row.

import { chosenPrintingHasNoPrice, isIdentified, isSetConfirmed, isStale, listPrintings, quotedPrice, rowRange, setRangeOf, sourceName } from './card-display.js';
import { formatPrinting } from './option-strip.js';
import { skipNote } from './skip.js';

export const LOT_COLUMNS = [
  'Name', 'Set', 'Number', 'Printing', 'Finish', 'Condition', 'Qty', 'Price', 'Low', 'High',
  'Price source', 'Price date', 'Price age days', 'Basis',
];

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = 'open';
const CONDITION_NAMES = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
};

export function conditionName(condition) {
  return CONDITION_NAMES[condition] || String(condition);
}

const money = (amount) => (typeof amount === 'number' && Number.isFinite(amount) ? amount.toFixed(2) : '');

function finishOf(printing) {
  if (!printing) return '';
  if (/reverse/i.test(printing)) return 'Reverse Holo';
  if (/holo/i.test(printing)) return 'Holofoil';
  return 'Normal';
}

function priceAge(updatedAt, now) {
  const stamp = Date.parse(updatedAt || '');
  if (!Number.isFinite(stamp) || stamp > now) return { date: '', days: '' };
  return { date: new Date(stamp).toISOString().slice(0, 10), days: Math.floor((now - stamp) / DAY_MS) };
}

// Priced at one condition, or an open printing priced as a range, or neither (counted, no figures).
function priceOf(card, choice, conditions) {
  const active = conditions?.[0] || 'NM';
  const quote = quotedPrice(card, choice, conditions);
  if (quote) return { condition: quote.condition || 'NM', printing: quote.printing, price: quote.price, low: quote.price, high: quote.price };
  if (chosenPrintingHasNoPrice(card, choice, conditions)) return { condition: active, printing: choice, price: null, low: null, high: null };
  const range = !isSetConfirmed(card) ? rowRange(card, active) : setRangeOf([card], [active]);
  const names = listPrintings(card.price_grid);
  const open = names.length > 1 || (!isSetConfirmed(card) && Boolean(range));
  return { condition: active, printing: open ? OPEN : names[0] || null, price: null, low: range?.low ?? null, high: range?.high ?? null };
}

/**
 * One row per distinct confirmed card + printing + condition, with Qty. `count` is the cards in the file (sum of
 * Qty); `notIncluded` is every other real card (still to confirm, or priced from an old grid); `skipped` is the cards
 * the user skipped, which are neither in the file nor still to confirm.
 */
export function lotExportRows(cards, choiceFor, enabledConditions = ['NM'], now = Date.now()) {
  const merged = new Map();
  let notIncluded = 0;
  let skipped = 0;
  for (const card of cards || []) {
    if (card?.skipped === true) { skipped += 1; continue; }
    if (card?.cardBack) continue;
    if (!isIdentified(card) || isStale(card, now)) { notIncluded += 1; continue; }
    const found = priceOf(card, choiceFor(card), enabledConditions);
    const identity = card.identity || {};
    const who = identity.id || [identity.name, identity.set, identity.number].join('|');
    const key = [who, found.printing ?? '', found.condition].join('\u0000');
    const seen = merged.get(key);
    if (seen) { seen[6] += 1; continue; }
    const named = found.printing && found.printing !== OPEN ? formatPrinting(found.printing) : found.printing || '';
    const age = priceAge(card.price_grid?.updatedAt, now);
    const basis = `raw, English, ${conditionName(found.condition)}`;
    merged.set(key, [
      identity.name || '', identity.set || '', identity.number || '', named,
      found.printing === OPEN ? '' : finishOf(found.printing), found.condition, 1,
      money(found.price), money(found.low), money(found.high),
      sourceName(card.price_grid) || '', age.date, age.days, basis,
    ]);
  }
  const rows = [...merged.values()];
  return { rows, count: rows.reduce((sum, row) => sum + row[6], 0), notIncluded, skipped };
}

// A spreadsheet runs a cell that starts with one of these as a formula, so it is made plain text.
const FORMULA_START = /^[=+\-@\t\r]/;
const guard = (cell) => { const text = String(cell ?? ''); return FORMULA_START.test(text) ? `'${text}` : text; };

const csvCell = (cell) => {
  const text = guard(cell);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const tsvCell = (cell) => guard(cell).replace(/[\t\r\n]+/g, ' ');

/** RFC 4180: CRLF line endings, a closing CRLF, quotes doubled. The caller adds the BOM for Excel. */
export function lotToCsv(rows) {
  return [LOT_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Tab separated with the same header, for pasting straight into a sheet. */
export function lotToTsv(rows) {
  return [LOT_COLUMNS, ...rows].map((row) => row.map(tsvCell).join('\t')).join('\n') + '\n';
}

/** card-lot-YYYY-MM-DD.csv, from the local date. */
export function lotFileName(date = new Date()) {
  const part = (n) => String(n).padStart(2, '0');
  return `card-lot-${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}.csv`;
}

export const CONDITION_TIP = 'Prices are Near Mint market prices unless your price-service key provides other conditions';

const cardsOf = (n) => `${n} ${n === 1 ? 'card' : 'cards'}`;

/** Button names, the tooltip naming what is left out, and the copy message. Null when nothing is confirmed. */
export function lotExportLabels(count, notIncluded, skipped = 0) {
  if (!(count > 0)) return null;
  const left = notIncluded === 1
    ? '1 more card still needs confirming and is not included'
    : notIncluded > 1 ? `${notIncluded} more cards still need confirming and are not included`
      : skipped > 0 ? 'Every card you are pricing is confirmed' : 'Every card in the lot is confirmed';
  const tip = skipped > 0 ? `${left}. ${skipNote(skipped)}` : left;
  return { copy: `Copy ${count} confirmed`, csv: `Download CSV (${count})`, tip, copied: `Copied ${cardsOf(count)}` };
}
