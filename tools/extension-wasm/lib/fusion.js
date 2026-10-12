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
  const secondSim = second ? second.score : 0;
  const gap       = topSim - secondSim;

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
  const best = clipHits[0].score;
  const near = [];
  for (const hit of clipHits) {
    if (best - hit.score > NEAR_BAND) break;
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
