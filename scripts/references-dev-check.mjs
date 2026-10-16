// Leave-one-out check of reference memory on your own corrections. Prints counts only.
//
//   node scripts/references-dev-check.mjs <corrections-export.json> [--min 0.93] [--margin 0.02]
//
// Export from the extension settings page, under Corrections. Only corrections saved after models were
// loaded carry an embedding. Choose REFERENCE_MIN and REFERENCE_MARGIN from this output, never from sealed scores.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REFERENCE_MARGIN, REFERENCE_MIN } from '../tools/extension-wasm/lib/references.js';
import { gridReport, itemsFromExport, leaveOneOut, summarizeAt } from './lib/references-loo.mjs';
import { isInside } from './lib/sealed-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const file = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));
const min = flag('min', REFERENCE_MIN);
const margin = flag('margin', REFERENCE_MARGIN);

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!file) fail('Usage: node scripts/references-dev-check.mjs <corrections-export.json> [--min x --margin y]');
if (!Number.isFinite(min) || !Number.isFinite(margin)) fail('--min and --margin must be numbers.');
if (isInside(path.join(root, 'data', 'sealed-test'), file)) fail('This tool never reads the sealed test set.');

let items;
let skipped;
let withoutCatalogTop;
try {
  ({ items, skipped, withoutCatalogTop } = itemsFromExport(JSON.parse(fs.readFileSync(file, 'utf8'))));
} catch (err) {
  fail(err instanceof SyntaxError ? 'That file is not JSON.' : err.message);
}

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const describe = (s) => (s.interval
  ? `fired ${s.fired} of ${s.total}; right card ${s.correct} of ${s.fired} = ${percent(s.interval.p)}  95% ${percent(s.interval.lo)} to ${percent(s.interval.hi)}`
  : `fired 0 of ${s.total}`);

console.log(`Corrections with an embedding: ${items.length} (${skipped} without one are left out).`);
const rows = leaveOneOut(items);
if (rows.length === 0) fail('Need at least two corrections with embeddings.');

console.log(`At min ${min}, margin ${margin}: ${describe(summarizeAt(rows, { min, margin }))}`);
console.log(`\nBy min (margin ${margin}):`);
for (const g of gridReport(rows, { margin })) console.log(`  min ${g.min.toFixed(2)}  ${describe(g)}`);
console.log(`\nCorrections saved without the catalog's top score: ${withoutCatalogTop} of ${items.length}. For those the margin is not applied.`);
console.log('Neighbours from the same scan are left out. These counts are an upper bound for REFERENCE_MIN: they ignore whether the corrected card was in the catalog top 20.');
if (withoutCatalogTop > 0) console.log('They cannot set REFERENCE_MARGIN until every correction has a catalog score (saved with corrections from this version on).');
