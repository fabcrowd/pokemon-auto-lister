// Reference memory: the embedding of each crop the user corrected, so a card seen and
// corrected once can be found by looking, not only by the catalog.

import { EMBEDDING_VERSION } from "./embed.js";
import { BAR_EPSILON, CONFLICT_GAP, referenceBar } from "./reference-bars.js";
import { SKIP_ID, skipHit } from "./skip.js";

export const EMBEDDING_DIM = 512;
const UNIT_TOLERANCE = 1e-3;

// The user's own references use the per-height bars in reference-bars.js (measured, data/reports/g12). The community
// pack rows were never measured at those bars, so they keep the old conservative cut and only ever boost.
export const PACK_REFERENCE_MIN = 0.93;
export const REFERENCE_MARGIN = 0.02;
export { REFERENCE_BARS, referenceBar } from "./reference-bars.js";

// A vector made with another art crop sits in a different place and says nothing about this one.
// Rows saved before versions existed have no `v`; they are version 1, the stretched crop.
const isCurrentVersion = (ref) => (ref?.v ?? 1) === EMBEDDING_VERSION;

/**
 * The best reference for a query embedding, or null. It counts only if its cosine
 * similarity reaches `min` and beats the top catalog score by `margin`. The caller may use it
 * only to reorder cards the catalog already returned, never as a score of its own.
 * @param refs [{ cardId, embedding, scale? }] with L2-normalised 512-float embeddings; bundle memory rows are int8
 *   with scale 1/127
 */
export function referenceHit(query, refs, catalogTopScore, { min = PACK_REFERENCE_MIN, margin = REFERENCE_MARGIN } = {}) {
  let best = null;
  for (const ref of refs || []) {
    const vec = ref.embedding;
    if (!isCurrentVersion(ref)) continue;
    if (!vec || vec.length !== EMBEDDING_DIM) continue;
    let dot = 0;
    for (let d = 0; d < EMBEDDING_DIM; d++) dot += query[d] * vec[d];
    dot *= ref.scale ?? 1;
    if (!Number.isFinite(dot)) continue;
    if (!best || dot > best.score) best = { cardId: ref.cardId, score: dot };
  }
  if (!best || best.score < min || best.score - catalogTopScore < margin) return null;
  return best;
}

export function encodeEmbedding(vec) {
  const bytes = new Uint8Array(Float32Array.from(vec).buffer);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The Float32Array an export wrote, or null unless it is exactly 512 finite floats of unit length. */
export function decodeEmbedding(text) {
  if (typeof text !== "string" || !text) return null;
  let binary;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  if (binary.length !== EMBEDDING_DIM * 4) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const vec = new Float32Array(bytes.buffer);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  return Number.isFinite(norm) && Math.abs(Math.sqrt(norm) - 1) <= UNIT_TOLERANCE ? vec : null;
}

// ts says which answer the vector was made from: a replaced correction keeps its id but gets a new ts.
export function referenceRow(correction, embedding) {
  return {
    id: correction.id, cardId: correction.pickedId, ts: correction.ts, v: EMBEDDING_VERSION, embedding,
    // wrongId: the card the scanner had shown that the user said was wrong (negative memory); n: how often they agreed.
    wrongId: correction.wrongId ?? null, n: correction.count || 1,
  };
}

const isCurrent = (ref, correction) => Boolean(ref) && isCurrentVersion(ref) && ref.ts === correction.ts && ref.cardId === correction.pickedId;

/** Corrections (or light heads with hasCrop) that have a crop but no reference made from their current answer. */
export function correctionsToEmbed(corrections, refs) {
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  return corrections.filter((c) => (c.crop || c.hasCrop) && !isCurrent(byId.get(c.id), c));
}

/** References still made from their correction's current answer, with the current crop; imported ones (ts null) have no correction. */
export function currentReferences(refs, heads) {
  const byId = new Map(heads.map((head) => [head.id, head]));
  return refs.filter((ref) => {
    if (!isCurrentVersion(ref)) return false;
    if (ref.ts == null) return true;
    const head = byId.get(ref.id);
    return Boolean(head) && head.ts === ref.ts && head.pickedId === ref.cardId;
  }).map((ref) => {
    // The agreement count and the wrong card live on the correction, which may have changed since the vector was made.
    const head = byId.get(ref.id);
    return head ? { ...ref, n: head.count || 1, wrongId: head.wrongId ?? ref.wrongId ?? null } : ref;
  });
}

/**
 * Runs `task` one at a time. A request made while it runs, even in the last instant, makes it run once more.
 * The check for another request and the end of the flight happen with no await between them.
 */
export function singleFlight(task, onError = () => {}) {
  let running = null;
  let again = false;
  return function request() {
    again = true;
    if (running) return running;
    running = (async () => {
      // Yield first so `running` is set before the task can ask again.
      await null;
      try {
        while (again) {
          again = false;
          try {
            await task();
          } catch (err) {
            onError(err);
          }
        }
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/** Copies of the corrections, each with its embedding as base64 when a current reference exists. */
export function withEmbeddings(corrections, refs) {
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  return corrections.map((c) => {
    const ref = byId.get(c.id);
    return isCurrent(ref, c) ? { ...c, embedding: encodeEmbedding(ref.embedding), embeddingVersion: ref.v } : { ...c };
  });
}

/**
 * Moves a card the catalog already returned to the front at the top score, so fusion sees a tie
 * and the unsure picker can still appear. A card that is not in the hits is never added.
 */
export function promoteHit(hits, index) {
  const at = hits.findIndex((h) => h.index === index);
  if (at <= 0) return hits;
  return [{ index, score: hits[0].score, ...(hits[0].rank === undefined ? {} : { rank: hits[0].rank }) }, ...hits.filter((_, i) => i !== at)];
}

const cosineOf = (query, ref) => {
  const vec = ref.embedding;
  if (!isCurrentVersion(ref) || ref.superseded || !vec || vec.length !== EMBEDDING_DIM) return null;
  let dot = 0;
  for (let d = 0; d < EMBEDDING_DIM; d++) dot += query[d] * vec[d];
  dot *= ref.scale ?? 1;
  return Number.isFinite(dot) ? dot : null;
};

/**
 * What the user's corrections say about a new crop: the best reference by cosine, as a level.
 *   'confirm' at or above the band's C, 'boost' at or above B; null below B, under 100 px, or when the reference does
 *   not beat the RAW catalog top by REFERENCE_MARGIN. Two different cards within CONFLICT_GAP of each other are a
 *   conflict: the best one only boosts. The caller may use it only for cards the catalog already returned.
 * @returns {{level: 'confirm'|'boost', cardId: string, score: number, refId: string, n: number, ts: number|null, conflict?: true}|null}
 */
export function memoryHit(query, refs, catalogTopScore, { height = 0, margin = REFERENCE_MARGIN } = {}) {
  const bar = referenceBar(height);
  if (!bar) return null;
  let best = null;
  const bestByCard = new Map();
  for (const ref of refs || []) {
    const score = cosineOf(query, ref);
    if (score === null) continue;
    if (!bestByCard.has(ref.cardId) || score > bestByCard.get(ref.cardId)) bestByCard.set(ref.cardId, score);
    if (!best || score > best.score) best = { cardId: ref.cardId, score, refId: ref.id, n: ref.n || 1, ts: ref.ts ?? null };
  }
  if (!best || best.score + BAR_EPSILON < bar.boost || best.score - catalogTopScore + BAR_EPSILON < margin) return null;
  const conflict = [...bestByCard].some(([cardId, score]) => cardId !== best.cardId && best.score - score < CONFLICT_GAP && score + BAR_EPSILON >= bar.boost);
  const confirm = !conflict && best.score + BAR_EPSILON >= bar.confirm;
  return { ...best, level: confirm ? "confirm" : "boost", ...(conflict ? { conflict: true } : {}) };
}

/**
 * Negative memory: a reference whose correction said `wrongId` was wrong, close to this crop (at B), while that card is
 * what the catalog now puts on top. No margin: this only stops a confirmation, it never adds one.
 */
export function negativeHit(query, refs, wrongId, { height = 0 } = {}) {
  const bar = referenceBar(height);
  if (!bar || !wrongId) return null;
  let best = null;
  for (const ref of refs || []) {
    if (ref.wrongId !== wrongId) continue;
    const score = cosineOf(query, ref);
    if (score === null || score + BAR_EPSILON < bar.boost) continue;
    if (!best || score > best.score) best = { cardId: ref.cardId, score, refId: ref.id, n: ref.n || 1, ts: ref.ts ?? null };
  }
  return best;
}

/**
 * Memory and the user's references, applied to the catalog hits the way the nightly gate (pipeline/gate.py) scores
 * them: the RAW query against the rows, beaten against the RAW catalog top score, and only a card the (possibly
 * adapted) hits already list is promoted. `hits` may come from an adapted search; `rawTop` never does.
 * `pack` (community rows) only boosts, at PACK_REFERENCE_MIN. `height` is the read height of this crop.
 * @returns {{hits: object[], referencedId: string|null, memory: object|null}} memory: {level: 'confirm'|'boost'|'negative', cardId, cos, refId, n, ts, ...}
 */
export function applyMemory(rawEmbedding, rows, hits, rawTop, meta, { height = 0, pack = [] } = {}) {
  // A skip row is not a card reference: it only ever stops a confirmation (lib/skip.js skipHit).
  const own = rows.filter((row) => row.cardId !== SKIP_ID);
  const base = applyCardMemory(rawEmbedding, own, hits, rawTop, meta, { height, pack });
  const skip = own.length === rows.length ? null : skipHit(rawEmbedding, rows, { height });
  return skip ? { ...base, skip } : base;
}

function applyCardMemory(rawEmbedding, rows, hits, rawTop, meta, { height = 0, pack = [] } = {}) {
  const none = { hits, referencedId: null, memory: null };
  if (!rows.length && !pack.length) return none;
  let hit = memoryHit(rawEmbedding, rows, rawTop, { height });
  if (!hit && pack.length) {
    const packed = referenceHit(rawEmbedding, pack, rawTop);
    if (packed) hit = { level: "boost", cardId: packed.cardId, score: packed.score, refId: null, n: 1, ts: null, pack: true };
  }
  if (hit) {
    const at = hits.findIndex((h) => meta[h.index]?.id === hit.cardId);
    if (at < 0) return none;
    const { score, ...rest } = hit;
    const movedFrom = meta[hits[0]?.index]?.id ?? null;
    // moved: the reference, not the catalog, put this card on top; the picture score it now carries is the old top's.
    return { hits: promoteHit(hits, hits[at].index), referencedId: hit.cardId, memory: { ...rest, cos: score, moved: movedFrom !== hit.cardId, movedFrom } };
  }
  const topId = meta[hits[0]?.index]?.id;
  const negative = negativeHit(rawEmbedding, rows, topId, { height });
  if (!negative) return none;
  const at = hits.findIndex((h) => meta[h.index]?.id === negative.cardId);
  return {
    hits: at < 0 ? hits : promoteHit(hits, hits[at].index),
    referencedId: negative.cardId,
    memory: { level: "negative", cardId: negative.cardId, cos: negative.score, refId: negative.refId, n: negative.n, ts: negative.ts, wrongId: topId },
  };
}

/**
 * The reference rows an export needs: the current ones, plus a fresh embedding for every
 * correction that lacks one. New rows go to `onEmbedded`, which decides whether to keep them.
 * A failure on one crop is logged and counted and the rest go on; if every crop fails the cause is
 * thrown, because a file with no fingerprints would look like a finished export.
 * @returns {{ rows: object[], failed: number, firstError: string|null }}
 */
export async function referencesForExport({
  heads, refs, getCorrection, embedCrop, onProgress, onEmbedded,
  onError = (err) => console.error("[export] embedding a correction failed:", err?.message || err),
}) {
  const missing = correctionsToEmbed(heads, refs);
  const missingIds = new Set(missing.map((head) => head.id));
  const rows = currentReferences(refs, heads).filter((ref) => !missingIds.has(ref.id));
  let failed = 0;
  let done = 0;
  let firstError = null;
  for (const head of missing) {
    try {
      const correction = await getCorrection(head.id);
      if (correction?.crop && correction.ts === head.ts) {
        const row = referenceRow(correction, await embedCrop(correction.crop));
        rows.push(row);
        await onEmbedded?.(row);
      }
    } catch (err) {
      failed += 1;
      firstError ??= String(err?.message || err);
      onError(err);
    }
    done += 1;
    onProgress?.({ done, total: missing.length });
  }
  if (missing.length > 0 && failed === missing.length) throw new Error(`Couldn't read the saved pictures: ${firstError}`);
  return { rows, failed, firstError };
}
