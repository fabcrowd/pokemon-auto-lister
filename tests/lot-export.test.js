import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOT_COLUMNS,
  lotExportRows,
  lotToCsv,
  lotToTsv,
  lotFileName,
  conditionName,
  lotExportLabels,
  CONDITION_TIP,
} from '../tools/extension-wasm/lib/lot-export.js';
import { fromTcgdexPayload } from '../tools/extension-wasm/lib/condition-pricing.js';
import { lotEstimate } from '../tools/extension-wasm/lib/card-display.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const none = () => null;

const grid = (variants, extra = {}) => ({ source: 'pokemontcg', updatedAt: '2026-10-20T00:00:00.000Z', variants, ...extra });
const nm = (price) => ({ market: price, conditions: { NM: price, LP: price * 0.8 } });

const card = (over = {}) => ({
  identity: { id: 'base1-58', name: 'Pikachu', set: 'Base', setCode: 'base1', number: '58' },
  confidence: 0.9,
  abstain: false,
  price_grid: grid({ normal: nm(5) }),
  ...over,
});

const rows = (cards, choiceFor = none, conds = ['NM']) => lotExportRows(cards, choiceFor, conds, NOW);
const col = (name) => LOT_COLUMNS.indexOf(name);

test('columns are in the agreed order', () => {
  assert.deepEqual(LOT_COLUMNS, [
    'Name', 'Set', 'Number', 'Printing', 'Finish', 'Condition', 'Qty', 'Price', 'Low', 'High',
    'Price source', 'Price date', 'Price age days', 'Basis',
  ]);
});

test('an empty lot has no rows and no count', () => {
  const out = rows([]);
  assert.deepEqual(out.rows, []);
  assert.equal(out.count, 0);
  assert.equal(out.notIncluded, 0);
});

test('a confirmed single-printing card becomes one row with the quoted price', () => {
  const out = rows([card()]);
  assert.equal(out.count, 1);
  const [r] = out.rows;
  assert.equal(r[col('Name')], 'Pikachu');
  assert.equal(r[col('Set')], 'Base');
  assert.equal(r[col('Number')], '58');
  assert.equal(r[col('Printing')], 'Normal');
  assert.equal(r[col('Finish')], 'Normal');
  assert.equal(r[col('Condition')], 'NM');
  assert.equal(r[col('Qty')], 1);
  assert.equal(r[col('Price')], '5.00');
  assert.equal(r[col('Low')], '5.00');
  assert.equal(r[col('High')], '5.00');
  assert.equal(r[col('Price source')], 'TCGPlayer');
  assert.equal(r[col('Price date')], '2026-10-20');
  assert.equal(r[col('Price age days')], 3);
  assert.equal(r[col('Basis')], 'raw, English, Near Mint');
});

test('only confirmed cards are exported; the rest are counted as not included', () => {
  const guess = { identity: null, confidence: 0.3, abstain: true, candidates: [{ id: 'a', name: 'Mew' }] };
  const back = { cardBack: true };
  const out = rows([card(), guess, back, { identity: null, abstain: true }]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.count, 1);
  assert.equal(out.notIncluded, 2);
});

test('a valueCheck (demoted) card is not exported', () => {
  const demoted = card({ unsure: true, valueCheck: true, setConfirmed: false });
  const out = rows([card(), demoted]);
  assert.equal(out.count, 1);
  assert.equal(out.notIncluded, 1);
});

test('a stale-grid card is excluded exactly as the lot total excludes it', () => {
  // Built by the real TCGdex grid builder, 661 days old: no hand-set flag.
  const old = fromTcgdexPayload(
    { name: 'Mew', localId: '9', set: { id: 'x' }, pricing: { tcgplayer: { updated: '2025-01-01T00:00:00.000Z', normal: { marketPrice: 9 } } } },
    { name: 'Mew', setCode: 'x', number: '9' },
  );
  const stale = card({ identity: { id: 'x-2', name: 'Mew' }, price_grid: old });
  const cards = [card(), stale];
  const out = rows(cards);
  assert.equal(out.count, 1);
  assert.equal(out.notIncluded, 1);
  const lot = lotEstimate(cards, none, ['NM'], NOW);
  assert.equal(out.count, lot.identified);
  assert.equal(out.notIncluded, lot.toIdentify + lot.toCheck);
});

test('the file equals the screen: the priced rows sum to the Sure total', () => {
  const holo = card({ identity: { id: 'y-1', name: 'Eevee', set: 'Jungle', number: '51' }, price_grid: grid({ normal: nm(2), holofoil: nm(10) }) });
  const cards = [card(), card(), holo];
  const choiceFor = (c) => (c === holo ? 'holofoil' : null);
  const out = rows(cards, choiceFor);
  const sum = out.rows.reduce((acc, r) => acc + Number(r[col('Price')]) * r[col('Qty')], 0);
  assert.equal(sum, lotEstimate(cards, choiceFor, ['NM'], NOW).high);
});

test('the same card, printing and condition merge into one row with Qty', () => {
  const out = rows([card(), card(), card()]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0][col('Qty')], 3);
  assert.equal(out.count, 3);
});

test('different printings of the same card do not merge', () => {
  const g = grid({ normal: nm(2), holofoil: nm(10) });
  const a = card({ price_grid: g });
  const b = card({ price_grid: g });
  const choiceFor = (c) => (c === a ? 'normal' : 'holofoil');
  const out = rows([a, b], choiceFor);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows.map((r) => r[col('Price')]).sort(), ['10.00', '2.00']);
  assert.deepEqual(out.rows.map((r) => r[col('Finish')]).sort(), ['Holofoil', 'Normal']);
});

test('different cards with the same name do not merge', () => {
  const other = card({ identity: { id: 'base2-58', name: 'Pikachu', set: 'Jungle', number: '60' } });
  assert.equal(rows([card(), other]).rows.length, 2);
});

test('an open printing exports Printing "open", a blank Price and the range as Low/High', () => {
  const open = card({ price_grid: grid({ normal: nm(2), holofoil: nm(10) }) });
  const out = rows([open]);
  const [r] = out.rows;
  assert.equal(r[col('Printing')], 'open');
  assert.equal(r[col('Finish')], '');
  assert.equal(r[col('Price')], '');
  assert.equal(r[col('Low')], '2.00');
  assert.equal(r[col('High')], '10.00');
  assert.equal(r[col('Condition')], 'NM');
});

test('two open rows of the same card merge; an open row and a chosen row do not', () => {
  const g = grid({ normal: nm(2), holofoil: nm(10) });
  const a = card({ price_grid: g });
  const b = card({ price_grid: g });
  const c = card({ price_grid: g });
  const choiceFor = (x) => (x === c ? 'holofoil' : null);
  const out = rows([a, b, c], choiceFor);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows.find((r) => r[col('Printing')] === 'open')[col('Qty')], 2);
});

test('the active condition is used and named in Basis; no data at that condition leaves the price blank', () => {
  const out = rows([card()], none, ['LP']);
  const [r] = out.rows;
  assert.equal(r[col('Condition')], 'LP');
  assert.equal(r[col('Price')], '4.00');
  assert.equal(r[col('Basis')], 'raw, English, Lightly Played');
  const noLp = card({ price_grid: grid({ normal: { market: 5, conditions: { NM: 5 } } }) });
  const [q] = rows([noLp], none, ['LP']).rows;
  assert.equal(q[col('Price')], '');
  assert.equal(q[col('Low')], '');
  assert.equal(q[col('High')], '');
});

test('the Basis text never claims graded or Japanese', () => {
  for (const c of ['NM', 'LP', 'MP', 'HP', 'DMG']) {
    assert.doesNotMatch(conditionName(c), /graded|japanese/i);
  }
  const [r] = rows([card()]).rows;
  assert.doesNotMatch(r[col('Basis')], /graded|japanese|psa|bgs/i);
});

test('a grid without a date leaves the date and age blank', () => {
  const [r] = rows([card({ price_grid: { source: 'backend', variants: { normal: nm(5) } } })]).rows;
  assert.equal(r[col('Price date')], '');
  assert.equal(r[col('Price age days')], '');
  assert.equal(r[col('Price source')], 'JustTCG');
});

test('a future or unreadable date is blank, not negative or NaN', () => {
  const future = card({ price_grid: grid({ normal: nm(5) }, { updatedAt: '2027-01-01T00:00:00.000Z' }) });
  const junk = card({ identity: { id: 'j', name: 'Junk' }, price_grid: grid({ normal: nm(5) }, { updatedAt: 'not a date' }) });
  const out = rows([future, junk]);
  for (const r of out.rows) assert.equal(r[col('Price age days')], '');
  assert.equal(out.rows[1][col('Price date')], '');
});

test('the export carries no page url, image or seller data', () => {
  const noisy = card({ pageUrl: 'https://shop.example/x', url: 'https://x', crop: 'data:image/png;base64,AAAA', seller: 'bob', photo: 2 });
  const text = lotToCsv(rows([noisy]).rows);
  assert.doesNotMatch(text, /shop\.example|data:image|bob|https?:/);
});

test('CSV: header first, CRLF endings, RFC 4180 quoting of commas, quotes and newlines', () => {
  const tricky = card({ identity: { id: 't', name: 'Farfetch\'d, "Ash\'s"\nline2', set: 'Base', number: '27' } });
  const csv = lotToCsv(rows([tricky]).rows);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], LOT_COLUMNS.join(','));
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(csv.includes('"Farfetch\'d, ""Ash\'s""\nline2"'));
});

test('CSV and TSV: a cell starting with = + - @ gets a leading apostrophe', () => {
  for (const bad of ['=SUM(A1)', '+1', '-2', '@cmd', '\tTAB', '\rCR']) {
    const c = card({ identity: { id: 'f' + bad, name: bad, set: 'S', number: '1' } });
    const out = rows([c]).rows;
    const csv = lotToCsv(out);
    assert.ok(csv.includes(`'${bad}`) || csv.includes(`"'${bad}`), `csv ${JSON.stringify(bad)}`);
    const tsvLine = lotToTsv(out).split('\n')[1];
    assert.ok(tsvLine.startsWith("'"), `tsv ${JSON.stringify(bad)}`);
  }
});

test('a safe cell is not changed by the injection guard', () => {
  const csv = lotToCsv(rows([card()]).rows);
  assert.ok(csv.includes('Pikachu,Base,58,'));
});

test('TSV: same header, tab separated, tabs and newlines inside a name become spaces', () => {
  const c = card({ identity: { id: 't', name: 'A\tB\nC', set: 'Base', number: '1' } });
  const tsv = lotToTsv(rows([c]).rows);
  const lines = tsv.split('\n').filter(Boolean);
  assert.equal(lines[0], LOT_COLUMNS.join('\t'));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].split('\t')[0], 'A B C');
  assert.equal(lines[1].split('\t').length, LOT_COLUMNS.length);
});

test('an empty lot still produces just the header', () => {
  assert.equal(lotToCsv([]), LOT_COLUMNS.join(',') + '\r\n');
  assert.equal(lotToTsv([]), LOT_COLUMNS.join('\t') + '\n');
});

test('the file name uses the local date, zero padded', () => {
  assert.equal(lotFileName(new Date(2026, 0, 5, 23, 59)), 'card-lot-2026-01-05.csv');
  assert.equal(lotFileName(new Date(2026, 9, 23, 0, 1)), 'card-lot-2026-10-23.csv');
});

test('button labels name the count, the tooltip names what is left out, and nothing shows at 0', () => {
  assert.equal(lotExportLabels(0, 5), null);
  const l = lotExportLabels(3, 2);
  assert.equal(l.copy, 'Copy 3 confirmed');
  assert.equal(l.csv, 'Download CSV (3)');
  assert.equal(l.tip, '2 more cards still need confirming and are not included');
  assert.equal(l.copied, 'Copied 3 cards');
  assert.equal(lotExportLabels(1, 1).tip, '1 more card still needs confirming and is not included');
  assert.equal(lotExportLabels(1, 0).copied, 'Copied 1 card');
  assert.match(CONDITION_TIP, /^Prices are Near Mint market prices unless your price-service key provides other conditions$/);
});
