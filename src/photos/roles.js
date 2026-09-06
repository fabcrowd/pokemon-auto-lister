/**
 * Same-batch front/back role helpers for listing photos.
 */

/**
 * Prefer explicit backImagePath when it belongs to the batch and isn't the front.
 * @param {{ frontImagePath?: string, backImagePath?: string|null, photos?: string[] }} card
 * @returns {string|null}
 */
export function pickBackImagePath(card) {
  const photos = Array.isArray(card.photos) ? card.photos : [];
  const front = card.frontImagePath;
  const explicit = card.backImagePath;
  if (explicit && photos.includes(explicit) && explicit !== front) {
    return explicit;
  }
  return photos.find((p) => p && p !== front) || null;
}

/**
 * Mercari upload order: front, back (if any), then remaining extras.
 * @param {{ frontImagePath?: string, backImagePath?: string|null, photos?: string[] }} card
 * @returns {string[]}
 */
export function orderedListingPhotos(card) {
  const photos = (Array.isArray(card.photos) ? card.photos : []).filter(
    (p) => typeof p === 'string' && p.length > 0,
  );
  if (photos.length === 0) {
    return [];
  }
  const front =
    card.frontImagePath && photos.includes(card.frontImagePath)
      ? card.frontImagePath
      : photos[0];
  const back = pickBackImagePath({ ...card, frontImagePath: front, photos });
  const extras = photos.filter((p) => p !== front && p !== back);
  return [front, ...(back ? [back] : []), ...extras];
}

/**
 * Validate and apply front/back roles within an existing photo batch.
 * Pass `backImagePath: null` (or empty string) to clear an explicit back.
 *
 * @param {string[]} photos
 * @param {{ frontImagePath?: string, backImagePath?: string|null }} roles
 */
export function resolvePhotoRoles(photos, roles = {}) {
  if (!Array.isArray(photos) || photos.length === 0) {
    throw new Error('At least one photo is required');
  }

  const { frontImagePath, backImagePath } = roles;

  if (frontImagePath != null && !photos.includes(frontImagePath)) {
    throw new Error('frontImagePath must be one of the card photos');
  }
  if (backImagePath != null && backImagePath !== '' && !photos.includes(backImagePath)) {
    throw new Error('backImagePath must be one of the card photos');
  }

  const front = frontImagePath ?? photos[0];
  let back = null;
  if (backImagePath === null || backImagePath === '') {
    back = null;
  } else if (backImagePath != null) {
    back = backImagePath;
  }

  if (back && back === front) {
    throw new Error('backImagePath cannot be the same as frontImagePath');
  }

  const next = {
    frontImagePath: front,
    backImagePath: back,
    photos,
  };
  return {
    frontImagePath: front,
    backImagePath: back,
    photos: orderedListingPhotos(next),
  };
}

/**
 * Infer initial back from batch when enqueueing (first non-front).
 * @param {string[]} photos
 * @param {string} frontImagePath
 */
export function inferBackImagePath(photos, frontImagePath) {
  if (!Array.isArray(photos)) {
    return null;
  }
  return photos.find((p) => p && p !== frontImagePath) || null;
}
