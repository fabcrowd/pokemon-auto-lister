import { readFileSync, existsSync, statSync } from 'node:fs';

import { identityKeys, normalize, normalizeNumber } from './match.js';

export const COLLECTR_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function rowKeys(row) {
  return identityKeys({
    name: row['Product Name'],
    set: row.Set,
    number: row['Card Number'],
  });
}

function marketPriceFromRow(row, headers) {
  const marketHeader =
    headers.find((header) => header.toLowerCase().startsWith('market price')) || 'Market Price';
  const price = Number.parseFloat(row[marketHeader] || '');
  return Number.isFinite(price) ? price : null;
}

function exportLabelFromHeaders(headers) {
  const marketHeader = headers.find((header) => header.toLowerCase().startsWith('market price')) || null;
  const match = marketHeader?.match(/as of\s+([0-9-]+)/i);
  return {
    marketHeader,
    asOfDate: match?.[1] ?? null,
  };
}

/**
 * Load a Collectr portfolio export CSV and look up market prices by identity.
 * Re-export from Collectr (overwrite Downloads/export.csv or data/collectr-export.csv) to refresh.
 *
 * Note: Collectr has no public Partner API suitable for live lookups (getcollectr.com/api → 404).
 */
export function createCollectrCatalog({
  csvPath,
  staleAfterMs = COLLECTR_STALE_AFTER_MS,
} = {}) {
  const byExact = new Map();
  const byNameNumber = new Map();
  const byNameSet = new Map();
  let loaded = false;
  let rowCount = 0;
  let asOfDate = null;
  let mtimeMs = null;

  function clearMaps() {
    byExact.clear();
    byNameNumber.clear();
    byNameSet.clear();
    rowCount = 0;
    asOfDate = null;
    mtimeMs = null;
  }

  function load() {
    if (loaded) {
      return;
    }
    loaded = true;
    clearMaps();
    if (!csvPath || !existsSync(csvPath)) {
      return;
    }

    mtimeMs = statSync(csvPath).mtimeMs;
    const text = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) {
      return;
    }

    const headers = parseCsvLine(lines[0]);
    asOfDate = exportLabelFromHeaders(headers).asOfDate;

    for (let i = 1; i < lines.length; i += 1) {
      const values = parseCsvLine(lines[i]);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
      if (String(row.Category || '').toLowerCase() !== 'pokemon') {
        continue;
      }

      const price = marketPriceFromRow(row, headers);
      if (price === null) {
        continue;
      }

      const payload = {
        market: price,
        mid: null,
        name: row['Product Name'],
        set: row.Set,
        number: row['Card Number'],
        condition: row['Card Condition'],
        source: 'collectr-csv',
      };

      const keys = rowKeys(row);
      byExact.set(keys.exact, payload);
      if (!byNameNumber.has(keys.nameNumber)) {
        byNameNumber.set(keys.nameNumber, payload);
      }
      if (!byNameSet.has(keys.nameSet)) {
        byNameSet.set(keys.nameSet, payload);
      }
      rowCount += 1;
    }
  }

  function reload() {
    loaded = false;
    load();
    return stats();
  }

  function getMarketPrice(identity = {}) {
    load();
    const name = normalize(identity.name);
    const set = normalize(identity.set);
    const number = normalizeNumber(identity.number);
    if (!name) {
      return null;
    }

    return (
      byExact.get(`${name}|${set}|${number}`) ||
      byNameNumber.get(`${name}|${number}`) ||
      byNameSet.get(`${name}|${set}`) ||
      null
    );
  }

  function stats(nowMs = Date.now()) {
    load();
    const ageMs = mtimeMs == null ? null : Math.max(0, nowMs - mtimeMs);
    return {
      mode: 'csv',
      rowCount,
      csvPath: csvPath || null,
      exists: Boolean(csvPath && existsSync(csvPath)),
      mtimeMs,
      asOfDate,
      ageMs,
      ageHours: ageMs == null ? null : ageMs / (60 * 60 * 1000),
      staleAfterMs,
      stale: ageMs == null ? true : ageMs >= staleAfterMs,
    };
  }

  return { getMarketPrice, stats, reload };
}
