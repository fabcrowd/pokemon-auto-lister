import { readdirSync, statSync, existsSync, writeFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';

import { findPostedCollision } from '../photos/postedLedger.js';
import { classifyShots, comparePhotoPaths } from '../photos/shotKind.js';
import { groupCardPhotos } from '../photos/groupShots.js';

// Written inside a processed folder so a re-scan (or process restart) never
// re-enqueues the same drop. Flat Shared-album files use dataDir state instead
// so we never write junk into iCloud sync folders.
const PROCESSED_MARKER = '.autolister-processed';
const FLAT_SEEN_FILE = 'inbox-flat-seen.json';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function pickFrontImage(photoPaths) {
  const front = photoPaths.find((photoPath) => path.basename(photoPath).toLowerCase().startsWith('front'));
  return front ?? photoPaths[0];
}

function atomicWriteJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

/**
 * Legacy every-2 pairing (kept for tests / explicit callers).
 * Flat inbox scan now uses classify + groupCardPhotos instead.
 */
export function pairSequentialPhotos(sortedPhotoPaths) {
  const pairs = [];
  for (let i = 0; i < sortedPhotoPaths.length; i += 2) {
    const front = sortedPhotoPaths[i];
    const back = sortedPhotoPaths[i + 1];
    const photos = back ? [front, back] : [front];
    pairs.push({
      frontImagePath: front,
      backImagePath: back || null,
      photos,
      index: pairs.length + 1,
    });
  }
  return pairs;
}

function readFlatSeen(dataDir) {
  const filePath = path.join(dataDir, FLAT_SEEN_FILE);
  if (!existsSync(filePath)) {
    return {};
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function markFlatSeen(dataDir, photoPaths) {
  const filePath = path.join(dataDir, FLAT_SEEN_FILE);
  const seen = readFlatSeen(dataDir);
  const now = new Date().toISOString();
  const list = Array.isArray(photoPaths) ? photoPaths : [photoPaths];
  for (const photoPath of list) {
    if (photoPath) {
      seen[photoPath] = now;
    }
  }
  atomicWriteJson(filePath, seen);
}

function normalizePhotoPath(photoPath) {
  return path.normalize(photoPath || '');
}

/**
 * Prefer the queue card whose front matches the group front; else any photo overlap.
 * @param {{ listAll: () => object[] }} queue
 * @param {{ frontImagePath?: string|null, photos?: string[] }} group
 * @returns {object|null}
 */
export function findCardForPhotoGroup(queue, group) {
  if (!queue?.listAll) {
    return null;
  }
  const cards = queue.listAll();
  const front = normalizePhotoPath(group.frontImagePath);
  if (front) {
    for (const card of cards) {
      if (normalizePhotoPath(card.frontImagePath) === front) {
        return card;
      }
    }
    for (const card of cards) {
      if ((card.photos || []).some((p) => normalizePhotoPath(p) === front)) {
        return card;
      }
    }
  }
  const photoSet = new Set((group.photos || []).map(normalizePhotoPath).filter(Boolean));
  if (photoSet.size === 0) {
    return null;
  }
  for (const card of cards) {
    if ((card.photos || []).some((p) => photoSet.has(normalizePhotoPath(p)))) {
      return card;
    }
  }
  return null;
}

function isListedCard(card) {
  return card?.status === 'listed';
}

async function enqueueCard({ queue, onEnqueue, enqueuedIds, payload, afterEnqueue }) {
  const id = queue.enqueue(payload);
  enqueuedIds.push(id);
  if (afterEnqueue) {
    afterEnqueue(id);
  }
  if (onEnqueue) {
    try {
      await onEnqueue(id);
    } catch (err) {
      // Intake already persisted; pipeline errors must not undo idempotency marks.
      console.error(`Pipeline failed for card ${id}:`, err);
    }
  }
  return id;
}

async function refreshExistingCard({
  queue,
  onEnqueue,
  updatedIds,
  cardId,
  payload,
  afterUpdate,
}) {
  queue.patch(cardId, {
    photos: payload.photos,
    frontImagePath: payload.frontImagePath,
    backImagePath: payload.backImagePath ?? null,
    shotKinds: payload.shotKinds,
    intakeReason: payload.intakeReason ?? null,
    status: 'queued',
    pricedCache: null,
  });
  updatedIds.push(cardId);
  if (afterUpdate) {
    afterUpdate(cardId);
  }
  if (onEnqueue) {
    try {
      await onEnqueue(cardId);
    } catch (err) {
      console.error(`Pipeline failed for card ${cardId}:`, err);
    }
  }
  return cardId;
}

/**
 * List flat inbox images sorted by camera roll (IMG_####), then name, then mtime.
 * @param {string} inboxDir
 * @returns {string[]}
 */
export function listFlatPhotos(inboxDir) {
  return readdirSync(inboxDir)
    .filter((name) => {
      const full = path.join(inboxDir, name);
      return statSync(full).isFile() && isImageFile(name);
    })
    .map((name) => path.join(inboxDir, name))
    .sort((a, b) => {
      const mtimeA = statSync(a).mtimeMs;
      const mtimeB = statSync(b).mtimeMs;
      return comparePhotoPaths(a, b, { mtimeA, mtimeB });
    });
}

/**
 * Classify + group unseen flat photos into card batches.
 * @param {{
 *   photoPaths: string[],
 *   classifyShotFn?: Function,
 *   groupShotsFn?: typeof groupCardPhotos,
 *   matchCloseupFn?: Function,
 * }} opts
 */
export async function buildFlatPhotoGroups({
  photoPaths,
  classifyShotFn,
  groupShotsFn = groupCardPhotos,
  matchCloseupFn,
} = {}) {
  const classified = await classifyShots(photoPaths, {
    classifyShotFn: classifyShotFn
      ? (photoPath) => classifyShotFn(photoPath)
      : undefined,
  });
  return groupShotsFn(classified, matchCloseupFn ? { matchCloseupFn } : {});
}

function resolveMarketplaceDefaults(defaults = {}) {
  const hasMercari = Object.prototype.hasOwnProperty.call(defaults, 'mercari');
  const hasEbay = Object.prototype.hasOwnProperty.call(defaults, 'ebay');
  return {
    mercari: hasMercari ? Boolean(defaults.mercari) : true,
    ebay: hasEbay ? Boolean(defaults.ebay) : true,
  };
}

/**
 * Count folders/groups that would enqueue on the next scan (not seen, not posted).
 * @returns {Promise<{ pendingFolders: number, pendingPairs: number, pendingTotal: number, inboxDir: string, exists: boolean }>}
 */
export async function countPendingInbox({
  inboxDir,
  dataDir = 'data',
  classifyShotFn,
  groupShotsFn,
} = {}) {
  if (!existsSync(inboxDir)) {
    return {
      pendingFolders: 0,
      pendingPairs: 0,
      pendingTotal: 0,
      inboxDir,
      exists: false,
    };
  }

  let pendingFolders = 0;
  for (const entry of readdirSync(inboxDir)) {
    const folderPath = path.join(inboxDir, entry);
    if (!statSync(folderPath).isDirectory()) {
      continue;
    }
    const markerPath = path.join(folderPath, PROCESSED_MARKER);
    if (existsSync(markerPath)) {
      continue;
    }
    const photoPaths = readdirSync(folderPath)
      .filter(isImageFile)
      .map((name) => path.join(folderPath, name));
    if (photoPaths.length === 0) {
      continue;
    }
    if (findPostedCollision(dataDir, photoPaths)) {
      continue;
    }
    pendingFolders += 1;
  }

  const seen = readFlatSeen(dataDir);
  const unseen = listFlatPhotos(inboxDir).filter((p) => !seen[p]);
  let pendingPairs = 0;
  if (unseen.length > 0) {
    const groups = await buildFlatPhotoGroups({
      photoPaths: unseen,
      classifyShotFn,
      groupShotsFn,
    });
    for (const group of groups) {
      if (findPostedCollision(dataDir, group.photos)) {
        continue;
      }
      pendingPairs += 1;
    }
  }

  return {
    pendingFolders,
    pendingPairs,
    pendingTotal: pendingFolders + pendingPairs,
    inboxDir,
    exists: true,
  };
}

/**
 * Scan the inbox and enqueue (or refresh) card groups.
 * @param {{
 *   inboxDir: string,
 *   queue: object,
 *   onEnqueue?: (id: string) => Promise<void>|void,
 *   dataDir?: string,
 *   marketplaceDefaults?: object,
 *   classifyShotFn?: Function,
 *   groupShotsFn?: Function,
 *   forceRescan?: boolean,
 * }} opts
 * @returns {Promise<{ enqueued: string[], updated: string[] }>}
 */
export async function scanInbox({
  inboxDir,
  queue,
  onEnqueue,
  dataDir = 'data',
  marketplaceDefaults = {},
  classifyShotFn,
  groupShotsFn,
  forceRescan = false,
} = {}) {
  if (!existsSync(inboxDir)) {
    return { enqueued: [], updated: [] };
  }

  const markets = resolveMarketplaceDefaults(marketplaceDefaults);
  const enqueuedIds = [];
  const updatedIds = [];
  const albumLabel = path.basename(inboxDir);

  for (const entry of readdirSync(inboxDir)) {
    const folderPath = path.join(inboxDir, entry);
    if (!statSync(folderPath).isDirectory()) {
      continue;
    }

    const markerPath = path.join(folderPath, PROCESSED_MARKER);
    if (existsSync(markerPath) && !forceRescan) {
      continue;
    }

    const photoPaths = readdirSync(folderPath)
      .filter(isImageFile)
      .map((name) => path.join(folderPath, name))
      .sort();

    if (photoPaths.length === 0) {
      continue;
    }

    const postedHit = findPostedCollision(dataDir, photoPaths);
    if (postedHit) {
      console.log(
        `Inbox skip folder ${entry}: photo already posted (${postedHit.via}) ${path.basename(postedHit.path)}`,
      );
      writeFileSync(markerPath, new Date().toISOString());
      continue;
    }

    const folderPayload = {
      title: entry,
      photos: photoPaths,
      frontImagePath: pickFrontImage(photoPaths),
      backImagePath: (() => {
        const front = pickFrontImage(photoPaths);
        return photoPaths.find((p) => p !== front) || null;
      })(),
      mercari: markets.mercari,
      ebay: markets.ebay,
    };

    const existing = findCardForPhotoGroup(queue, folderPayload);
    if (existing) {
      if (isListedCard(existing)) {
        writeFileSync(markerPath, new Date().toISOString());
        continue;
      }
      if (forceRescan) {
        await refreshExistingCard({
          queue,
          onEnqueue,
          updatedIds,
          cardId: existing.id,
          payload: folderPayload,
          afterUpdate: () => {
            writeFileSync(markerPath, new Date().toISOString());
          },
        });
      } else {
        writeFileSync(markerPath, new Date().toISOString());
      }
      continue;
    }

    await enqueueCard({
      queue,
      onEnqueue,
      enqueuedIds,
      payload: folderPayload,
      afterEnqueue: () => {
        writeFileSync(markerPath, new Date().toISOString());
      },
    });
  }

  // Flat album: classify full vs close-up, group by camera sequence (back-anchored).
  const flatPhotos = listFlatPhotos(inboxDir);
  const seen = readFlatSeen(dataDir);
  const candidates = forceRescan ? flatPhotos : flatPhotos.filter((p) => !seen[p]);

  if (candidates.length > 0) {
    const groups = await buildFlatPhotoGroups({
      photoPaths: candidates,
      classifyShotFn,
      groupShotsFn,
    });

    for (const group of groups) {
      const postedHit = findPostedCollision(dataDir, group.photos);
      if (postedHit) {
        console.log(
          `Inbox skip group #${group.index}: photo already posted (${postedHit.via}) ${path.basename(postedHit.path)}`,
        );
        markFlatSeen(dataDir, group.photos);
        for (const p of group.photos) {
          seen[p] = true;
        }
        continue;
      }

      const reason = group.noFullFront ? 'no full-card photo' : null;
      const payload = {
        title: `${albumLabel} #${group.index}`,
        photos: group.photos,
        frontImagePath: group.frontImagePath,
        backImagePath: group.backImagePath ?? null,
        shotKinds: group.kinds,
        intakeReason: reason,
        mercari: markets.mercari,
        ebay: markets.ebay,
      };

      const existing = findCardForPhotoGroup(queue, group);
      if (existing) {
        if (isListedCard(existing)) {
          markFlatSeen(dataDir, group.photos);
          for (const p of group.photos) {
            seen[p] = true;
          }
          continue;
        }
        if (forceRescan) {
          await refreshExistingCard({
            queue,
            onEnqueue,
            updatedIds,
            cardId: existing.id,
            payload,
            afterUpdate: () => {
              markFlatSeen(dataDir, group.photos);
              for (const p of group.photos) {
                seen[p] = true;
              }
            },
          });
          continue;
        }
        // Already on a card but not force — treat as seen so we don't duplicate.
        markFlatSeen(dataDir, group.photos);
        for (const p of group.photos) {
          seen[p] = true;
        }
        continue;
      }

      await enqueueCard({
        queue,
        onEnqueue,
        enqueuedIds,
        payload,
        afterEnqueue: () => {
          markFlatSeen(dataDir, group.photos);
          for (const p of group.photos) {
            seen[p] = true;
          }
        },
      });
    }
  }

  return { enqueued: enqueuedIds, updated: updatedIds };
}

export function startInboxWatcher({ inboxDir, queue, onEnqueue, dataDir = 'data', intervalMs = 5000 }) {
  let scanning = false;
  const timer = setInterval(() => {
    if (scanning) {
      return;
    }
    scanning = true;
    scanInbox({ inboxDir, queue, onEnqueue, dataDir })
      .catch((err) => {
        console.error(`Inbox scan of ${inboxDir} failed:`, err);
      })
      .finally(() => {
        scanning = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
