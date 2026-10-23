// Identity resolution over a ranked list of CLIP catalog hits.
//
// The catalog contains many near-duplicate card artworks (Base Set reprints across
// Legendary Collection, Expedition, etc.) so a strict margin threshold rejects most
// correct top-1 matches.
//
// A read is CONFIRMED by the per-height rule in confirmDecision (below). The rival that counts is the best card
// with ANOTHER name; same-name printings never block a confirmation. A read the rule does not confirm is a CHOOSE:
// if the older gate still finds a name for it, it is returned unsure (the picker asks, the guess first);
// otherwise it abstains. The older gate (kept for exactly that fallback) accepts when any of these holds:
//   1. Top-1 raw CLIP similarity is clearly ahead of top-2 (gap ≥ CLEAR_GAP)
//   2. Top-1 and top-2 share the same Pokémon name — same art, different printings
//   3. Top-1 similarity is very high in absolute terms (likely exact catalog match)
//   4. Among the top 3 near-tied hits, one name appears more often than the others

import { choiceName } from "./set-choice.js";

const MIN_ACCEPT_SIM = 0.72;  // below this the fallback gate abstains
export const CLEAR_GAP = 0.02;  // gap over #2 that definitively accepts
const HIGH_SIM       = 0.85;  // absolute similarity that overrides gap
const NAME_MATCH_SIM = 0.75;  // if top-1/top-2 share a name, require this much sim

// Per-height confirm rule, fitted for model E (clip v3.0, sha256 0dba1302...) on the geometry set; see
// data/reports/fusion-study-E/README.md in card-scanner-data (section 1), with the thresholds raised to the floor
// analysis in data/reports/fusion-study-E/floor/README.md (2026-10-23): the first rows confirmed cards that are not
// in the catalog (QA D-1: Regice ex at 312 px and Regirock ex at 334 px, both cosine 0.73, were confirmed with real
// prices), and the floors below are the rows where cosine stops confirming them. Refit whenever the model, the crop or
// the catalog changes. Not tuned here: do not adjust a number without a new study.
//   a_c = cos_c - TITLE_NAME_PENALTY when the card's title line spells ANOTHER catalog name than c's (silent or
//         unreadable title = no change, no bonus)
//   CONFIRM iff height >= CONFIRM_MIN_HEIGHT and a_top >= T(height) and
//         a_top - max{a_c : choiceName(c) != choiceName(top)} >= G(height); else CHOOSE.
// Between fitted heights the pair of the next lower fitted height applies. An unknown height (0, missing or not
// finite: grid-page tiles and the legacy scan path) uses the 200-249 px row (UNKNOWN_HEIGHT_ROW). Thumbnails are about
// 200 px, so the lowest fitted row is the conservative analog; the native row's G=0 was fitted on large crops and
// confirmed a Double Colorless Energy tile as Lightning Energy with no lead, while its T=0.72 was too strict for
// 140 px thumbnails and dropped correctly-read tiles to CHOOSE.
export const CONFIRM_MIN_HEIGHT = 200;
export const TITLE_NAME_PENALTY = 0.05;
export const CONFIRM_ROWS = Object.freeze([
  Object.freeze({ minHeight: 350, minSim: 0.76, minGap: 0.02 }),
  Object.freeze({ minHeight: 300, minSim: 0.74, minGap: 0.02 }),
  Object.freeze({ minHeight: 250, minSim: 0.72, minGap: 0.03 }),
  Object.freeze({ minHeight: 200, minSim: 0.68, minGap: 0.03 }),
]);

// Small photos (100-199 px) never confirm. A read that clears one of these rows stays a CHOOSE but is flagged
// (smallRow, smallRowCos) so the popup may look at the price of its top candidate: cheap cards are then confirmed
// automatically (lib/stakes.js). Same lead semantics as CONFIRM_ROWS (lead over the best card with ANOTHER name,
// same-name printings never block), but on raw cosines: the title line is not read below 200 px, so no demotion.
// The numbers are a product decision, not a fitted row; a read under 100 px is never flagged.
export const SMALL_MIN_HEIGHT = 100;
export const SMALL_ROWS = Object.freeze([
  Object.freeze({ minHeight: 150, minSim: 0.65, minGap: 0.05 }),
  Object.freeze({ minHeight: 100, minSim: 0.68, minGap: 0.05 }),
]);
export const UNKNOWN_HEIGHT_ROW = CONFIRM_ROWS.find((r) => r.minHeight === 200);
const CONFIRM_EPSILON = 1e-9;   // float slack so a value exactly at T or G passes

/** The CONFIRM row a read height falls in; null under CONFIRM_MIN_HEIGHT, the 200 px row when the height is unknown. */
export function confirmRowFor(height) {
  const known = Number.isFinite(height) && height > 0;
  if (!known) return UNKNOWN_HEIGHT_ROW;
  return height < CONFIRM_MIN_HEIGHT ? null : CONFIRM_ROWS.find((r) => height >= r.minHeight);
}

/**
 * Whether the picture (and the title line, when readable) confirms the top card at this card height.
 * contradicts(name) is true when the title spells another catalog name than `name`; omit when there is no title.
 * @returns {{confirm: boolean, aTop: number, margin: number}}
 */
export function confirmDecision(clipHits, meta, { height = 0, contradicts = null } = {}) {
  const top = clipHits?.[0];
  if (!top || !meta?.[top.index]) return { confirm: false, aTop: 0, margin: 0 };
  const topName = meta[top.index].name;
  const adjusted = (hit) => hit.score - (contradicts?.(meta[hit.index]?.name) ? TITLE_NAME_PENALTY : 0);
  const aTop = adjusted(top);
  const topKey = choiceName(topName);
  let rival = -Infinity;
  for (const hit of clipHits.slice(1)) {
    const name = meta[hit.index]?.name;
    if (choiceName(name) === topKey) continue;
    rival = Math.max(rival, adjusted(hit));
  }
  const margin = aTop - rival;
  const known = Number.isFinite(height) && height > 0;
  if (known && height < CONFIRM_MIN_HEIGHT) return { confirm: false, aTop, margin };
  const row = confirmRowFor(height);
  const confirm = aTop + CONFIRM_EPSILON >= row.minSim && margin + CONFIRM_EPSILON >= row.minGap;
  return { confirm, aTop, margin };
}

/**
 * Whether a read under 200 px clears its small row (SMALL_ROWS). Only a known height from 100 to 199 px can.
 * @returns {{pass: boolean, cos: number, lead: number}} cos is the raw top similarity, lead its margin over the best other-name card
 */
export function smallRowDecision(clipHits, meta, { height = 0 } = {}) {
  const top = clipHits?.[0];
  const none = { pass: false, cos: top?.score ?? 0, lead: 0 };
  if (!top || !meta?.[top.index]) return none;
  if (!(Number.isFinite(height) && height >= SMALL_MIN_HEIGHT && height < CONFIRM_MIN_HEIGHT)) return none;
  const topKey = choiceName(meta[top.index].name);
  let rival = -Infinity;
  for (const hit of clipHits.slice(1)) {
    if (choiceName(meta[hit.index]?.name) === topKey) continue;
    rival = Math.max(rival, hit.score);
  }
  const lead = top.score - rival;
  const row = SMALL_ROWS.find((r) => height >= r.minHeight);
  const pass = top.score + CONFIRM_EPSILON >= row.minSim && lead + CONFIRM_EPSILON >= row.minGap;
  return { pass, cos: top.score, lead };
}

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
 *
 * @returns {{ identity: object|null, confidence: number, abstain: boolean, reason?: string }}
 */
// Hits from a hub-penalised search carry `rank` (cosine minus penalty) beside `score` (the cosine itself).
// Order and the distance between neighbours are judged on rank; what a similarity means, on score.
const rankOf = (hit) => hit.rank ?? hit.score;

export function fuseResults(clipHits, _ocrText, meta, _idMap, options = {}) {
  if (!confirmDecision(clipHits, meta, options).confirm) {
    const fallback = fuseUntiered(clipHits, meta);
    const small = smallRowDecision(clipHits, meta, options);
    const flag = small.pass ? { smallRow: true, smallRowCos: small.cos } : {};
    if (fallback.abstain) return { ...fallback, ...flag };
    // CHOOSE: the picture has a guess but the rule does not vouch for it. Below "medium" so the picker asks.
    return { ...fallback, ...flag, confidence: Math.min(fallback.confidence, SMALL_SOURCE_CONFIDENCE_CAP), reason: "choose", choose: true };
  }
  const topSim = clipHits[0].score;
  const read = { identity: meta[clipHits[0].index], confidence: topSim, abstain: false, reason: "confirmed" };
  if (read.confidence <= BELOW_HIGH_CONFIDENCE) return read;
  const lead = clipHits[1] ? rankOf(clipHits[0]) - rankOf(clipHits[1]) : topSim;
  const high = topSim >= HIGH_TIER_SIM && lead >= HIGH_TIER_GAP;
  return high ? read : { ...read, confidence: BELOW_HIGH_CONFIDENCE };
}

/**
 * With a photo adapter live, "high" must also hold on the raw (unadapted) search, as the nightly gate scores it:
 * the final top card must be the raw top card, and the raw read must itself be high. Otherwise the adapter or
 * memory changed the answer, which is advisory and never high. Without an adapter rawHits is the same array as hits.
 */
export function capAdapterChange(result, hits, rawHits, meta, options = {}) {
  if (!result || result.abstain || rawHits === hits || result.confidence <= BELOW_HIGH_CONFIDENCE) return result;
  const rawRead = rawHits?.length ? fuseResults(rawHits, null, meta, null, options) : null;
  const same = hits[0] && rawHits?.[0] && meta[hits[0].index]?.id === meta[rawHits[0].index]?.id;
  if (same && rawRead && !rawRead.abstain && rawRead.confidence > BELOW_HIGH_CONFIDENCE) return result;
  return { ...result, confidence: BELOW_HIGH_CONFIDENCE, confidenceBeforeAdapterCap: result.confidence };
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
 * and no flag, and is returned as is. Another version of the same Pokémon within reach (versionChoices) holds
 * a read below "high" in the same way, though the row keeps its own price.
 */
export function capUnconfirmedSet(result) {
  if (!result || result.abstain) return result;
  const open = (result.setChoices?.length || 0) > 1 || result.setUnconfirmed === true || (result.versionChoices?.length || 0) > 0;
  if (!open || !(result.confidence > UNCONFIRMED_SET_CONFIDENCE_CAP)) return result;
  return { ...result, confidence: UNCONFIRMED_SET_CONFIDENCE_CAP, confidenceBeforeSetCap: result.confidence };
}

/**
 * A read the confirm rule did not vouch for (fuseResults flagged it `choose`) is returned as a suggestion: its name
 * stays, but it is unsure so the picker asks. Under CONFIRM_MIN_HEIGHT it is also flagged smallSource (a known
 * height only; 0 or missing is unknown, not small). Abstained and confirmed reads pass through unchanged.
 */
export function markChoose(result, height) {
  if (!result?.choose) return result;
  const rest = { ...result };
  delete rest.choose;
  if (rest.abstain) return rest;
  const small = height > 0 && height < CONFIRM_MIN_HEIGHT;
  return { ...rest, confidence: Math.min(rest.confidence ?? 0, SMALL_SOURCE_CONFIDENCE_CAP), unsure: true, ...(small ? { smallSource: true } : {}) };
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
