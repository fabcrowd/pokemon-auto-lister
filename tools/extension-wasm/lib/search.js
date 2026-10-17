// Brute-force cosine similarity search over the card catalog.
// catalog.bin.gz contains L2-normalised float32 vectors so dot-product == cosine similarity.

import { adaptVector } from "./adapter.js";

const DIM = 512;

let _base    = null; // Float32Array, the catalog that ships in the extension
let _catalog = null; // Float32Array (N × 512): base plus any rows from the bundle's catalogExtra
let _rows    = null; // what is searched: _catalog, or its adapted copy while an adapter is live
let _adapter = null; // applied to every query while _rows is the adapted copy
let _n       = 0;
let _baseN   = 0;

// Optional per-row penalty for look-alike "hub" cards that real photos match for the wrong reasons.
// One signed byte per catalog row, in thousandths of cosine (scripts/build-hub-penalty.py).
const PENALTY_UNIT = 0.001;
let _penalty = null; // Int8Array, one per catalog row
let _penaltyWarned = false;

/** Keep the penalty file's bytes (ArrayBuffer or typed array) for searches that ask for it; null clears. */
export function loadHubPenalty(bytes) {
  _penaltyWarned = false;
  if (!bytes) {
    _penalty = null;
    return;
  }
  _penalty = bytes instanceof ArrayBuffer ? new Int8Array(bytes) : new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// A penalty built for another catalog would move the wrong rows, so a size mismatch turns it off.
// Rows appended after the shipped catalog have no penalty.
function usablePenalty() {
  if (!_penalty) return null;
  if (_penalty.length === _baseN) return _penalty;
  if (!_penaltyWarned) {
    _penaltyWarned = true;
    console.warn(`[search] hub penalty has ${_penalty.length} rows but the catalog has ${_baseN}; ignoring it`);
  }
  return null;
}

/**
 * Load and decompress catalog.bin.gz (ArrayBuffer).
 * Must be called once before searchCatalog().
 */
export async function loadCatalog(gzBuffer) {
  const ds     = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(gzBuffer);
  writer.close();

  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  let totalBytes = 0;
  for (const c of chunks) totalBytes += c.byteLength;

  const raw = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    raw.set(c, offset);
    offset += c.byteLength;
  }

  _base = new Float32Array(raw.buffer);
  _baseN = _base.length / DIM;
  configureCatalog({});
}

/** True while an adapter is live, so a raw search differs from the normal one. */
export const adapterActive = () => _adapter !== null;

/** The shipped catalog's rows followed by `extra` rows (a new array when there are any). */
export function catalogRowsWith(extra = null) {
  if (!_base) throw new Error("Catalog not loaded");
  if (!extra?.length) return _base;
  const all = new Float32Array(_base.length + extra.length);
  all.set(_base, 0);
  all.set(extra, _base.length);
  return all;
}

/**
 * Sets what is searched on top of the shipped catalog, all at once so a search never sees half of it:
 * `extra` rows are appended; `adapter` is applied to each query and `adapted` (the adapter applied to every
 * row of base + extra) is what gets searched. An adapted copy of the wrong size is ignored, so the two
 * embedding spaces are never mixed.
 */
export function configureCatalog({ extra = null, adapter = null, adapted = null }) {
  if (!_base) throw new Error("Catalog not loaded");
  _catalog = catalogRowsWith(extra);
  _n = _catalog.length / DIM;
  if (adapter && adapted?.length === _catalog.length) {
    _adapter = adapter;
    _rows = adapted;
  } else {
    _adapter = null;
    _rows = _catalog;
  }
}

/**
 * Return top-K nearest neighbours for a query embedding (Float32Array 512).
 * Embeddings must already be L2-normalised.
 * Returns [{ index, score }] sorted by descending score.
 *
 * With { penalty: true } and a matching penalty loaded, rows are ranked by cosine minus their penalty and
 * returned as [{ index, score, rank }] best rank first. `score` stays the row's own cosine, so every
 * threshold that reads it (confidence, card-back check) means the same as without the penalty; `rank` is
 * only for order and for gaps between neighbours.
 */
export function searchCatalog(query, topK = 20, { penalty = false, raw = false } = {}) {
  if (!_rows) throw new Error("Catalog not loaded");
  // raw: the unadapted query against the unadapted rows, what the search was before any adapter.
  const useAdapter = _adapter && !raw;
  const q = useAdapter ? adaptVector(query, _adapter) : query;
  const rows = useAdapter ? _rows : _catalog;

  const scores = new Float32Array(_n);

  for (let i = 0; i < _n; i++) {
    const base = i * DIM;
    let dot = 0;
    for (let d = 0; d < DIM; d++) {
      dot += q[d] * rows[base + d];
    }
    scores[i] = dot;
  }

  const offsets = penalty ? usablePenalty() : null;
  if (offsets) {
    const ranks = new Float32Array(_n);
    for (let i = 0; i < _n; i++) ranks[i] = scores[i] - (i < offsets.length ? offsets[i] : 0) * PENALTY_UNIT;
    return topKIndices(ranks, topK).map((idx) => ({ index: idx, score: scores[idx], rank: ranks[idx] }));
  }

  // Partial sort: find top-K without sorting everything
  const indices = topKIndices(scores, topK);
  return indices.map((idx) => ({ index: idx, score: scores[idx] }));
}

/** Similarity of the query to each listed catalog row, as [{ index, score }] best first. */
export function scoreIndices(query, indices) {
  if (!_rows) throw new Error("Catalog not loaded");
  const q = _adapter ? adaptVector(query, _adapter) : query;
  return indices
    .map((index) => {
      const base = index * DIM;
      let dot = 0;
      for (let d = 0; d < DIM; d++) dot += q[d] * _rows[base + d];
      return { index, score: dot };
    })
    .sort((a, b) => b.score - a.score);
}

// TCG Pocket ids (A1-…, A3b-…, B1-…, P-A-…) are digital-only cards.
const DIGITAL_ONLY = /^(A\d|B\d|P-A)/;

/** Drop hits that are digital-only cards; keeps order and scores. */
export function physicalHits(hits, meta) {
  return hits.filter((h) => !DIGITAL_ONLY.test(String(meta[h.index]?.id || "")));
}

function topKIndices(arr, k) {
  const heap = []; // min-heap of {score, idx}

  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (heap.length < k) {
      heap.push({ score: s, idx: i });
      if (heap.length === k) heapify(heap);
    } else if (s > heap[0].score) {
      heap[0] = { score: s, idx: i };
      siftDown(heap, 0);
    }
  }

  heap.sort((a, b) => b.score - a.score);
  return heap.map((h) => h.idx);
}

function heapify(arr) {
  for (let i = Math.floor(arr.length / 2) - 1; i >= 0; i--) siftDown(arr, i);
}

function siftDown(arr, i) {
  const n = arr.length;
  while (true) {
    let smallest = i;
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    if (l < n && arr[l].score < arr[smallest].score) smallest = l;
    if (r < n && arr[r].score < arr[smallest].score) smallest = r;
    if (smallest === i) break;
    [arr[i], arr[smallest]] = [arr[smallest], arr[i]];
    i = smallest;
  }
}
