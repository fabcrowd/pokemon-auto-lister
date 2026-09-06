/**
 * Pick a card front from the local inbox folder and optionally rematch close-ups.
 */
import path from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';

import { listFlatPhotos } from '../inbox/watcher.js';
import { classifyShot, extractImgNumber } from './shotKind.js';
import { matchCloseupToFront, CLOSEUP_MATCH_THRESHOLD } from './photoMatch.js';
import { orderedListingPhotos } from './roles.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Resolve a user-supplied inbox file name/path to an absolute path under inboxDir.
 * @param {string} inboxDir
 * @param {string} nameOrPath
 * @returns {string}
 */
export function resolveInboxImagePath(inboxDir, nameOrPath) {
  if (!inboxDir || !existsSync(inboxDir)) {
    throw new Error('Inbox directory is not available');
  }
  if (!nameOrPath || typeof nameOrPath !== 'string') {
    throw new Error('Photo name or path is required');
  }

  const inboxReal = realpathSync(inboxDir);
  const trimmed = nameOrPath.trim();
  const candidate = path.isAbsolute(trimmed)
    ? trimmed
    : path.join(inboxDir, path.basename(trimmed));

  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new Error('Inbox photo not found');
  }

  const fileReal = realpathSync(candidate);
  const rel = path.relative(inboxReal, fileReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Photo must be inside the inbox folder');
  }

  const ext = path.extname(fileReal).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('File is not a supported image');
  }

  return fileReal;
}

/**
 * @param {string} inboxDir
 * @param {{ queue?: { listAll: () => object[] } }} [opts]
 * @returns {{ name: string, path: string, usedByCardId: string|null }[]}
 */
export function listInboxPickerPhotos(inboxDir, { queue } = {}) {
  if (!inboxDir || !existsSync(inboxDir)) {
    return [];
  }

  /** @type {Map<string, string>} */
  const usedBy = new Map();
  if (queue?.listAll) {
    for (const card of queue.listAll()) {
      for (const photoPath of card.photos || []) {
        if (photoPath) {
          usedBy.set(path.normalize(photoPath), card.id);
        }
      }
    }
  }

  return listFlatPhotos(inboxDir).map((photoPath) => ({
    name: path.basename(photoPath),
    path: photoPath,
    usedByCardId: usedBy.get(path.normalize(photoPath)) || null,
  }));
}

/**
 * Attach nearby inbox close-ups that match this front.
 * @param {string} frontPath
 * @param {string} inboxDir
 * @param {{
 *   existingPhotos?: string[],
 *   imgWindow?: number,
 *   matchCloseupFn?: typeof matchCloseupToFront,
 *   classifyShotFn?: typeof classifyShot,
 * }} [opts]
 * @returns {Promise<string[]>} extra paths to attach (excluding front)
 */
export async function findMatchingCloseupsForFront(
  frontPath,
  inboxDir,
  {
    existingPhotos = [],
    imgWindow = 40,
    matchCloseupFn = matchCloseupToFront,
    classifyShotFn = classifyShot,
  } = {},
) {
  const frontNum = extractImgNumber(frontPath);
  const existing = new Set(existingPhotos.map((p) => path.normalize(p)));
  existing.add(path.normalize(frontPath));

  const candidates = listFlatPhotos(inboxDir).filter((p) => {
    if (existing.has(path.normalize(p))) {
      return false;
    }
    if (frontNum == null) {
      return true;
    }
    const n = extractImgNumber(p);
    if (n == null) {
      return true;
    }
    return Math.abs(n - frontNum) <= imgWindow;
  });

  /** @type {string[]} */
  const matched = [];
  const frontFpCache = new Map();

  for (const candidate of candidates) {
    let classified;
    try {
      classified = await classifyShotFn(candidate);
    } catch {
      continue;
    }
    if (classified.kind === 'full_back' || classified.kind === 'full_front') {
      continue;
    }

    const result = await matchCloseupFn(candidate, [frontPath], {
      frontFpCache,
      threshold: Math.min(CLOSEUP_MATCH_THRESHOLD, 0.28),
      margin: 0,
    });
    if (result.frontPath === frontPath && result.score >= 0.28) {
      matched.push(candidate);
    }
  }

  return matched;
}

/**
 * Build updated photo roles when the user picks an inbox file as front.
 * @param {{
 *   photos?: string[],
 *   frontImagePath?: string|null,
 *   backImagePath?: string|null,
 * }} card
 * @param {string} frontPath absolute inbox path
 * @param {{ extraPaths?: string[] }} [opts]
 */
export function buildRolesWithInboxFront(card, frontPath, { extraPaths = [] } = {}) {
  const prevPhotos = Array.isArray(card.photos) ? card.photos.filter(Boolean) : [];
  const merged = [];
  const seen = new Set();

  function push(p) {
    const key = path.normalize(p);
    if (!p || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(p);
  }

  push(frontPath);
  if (card.backImagePath && card.backImagePath !== frontPath) {
    push(card.backImagePath);
  }
  for (const p of prevPhotos) {
    push(p);
  }
  for (const p of extraPaths) {
    push(p);
  }

  let back = card.backImagePath && card.backImagePath !== frontPath ? card.backImagePath : null;
  if (back && !merged.includes(back)) {
    back = null;
  }

  const ordered = orderedListingPhotos({
    photos: merged,
    frontImagePath: frontPath,
    backImagePath: back,
  });

  return {
    frontImagePath: frontPath,
    backImagePath: back,
    photos: ordered,
  };
}
