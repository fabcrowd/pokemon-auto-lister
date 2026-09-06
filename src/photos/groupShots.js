/**
 * Group classified inbox shots into cards without assuming a shoot sequence.
 *
 * 1. Find full fronts (and full backs) by content heuristics.
 * 2. In camera order among full-card shots, each front’s next full-card photo is
 *    its back (“second photo is always the back”).
 * 3. Attach close-ups to the best-matching front via visual similarity
 *    (full frame + corner crops of that front).
 */
import {
  CLOSEUP_MATCH_THRESHOLD,
  matchCloseupToFront,
} from './photoMatch.js';
import { extractImgNumber } from './shotKind.js';

/**
 * @typedef {{ path: string, kind: 'full_front' | 'full_back' | 'closeup', score?: number, scores?: object }} ClassifiedShot
 * @typedef {{
 *   photos: string[],
 *   frontImagePath: string|null,
 *   backImagePath: string|null,
 *   noFullFront: boolean,
 *   index: number,
 *   kinds: Record<string, string>,
 * }} PhotoGroup
 */

/** Treat as a full-card frame (eligible for front/back pairing). */
export function isFullCardShot(shot) {
  if (!shot) {
    return false;
  }
  return shot.kind === 'full_front' || shot.kind === 'full_back';
}

/**
 * @param {string} closeupPath
 * @param {string[]} frontPaths
 * @returns {string|null}
 */
export function nearestFrontByImg(closeupPath, frontPaths) {
  const n = extractImgNumber(closeupPath);
  if (n == null || frontPaths.length === 0) {
    return frontPaths[0] ?? null;
  }
  let best = frontPaths[0];
  let bestDist = Infinity;
  for (const frontPath of frontPaths) {
    const fn = extractImgNumber(frontPath);
    if (fn == null) {
      continue;
    }
    const dist = Math.abs(fn - n);
    if (dist < bestDist) {
      bestDist = dist;
      best = frontPath;
    }
  }
  return best;
}

/**
 * Pair full-card shots in camera order: each front’s next full-card photo is its back.
 * Only starts a pair on an identified front; orphan backs are skipped.
 * @param {ClassifiedShot[]} fullShots camera-ordered
 * @returns {{ front: ClassifiedShot, back: ClassifiedShot|null }[]}
 */
export function pairFrontsWithFollowingBacks(fullShots) {
  /** @type {{ front: ClassifiedShot, back: ClassifiedShot|null }[]} */
  const pairs = [];
  let i = 0;
  while (i < fullShots.length) {
    const shot = fullShots[i];
    if (shot.kind === 'full_back') {
      i += 1;
      continue;
    }
    if (shot.kind !== 'full_front') {
      i += 1;
      continue;
    }

    const front = shot;
    const next = fullShots[i + 1] ?? null;
    let back = null;
    if (next) {
      // Next full-card photo is always the back (even if classifier is unsure).
      back = next;
      i += 2;
    } else {
      i += 1;
    }
    pairs.push({ front, back });
  }
  return pairs;
}

/**
 * @param {{ front: ClassifiedShot, back: ClassifiedShot|null, closeups?: ClassifiedShot[] }} card
 * @param {number} index
 * @returns {PhotoGroup}
 */
function toPhotoGroup(card, index) {
  const extras = Array.isArray(card.closeups) ? card.closeups : [];
  const photos = [
    card.front.path,
    ...(card.back ? [card.back.path] : []),
    ...extras.map((c) => c.path),
  ];
  const kinds = {
    [card.front.path]: card.front.kind === 'full_back' ? 'full_front' : card.front.kind,
    ...(card.back ? { [card.back.path]: 'full_back' } : {}),
    ...Object.fromEntries(extras.map((c) => [c.path, c.kind])),
  };
  return {
    photos,
    frontImagePath: card.front.path,
    backImagePath: card.back && card.back.path !== card.front.path ? card.back.path : null,
    noFullFront: false,
    index,
    kinds,
  };
}

/**
 * @param {ClassifiedShot[]} shots camera-ordered classified shots
 * @param {{
 *   matchCloseupFn?: typeof matchCloseupToFront,
 *   threshold?: number,
 * }} [opts]
 * @returns {Promise<PhotoGroup[]>}
 */
export async function groupCardPhotos(
  shots,
  { matchCloseupFn = matchCloseupToFront, threshold = CLOSEUP_MATCH_THRESHOLD } = {},
) {
  const fullShots = shots.filter(isFullCardShot);
  const closeups = shots.filter((s) => !isFullCardShot(s));

  const pairs = pairFrontsWithFollowingBacks(fullShots);
  /** @type {{ front: ClassifiedShot, back: ClassifiedShot|null, closeups: ClassifiedShot[] }[]} */
  const cards = pairs.map((p) => ({ ...p, closeups: [] }));

  const frontPaths = cards.map((c) => c.front.path);
  const frontFpCache = new Map();

  /** @type {ClassifiedShot[]} */
  const unmatched = [];

  for (const closeup of closeups) {
    if (frontPaths.length === 0) {
      unmatched.push(closeup);
      continue;
    }
    const match = await matchCloseupFn(closeup.path, frontPaths, {
      frontFpCache,
      threshold,
    });
    let frontPath = match.frontPath;
    if (!frontPath) {
      // Soft fallback: nearest front in camera-roll numbering so corners aren't orphaned.
      frontPath = nearestFrontByImg(closeup.path, frontPaths);
    }
    const card = frontPath ? cards.find((c) => c.front.path === frontPath) : null;
    if (card) {
      card.closeups.push(closeup);
    } else {
      unmatched.push(closeup);
    }
  }

  /** @type {PhotoGroup[]} */
  const groups = cards.map((card, i) => toPhotoGroup(card, i + 1));

  // Orphan close-ups with no matchable front → needs_review groups (no full front).
  for (const orphan of unmatched) {
    groups.push({
      photos: [orphan.path],
      frontImagePath: null,
      backImagePath: null,
      noFullFront: true,
      index: groups.length + 1,
      kinds: { [orphan.path]: orphan.kind },
    });
  }

  return groups;
}

/**
 * Sync wrapper used by older tests — prefers async groupCardPhotos in production.
 * Close-ups are left unmatched (no similarity) unless provided as already attached.
 * @param {ClassifiedShot[]} shots
 * @returns {PhotoGroup[]}
 */
export function groupShotsBySequence(shots) {
  const fullShots = shots.filter(isFullCardShot);
  const pairs = pairFrontsWithFollowingBacks(fullShots);
  const closeups = shots.filter((s) => !isFullCardShot(s));
  // Without async matching, attach all close-ups to no card — return front/back pairs only,
  // then one orphan group per leftover close-up so callers still see them.
  const groups = pairs.map((p, i) => toPhotoGroup({ ...p, closeups: [] }, i + 1));
  for (const c of closeups) {
    groups.push({
      photos: [c.path],
      frontImagePath: null,
      backImagePath: null,
      noFullFront: true,
      index: groups.length + 1,
      kinds: { [c.path]: c.kind },
    });
  }
  return groups;
}
