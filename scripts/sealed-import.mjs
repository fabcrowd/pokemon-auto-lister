// Move photos from the extension's "Test photos" export into the sealed test set.
//
//   node scripts/sealed-import.mjs <export.json> [--dir data/sealed-test]
//
// Photos that match training data are dropped. Only totals are printed.
import fs from 'node:fs/promises';
import path from 'node:path';

import { importSealed, readExport } from './lib/sealed-import.mjs';
import { loadTrainingHashes, trainingFolders, trainingRoots } from './lib/training-hashes.mjs';
import { trainingKeysFrom } from './lib/training-match.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const exportFile = args.find((arg, at) => !arg.startsWith('--') && args[at - 1] !== '--dir');
if (!exportFile) {
  console.error('usage: node scripts/sealed-import.mjs <export.json> [--dir data/sealed-test]');
  process.exit(2);
}

const data = path.resolve('data');
const dir = path.resolve(flag('dir', path.join('data', 'sealed-test')));

let exported;
try {
  exported = await readExport(path.resolve(exportFile));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const manifestLines = await fs.readFile(path.join(data, 'variant-photos', 'manifest.jsonl'), 'utf8')
  .then((text) => text.split('\n'), () => []);
const roots = await trainingRoots(data);
const { hashes, hashed, counts: rootCounts } = await loadTrainingHashes({
  roots: roots.dirs,
  files: roots.files,
  cachePath: path.join(data, 'variant-photos', 'dhash-cache.json'),
  base: data,
});

const counts = await importSealed({
  photos: exported.photos,
  dir,
  trainingHashes: hashes,
  trainingKeys: trainingKeysFrom({ manifestLines, folders: await trainingFolders(data) }),
});

console.log(`training hashes: ${hashes.length} (${hashed} new)`);
console.log(`training roots covered: ${Object.entries(rootCounts).map(([name, n]) => `${name} ${n}`).join(', ')}`);
console.log(`imported: ${counts.imported}`);
console.log(`duplicate-of-training: ${counts.duplicateOfTraining}`);
console.log(`duplicate-of-sealed: ${counts.duplicateOfSealed}`);
console.log(`url-in-training: ${counts.urlInTraining}`);
if (counts.invalid) console.log(`skipped (not a JPEG with boxes): ${counts.invalid}`);
