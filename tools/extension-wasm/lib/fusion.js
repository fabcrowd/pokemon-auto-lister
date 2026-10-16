// Identity resolution over a ranked list of CLIP catalog hits.
//
// The catalog contains many near-duplicate card artworks (Base Set reprints across
// Legendary Collection, Expedition, etc.) so a strict margin threshold rejects most
// correct top-1 matches. Instead, we accept when any of these holds:
//   1. Top-1 raw CLIP similarity is clearly ahead of top-2 (gap ≥ CLEAR_GAP)
//   2. Top-1 and top-2 share the same Pokémon name — same art, different printings
//   3. Top-1 similarity is very high in absolute terms (likely exact catalog match)
//   4. Among the top 3 near-tied hits, one name appears more often than the others

const MIN_ACCEPT_SIM = 0.72;  // below this → always abstain
const CLEAR_GAP      = 0.02;  // gap over #2 that definitively accepts
const HIGH_SIM       = 0.85;  // absolute similarity that overrides gap
const NAME_MATCH_SIM = 0.75;  // if top-1/top-2 share a name, require this much sim

/**
 * Fuse CLIP hits with OCR text (currently unused — reserved for future).
 *
 * @param {Array<{index: number, score: number}>} clipHits  — sorted desc by score
 * @param {string|null}  _ocrText — reserved
 * @param {Array<object>} meta    — meta.json
 * @param {string[]}     _idMap   — reserved
 *
 * @returns {{ identity: object|null, confidence: number, abstain: boolean, reason?: string }}
 */
// Hits from a hub-penalised search carry `rank` (cosine minus penalty) beside `score` (the cosine itself).
// Order and the distance between neighbours are judged on rank; what a similarity means, on score.
const rankOf = (hit) => hit.rank ?? hit.score;

export function fuseResults(clipHits, _ocrText, meta, _idMap) {
  if (!clipHits || clipHits.length === 0) {
    return { identity: null, confidence: 0, abstain: true, reason: "no_hits" };
  }

  const top    = clipHits[0];
  const second = clipHits[1] || null;
  const topMeta    = meta[top.index];
  const secondMeta = second ? meta[second.index] : null;

  if (!topMeta) {
    return { identity: null, confidence: 0, abstain: true, reason: "meta_missing" };
  }

  const topSim    = top.score;
  const gap       = second ? rankOf(top) - rankOf(second) : topSim;

  if (topSim < MIN_ACCEPT_SIM) {
    return { identity: null, confidence: topSim, abstain: true, reason: "low_sim" };
  }

  if (gap >= CLEAR_GAP) {
    return { identity: topMeta, confidence: topSim, abstain: false, reason: "clear_gap" };
  }

  // Tied top-1 and top-2 are often the same art reprinted across sets. If the Pokémon
  // name matches, accept top-1 — the user still gets the right card name/price even if
  // the specific printing is a guess.
  if (secondMeta && topMeta.name && topMeta.name === secondMeta.name && topSim >= NAME_MATCH_SIM) {
    return { identity: topMeta, confidence: topSim * 0.9, abstain: false, reason: "name_match" };
  }

  if (topSim >= HIGH_SIM) {
    return { identity: topMeta, confidence: topSim * 0.85, abstain: false, reason: "high_sim" };
  }

  const agreed = leadingName(clipHits, meta);
  if (agreed) {
    return { identity: meta[agreed.index], confidence: agreed.score * 0.9, abstain: false, reason: "name_vote" };
  }

  return { identity: null, confidence: topSim, abstain: true, reason: "ambiguous" };
}

// Hits within this of the top score are the same guess. One lookalike should
// not beat a name that shows up more often inside that band.
const NEAR_BAND = 0.02;

function leadingName(clipHits, meta) {
  const best = rankOf(clipHits[0]);
  const near = [];
  for (const hit of clipHits) {
    if (best - rankOf(hit) > NEAR_BAND) break;
    near.push(hit);
    if (near.length === 3) break;
  }
  const counts = new Map();
  for (const hit of near) {
    const name = meta[hit.index]?.name;
    if (!name) continue;
    const entry = counts.get(name) || { count: 0, hit };
    entry.count += 1;
    if (hit.score > entry.hit.score) entry.hit = hit;
    counts.set(name, entry);
  }
  let winner = null;
  let tied = false;
  for (const entry of counts.values()) {
    if (!winner || entry.count > winner.count) {
      winner = entry;
      tied = false;
    } else if (entry.count === winner.count) {
      tied = true;
    }
  }
  if (!winner || tied || winner.count < 2) return null;
  return winner.hit;
}

// Three copies of one card in a single photo is usually the matcher's favourite look-alike winning
// several boxes, not three real copies. The rows stay, with the name, but the scanner stops vouching for them.
export const REPEATED_NAME_MIN = 3;

const nameKey = (card) => (card?.abstain ? "" : String(card?.identity?.name || "").trim().toLowerCase());

/**
 * Reads of one photo's boxes. When REPEATED_NAME_MIN or more carry the same card name, each of those is
 * marked unsure (the picker is offered) and held below the "high" confidence tier. Names, ids and the
 * number of rows never change. Returns a new list; reads that are not repeated are the same objects.
 */
export function markRepeatedNames(reads) {
  const counts = new Map();
  for (const read of reads) {
    const key = nameKey(read);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return reads.map((read) => {
    const key = nameKey(read);
    if (!key || counts.get(key) < REPEATED_NAME_MIN) return read;
    return {
      ...read,
      confidence: Math.min(read.confidence, SMALL_SOURCE_CONFIDENCE_CAP),
      unsure: true,
      repeatedName: true,
    };
  });
}

// A card read from a crop shorter than this is a few hundred blurry pixels, and CLIP matches look-alike
// art with high similarity. Heights are the pixels the matcher actually sees (informationHeight).
// This rests on few samples: in the 2026-10-16 run every read we could verify against the listing title
// came from a crop of at least 271 px, and the confident wrong ones in the first report came from
// thumbnail-class crops. Grid and lot pages had no ground truth, so 300 is a conservative guess, not a fit.
export const MIN_RELIABLE_HEIGHT = 300;
// Below the "medium" tier (0.50) so the scan's picker asks the user, with the guess first.
export const SMALL_SOURCE_CONFIDENCE_CAP = 0.49;

/**
 * An automatic read from a small crop may be listed as a suggestion, but never as sure.
 * Unknown height (0 or missing) is not small. Reads that already abstained or are unsure pass through.
 */
export function capSmallSource(result, sourceHeight) {
  if (!result || result.abstain) return result;
  if (!(sourceHeight > 0) || sourceHeight >= MIN_RELIABLE_HEIGHT) return result;
  if (!(result.confidence > SMALL_SOURCE_CONFIDENCE_CAP)) return result;
  return { ...result, confidence: SMALL_SOURCE_CONFIDENCE_CAP, smallSource: true, unsure: true };
}

/**
 * Pixels of the card the matcher can really use: what was fed to it, but no more than the picture holds.
 * naturalPerFed is natural picture pixels per fed pixel (1 for a fetched source; below 1 when a small
 * picture is stretched on screen; unknown or 0 means no limit beyond what was fed).
 */
export function informationHeight(fedHeight, naturalPerFed) {
  if (!(fedHeight > 0)) return 0;
  return naturalPerFed > 0 ? fedHeight * Math.min(1, naturalPerFed) : fedHeight;
}

/** Height to cap against, or 0 for none: small tiles are normal on grid pages and are judged by the matcher. */
export function capHeightFor(pageKind, height) {
  return pageKind === "grid" ? 0 : height;
}
