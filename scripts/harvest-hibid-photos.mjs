// Download real HiBid Pokémon listing photos for detector labelling.
//
// Photos land in data/detect-hibid-real/<lotId>/NN.jpg with meta.json (title, url).
// They are unlabelled: boxes must be reviewed before training (see
// tools/vellum-ai/detect/label_marketplace.py). Sequential with a delay per lot.
//
// Usage: node scripts/harvest-hibid-photos.mjs [--per-query=25] [--per-lot=3]
import { chromium } from 'playwright';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('data/detect-hibid-real');
const QUERIES = [
  'https://hibid.com/lots?q=pokemon%20binder',
  'https://hibid.com/lots?q=pokemon%20card%20lot',
  'https://hibid.com/lots?q=pokemon%20psa',
  'https://hibid.com/lots?q=pokemon%20holo%20cards',
  'https://hibid.com/lots?q=vintage%20pokemon%20cards',
  'https://hibid.com/lots/700074/antiques-and-collectibles/collectibles/trading-cards/pokemon-cards',
];
const arg = (name, dflt) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt);
const PER_QUERY = arg('per-query', 25);
const PER_LOT = arg('per-lot', 3);
// --queries=0,2 runs a subset so several workers can split the list.
const PICK = process.argv.find(a => a.startsWith('--queries='))?.split('=')[1]?.split(',').map(Number);
const DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = p => access(p).then(() => true, () => false);

async function lotLinks(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  return page.evaluate(() => {
    const byUrl = new Map();
    for (const a of document.querySelectorAll('a[href*="/lot/"]')) {
      const url = a.href.split('?')[0];
      const title = a.textContent.replace(/\s+/g, ' ').replace(/^Lot \S+ \| /, '').trim();
      if (!byUrl.has(url) || title.length > byUrl.get(url).length) byUrl.set(url, title);
    }
    return [...byUrl].map(([url, title]) => ({ url, title }));
  });
}

async function galleryUrls(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  return page.evaluate(() => {
    const out = new Set();
    for (const el of document.querySelectorAll('*')) {
      const bg = getComputedStyle(el).backgroundImage;
      for (const m of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) {
        if (m[1].includes('img.axd') && m[1].includes('sz=MAX')) out.add(m[1].replace(/&h=\d+&w=\d+$/, ''));
      }
    }
    return { title: document.title.split('|')[0].trim(), urls: [...out] };
  });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
let saved = 0;
const seenTitles = new Set();
try {
  for (const q of PICK ? PICK.map(i => QUERIES[i]) : QUERIES) {
    let links = [];
    try { links = await lotLinks(page, q); } catch (e) { console.error('query failed', q, e.message); continue; }
    let taken = 0;
    for (const { url: lot, title } of links) {
      if (taken >= PER_QUERY) break;
      const lotId = lot.match(/\/lot\/(\d+)/)?.[1];
      // One seller often lists dozens of near-identical lots; keep one per title.
      const key = title.toLowerCase().replace(/[^a-z]/g, '');
      if (!lotId || !key || seenTitles.has(key) || await exists(path.join(OUT, lotId))) continue;
      seenTitles.add(key);
      let gallery;
      try { gallery = await galleryUrls(page, lot); } catch (e) { console.error('lot failed', lot, e.message); continue; }
      if (!gallery.urls.length) continue;
      const dir = path.join(OUT, lotId);
      await mkdir(dir, { recursive: true });
      let n = 0;
      for (const u of gallery.urls.slice(0, PER_LOT)) {
        const res = await fetch(u);
        if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) continue;
        await writeFile(path.join(dir, `${String(n).padStart(2, '0')}.jpg`), Buffer.from(await res.arrayBuffer()));
        n++;
      }
      await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ lotId, title: gallery.title, url: lot, query: q, images: n }, null, 2));
      saved += n; taken++;
      console.log(`${lotId}\t${n}\t${gallery.title}`);
      await sleep(DELAY_MS);
    }
  }
} finally {
  await browser.close();
  console.log(`saved ${saved} photos`);
}
