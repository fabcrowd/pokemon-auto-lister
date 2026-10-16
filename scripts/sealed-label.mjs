// Label the sealed test photos by hand. The scanner never runs here.
//
//   node scripts/sealed-label.mjs [--dir data/sealed-test] [--port 3100]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLabelerServer } from './lib/sealed-label-server.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(flag('dir', path.join('data', 'sealed-test')));
const port = Number(flag('port', '3100'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('--port must be a number from 1 to 65535');
  process.exit(2);
}
if (!fs.existsSync(path.join(dir, 'photos.jsonl'))) {
  console.error('No photos.jsonl in that folder. Run scripts/sealed-import.mjs first.');
  process.exit(2);
}

const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'data', 'card-catalog', 'meta.json'), 'utf8'));
const server = createLabelerServer({ dir, catalog, staticDir: path.join(repo, 'tools', 'labeler') });
server.listen(port, '127.0.0.1', () => {
  console.log(`Labeler on http://127.0.0.1:${port}  (Ctrl+C to stop)`);
});
