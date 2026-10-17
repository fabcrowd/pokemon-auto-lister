// The photo adapter: a low-rank linear map applied to an embedding, e' = normalize(e + U (Vt e)).
// It is applied to query embeddings and to catalog rows alike, so both sit in the same space.

const DIM = 512;

/** @param adapter { rank, u, v } with u and v as Float32Array(DIM * rank), row-major (row d, column k at d * rank + k) */
export function adaptVector(embedding, adapter, out = new Float32Array(DIM)) {
  const { rank, u, v } = adapter;
  const t = new Float32Array(rank);
  for (let d = 0; d < DIM; d++) {
    const x = embedding[d];
    if (x === 0) continue;
    const base = d * rank;
    for (let k = 0; k < rank; k++) t[k] += v[base + k] * x;
  }
  let norm = 0;
  for (let d = 0; d < DIM; d++) {
    const base = d * rank;
    let sum = embedding[d];
    for (let k = 0; k < rank; k++) sum += u[base + k] * t[k];
    out[d] = sum;
    norm += sum * sum;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < DIM; d++) out[d] /= norm;
  return out;
}

const ROWS_PER_TURN = 2000;
const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The adapted copy of every row in a Float32Array(n * DIM). Yields to the event loop now and then so a worker stays responsive. */
export async function adaptRows(rows, adapter) {
  const n = rows.length / DIM;
  const out = new Float32Array(rows.length);
  for (let i = 0; i < n; i++) {
    adaptVector(rows.subarray(i * DIM, (i + 1) * DIM), adapter, out.subarray(i * DIM, (i + 1) * DIM));
    if ((i + 1) % ROWS_PER_TURN === 0) await nextTurn();
  }
  return out;
}
