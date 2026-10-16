import { decodeEmbedding } from '../../tools/extension-wasm/lib/references.js';
import { wilson } from './sealed-metrics.mjs';

export const DEFAULT_MINS = [0.8, 0.84, 0.88, 0.9, 0.92, 0.94, 0.96, 0.98];

/** Corrections from an export that carry a usable embedding, and how many did not. */
export function itemsFromExport(file) {
  if (!Array.isArray(file?.corrections)) throw new Error('That file has no "corrections" list. Export it from the extension settings page, under Corrections.');
  const items = [];
  for (const c of file.corrections) {
    const embedding = typeof c?.pickedId === 'string' && c.pickedId ? decodeEmbedding(c.embedding) : null;
    if (!embedding) continue;
    items.push({
      id: c.id,
      cardId: c.pickedId,
      scanId: typeof c.scanId === 'string' && c.scanId ? c.scanId : null,
      catalogTop: Number.isFinite(c.guess?.catalogTop) ? c.guess.catalogTop : null,
      embedding,
    });
  }
  return {
    items,
    skipped: file.corrections.length - items.length,
    withoutCatalogTop: items.filter((item) => item.catalogTop === null).length,
  };
}

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/**
 * For each item, its nearest item from another scan. Neighbours from the same scan are left out: they
 * show the same cards and would flatter the result. catalogTop is the catalog's top score saved with the correction.
 */
export function leaveOneOut(items) {
  const rows = [];
  items.forEach((held, at) => {
    let nearest = null;
    items.forEach((other, i) => {
      if (i === at || (held.scanId && held.scanId === other.scanId)) return;
      const score = dot(held.embedding, other.embedding);
      if (!nearest || score > nearest.score) nearest = { score, cardId: other.cardId };
    });
    if (nearest) {
      rows.push({ id: held.id, score: nearest.score, nearestCardId: nearest.cardId, correct: nearest.cardId === held.cardId, catalogTop: held.catalogTop });
    }
  });
  return rows;
}

// Without a saved catalog score the margin cannot be judged, so such a row is let through: that makes the count an upper bound.
export function summarizeAt(rows, { min, margin }) {
  const fires = rows.filter((r) => r.score >= min && (r.catalogTop === null || r.score - r.catalogTop >= margin));
  const correct = fires.filter((r) => r.correct).length;
  return { min, margin, total: rows.length, fired: fires.length, correct, interval: wilson(correct, fires.length) };
}

export function gridReport(rows, { margin, mins = DEFAULT_MINS }) {
  return mins.map((min) => summarizeAt(rows, { min, margin }));
}
