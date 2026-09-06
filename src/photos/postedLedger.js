/**
 * Ledger of photos already used on drafted/listed cards.
 * Survives queue JSON deletion; keyed by absolute path and content sha256.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const POSTED_PHOTOS_FILE = 'posted-photos.json';

function atomicWriteJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

export function emptyPostedLedger() {
  return { paths: {}, hashes: {} };
}

export function readPostedLedger(dataDir) {
  const filePath = path.join(dataDir, POSTED_PHOTOS_FILE);
  if (!existsSync(filePath)) {
    return emptyPostedLedger();
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      paths: raw.paths && typeof raw.paths === 'object' ? raw.paths : {},
      hashes: raw.hashes && typeof raw.hashes === 'object' ? raw.hashes : {},
    };
  } catch {
    return emptyPostedLedger();
  }
}

export function writePostedLedger(dataDir, ledger) {
  atomicWriteJson(path.join(dataDir, POSTED_PHOTOS_FILE), ledger);
}

/**
 * @param {string} filePath
 * @returns {string|null}
 */
export function hashImageFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Collect photo paths from a queue card record.
 * @param {{ photos?: string[], frontImagePath?: string, backImagePath?: string|null }} card
 * @returns {string[]}
 */
export function cardPhotoPaths(card) {
  const out = [];
  const seen = new Set();
  for (const p of [
    ...(Array.isArray(card?.photos) ? card.photos : []),
    card?.frontImagePath,
    card?.backImagePath,
  ]) {
    if (typeof p === 'string' && p.length > 0 && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * @param {string} dataDir
 * @param {{ id?: string, photos?: string[], frontImagePath?: string, backImagePath?: string|null }} card
 */
export function recordPostedPhotos(dataDir, card) {
  const ledger = readPostedLedger(dataDir);
  const now = new Date().toISOString();
  const cardId = card?.id || null;
  for (const photoPath of cardPhotoPaths(card)) {
    ledger.paths[photoPath] = { cardId, at: now };
    const digest = hashImageFile(photoPath);
    if (digest) {
      ledger.hashes[digest] = { cardId, path: photoPath, at: now };
    }
  }
  writePostedLedger(dataDir, ledger);
  return ledger;
}

/**
 * @param {string} dataDir
 * @param {string[]} photoPaths
 * @returns {{ path: string, hash?: string, cardId?: string|null, via: 'path'|'hash' }|null}
 */
export function findPostedCollision(dataDir, photoPaths) {
  const ledger = readPostedLedger(dataDir);
  for (const photoPath of photoPaths || []) {
    if (!photoPath) {
      continue;
    }
    if (ledger.paths[photoPath]) {
      return {
        path: photoPath,
        cardId: ledger.paths[photoPath].cardId ?? null,
        via: 'path',
      };
    }
    const digest = hashImageFile(photoPath);
    if (digest && ledger.hashes[digest]) {
      return {
        path: photoPath,
        hash: digest,
        cardId: ledger.hashes[digest].cardId ?? null,
        via: 'hash',
      };
    }
  }
  return null;
}

function cardHasMarketplaceDraft(card) {
  const drafts = card?.drafts;
  if (!drafts || typeof drafts !== 'object') {
    return false;
  }
  return Object.values(drafts).some((entry) => entry && entry.created);
}

/**
 * Seed ledger from cards already drafted/listed (any status if a marketplace
 * draft was created — e.g. later moved to error/needs_review). Idempotent.
 * @param {string} dataDir
 * @param {{ listAll?: () => object[], listByStatus: (status: string) => object[] }} queue
 */
export function seedPostedLedgerFromQueue(dataDir, queue) {
  const cards =
    typeof queue.listAll === 'function'
      ? queue.listAll()
      : ['drafted', 'listed', 'error', 'needs_review'].flatMap((status) => queue.listByStatus(status));

  let count = 0;
  for (const card of cards) {
    if (card.status === 'drafted' || card.status === 'listed' || cardHasMarketplaceDraft(card)) {
      recordPostedPhotos(dataDir, card);
      count += 1;
    }
  }
  return count;
}
