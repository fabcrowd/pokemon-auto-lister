// What memory (lib/references.js applyMemory) does to the fused read: a confirm-level reference makes the card the
// user corrected CONFIRMED, source "your correction"; negative memory stops a card the user called wrong from being
// confirmed again. Pure; the background calls it right after fuseResults.

import { BELOW_HIGH_CONFIDENCE, SMALL_SOURCE_CONFIDENCE_CAP } from "./fusion.js";

/**
 * @param fused the read fuseResults returned
 * @param memory applyMemory's `memory` (or null)
 * @param {{hits: object[], meta: object[]}} context the hits AFTER memory (the corrected card first) and the catalog rows
 * @returns {{fused: object, confirmedBy: 'correction'|null, negative: boolean}}
 */
export function memoryVerdict(fused, memory, { hits, meta }) {
  const same = { fused, confirmedBy: null, negative: false };
  if (!memory || !fused) return same;
  const confirmedNow = !fused.abstain && fused.reason === "confirmed" && Boolean(fused.identity);
  if (memory.level === "confirm") {
    const top = meta?.[hits?.[0]?.index];
    if (!top || top.id !== memory.cardId) return same;
    if (confirmedNow && fused.identity.id === memory.cardId) return same;
    // The evidence is the user's own label, so the picture rows are bypassed. Never "high": that tier is the picture's.
    const next = { identity: top, confidence: BELOW_HIGH_CONFIDENCE, abstain: false, reason: "your-correction" };
    return { fused: next, confirmedBy: "correction", negative: false };
  }
  if (memory.level === "negative" && confirmedNow && fused.identity.id === memory.wrongId) {
    const next = { ...fused, confidence: Math.min(fused.confidence ?? 0, SMALL_SOURCE_CONFIDENCE_CAP), reason: "choose", choose: true };
    return { fused: next, confirmedBy: null, negative: true };
  }
  return same;
}
