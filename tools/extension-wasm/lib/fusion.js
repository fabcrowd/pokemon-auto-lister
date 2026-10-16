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

// What earns the green "high" stripe is a colour/honesty signal, not a gate: a read that is accepted but does
// not qualify keeps its name and price and shows "medium". Fit on the centre-crop embeddings (crop 34bc430,
// catalog backup 2026-10-11, hub penalty off): 50 HiBid dev crops + 612 variant-photo crops; held out HiBid
// test (61) and test2 (79). With the old rule (any read with confidence of 0.80 or more) 5 of 164 fit high
// rows had the wrong name (3.0%; 1 of 18 on test, 0 of 18 on test2). With these values 0 of 84 fit, 0 of 10
// on test and 0 of 10 on test2 do. The accept thresholds above are untouched (accepted reads: 9.8% wrong
// name on the fit data, 7.5% test, 4.1% test2), so coverage is unchanged.
// Only a clear lead qualifies: same-name ties and HIGH_SIM ties are never high. The best coverage inside
// a 3% wrong-name budget was 0.02 / 0.82 (112 rows, 2.7%); one notch more lead is taken for margin because
// real-world pages were noisier than these crops. MUST be refit when the model, crop or catalog changes.
const HIGH_TIER_GAP  = 0.025;
const HIGH_TIER_SIM  = 0.82;
// Just under the "high" tier (0.80, card-display.js confTier).
export const BELOW_HIGH_CONFIDENCE = 0.79;

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
  const read = fuseUntiered(clipHits, meta);
  if (read.abstain || read.confidence <= BELOW_HIGH_CONFIDENCE) return read;
  const lead = clipHits[1] ? rankOf(clipHits[0]) - rankOf(clipHits[1]) : clipHits[0].score;
  const high = read.reason === "clear_gap" && clipHits[0].score >= HIGH_TIER_SIM && lead >= HIGH_TIER_GAP;
  return high ? read : { ...read, confidence: BELOW_HIGH_CONFIDENCE };
}

function fuseUntiered(clipHits, meta) {
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
// several boxes, not three real copies. The rows stay with their name and price; the scanner only stops
// vouching for them ("high" is removed) and the row offers an inline check.
export const REPEATED_NAME_MIN = 3;

const nameKey = (card) => (card?.abstain ? "" : String(card?.identity?.name || "").trim().toLowerCase());

/**
 * Reads of one photo's boxes. When REPEATED_NAME_MIN or more carry the same card name, each of those is
 * is held below the "high" confidence tier and flagged repeatedName for an inline check. It is not made
 * unsure, so no picker blocks the name and price. Names, ids and the number of rows never change. Returns a new list; reads that are not repeated are the same objects.
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
      confidence: Math.min(read.confidence, BELOW_HIGH_CONFIDENCE),
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

// Just under the "high" tier (0.80, card-display.js confTier): a name that is sure while the printing is not
// is shown as medium until a number, set symbol or stamp read settles the set.
export const UNCONFIRMED_SET_CONFIDENCE_CAP = BELOW_HIGH_CONFIDENCE;

/**
 * The same art is printed in several sets (Base Set, Base Set 2, Legendary Collection), so a printing that
 * rests on how the picture looks alone is a guess. That is a read with several setChoices still open, or
 * one with `setUnconfirmed` (a single printing taken from the catalog look while other sets print the same
 * name). The name and the choices stay; only the confidence drops below "high", and the old value is kept
 * as confidenceBeforeSetCap so a listing title that names the number and set can restore it. A read whose
 * set was settled by the printed number, the set symbol, an edition stamp or the rules text has no choices
 * and no flag, and is returned as is.
 */
export function capUnconfirmedSet(result) {
  if (!result || result.abstain) return result;
  const open = (result.setChoices?.length || 0) > 1 || result.setUnconfirmed === true;
  if (!open || !(result.confidence > UNCONFIRMED_SET_CONFIDENCE_CAP)) return result;
  return { ...result, confidence: UNCONFIRMED_SET_CONFIDENCE_CAP, confidenceBeforeSetCap: result.confidence };
}

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
