// A listing is "in training" when its marketplace id appears in the training manifest
// or in a data/detect-marketplace folder name. Keys are "<marketplace>:<id>".

const PATTERNS = [
  ['goodwill', /(?:^|\.)shopgoodwill\.com$/i, /\/item\/(\d+)/i],
  ['hibid', /(?:^|\.)hibid\.com$/i, /\/lot\/(\d+)/i],
  ['facebook', /(?:^|\.)facebook\.com$/i, /\/marketplace\/item\/(\d+)/i],
  ['ebay', /(?:^|\.)ebay\.[a-z.]+$/i, /\/itm\/(?:[^/]+\/)?(\d+)/i],
];

export function listingKey(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  for (const [market, host, path] of PATTERNS) {
    const id = host.test(parsed.hostname) ? parsed.pathname.match(path)?.[1] : null;
    if (id) return `${market}:${id}`;
  }
  return null;
}

/**
 * @param manifestLines lines of data/variant-photos/manifest.jsonl (ShopGoodwill item ids)
 * @param folders folder names under data/detect-marketplace/<market>/
 */
export function trainingKeysFrom({ manifestLines = [], folders = {} }) {
  const keys = new Set();
  for (const line of manifestLines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (/^\d+$/.test(String(row?.listing ?? ''))) keys.add(`goodwill:${row.listing}`);
  }
  for (const [market, names] of Object.entries(folders)) {
    for (const name of names) {
      const id = String(name).match(/(\d+)$/)?.[1];
      if (id) keys.add(`${market}:${id}`);
    }
  }
  return keys;
}
