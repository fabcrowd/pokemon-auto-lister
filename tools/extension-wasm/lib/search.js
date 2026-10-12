// Brute-force cosine similarity search over the card catalog.
// catalog.bin.gz contains L2-normalised float32 vectors so dot-product == cosine similarity.

const DIM = 512;

let _catalog = null; // Float32Array (N × 512)
let _n       = 0;

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

  _catalog = new Float32Array(raw.buffer);
  _n       = _catalog.length / DIM;
}

/**
 * Return top-K nearest neighbours for a query embedding (Float32Array 512).
 * Embeddings must already be L2-normalised.
 * Returns [{ index, score }] sorted by descending score.
 */
export function searchCatalog(query, topK = 20) {
  if (!_catalog) throw new Error("Catalog not loaded");

  const scores = new Float32Array(_n);

  for (let i = 0; i < _n; i++) {
    const base = i * DIM;
    let dot = 0;
    for (let d = 0; d < DIM; d++) {
      dot += query[d] * _catalog[base + d];
    }
    scores[i] = dot;
  }

  // Partial sort: find top-K without sorting everything
  const indices = topKIndices(scores, topK);
  return indices.map((idx) => ({ index: idx, score: scores[idx] }));
}

/** Similarity of the query to each listed catalog row, as [{ index, score }] best first. */
export function scoreIndices(query, indices) {
  if (!_catalog) throw new Error("Catalog not loaded");
  return indices
    .map((index) => {
      const base = index * DIM;
      let dot = 0;
      for (let d = 0; d < DIM; d++) dot += query[d] * _catalog[base + d];
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
