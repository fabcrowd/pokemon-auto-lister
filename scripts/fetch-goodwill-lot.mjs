// Save a ShopGoodwill listing's photos for detector and extension checks.
//   node scripts/fetch-goodwill-lot.mjs 279427892
// Writes data/detect-marketplace/goodwill/<id>/00.jpg… and title.txt (gitignored).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const id = process.argv[2];
if (!/^\d+$/.test(id || '')) {
  console.error('Usage: node scripts/fetch-goodwill-lot.mjs <itemId>');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'data', 'detect-marketplace', 'goodwill', id);

const res = await fetch(`https://buyerapi.shopgoodwill.com/api/itemDetail/GetItemDetailModelByItemId/${id}`, {
  headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
});
if (!res.ok) throw new Error(`item ${id}: HTTP ${res.status}`);
const item = await res.json();

const server = String(item.imageServer || '').replace(/\/?$/, '/');
const paths = String(item.imageUrlString || '').split(';').map((p) => p.trim()).filter(Boolean);
if (!server || paths.length === 0) throw new Error(`item ${id}: no photos in the listing`);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'title.txt'), `${item.title || ''}\n`);

for (const [i, p] of paths.entries()) {
  const url = server + p.replace(/\\/g, '/');
  const img = await fetch(url);
  if (!img.ok) throw new Error(`${url}: HTTP ${img.status}`);
  const file = path.join(outDir, `${String(i).padStart(2, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(await img.arrayBuffer()));
  console.log(file, url);
}
console.log(`${paths.length} photos — ${item.title}`);
