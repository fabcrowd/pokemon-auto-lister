// Saving a correction against the corrections store: history and the x2 count, the cap, and a full disk.
// The store is passed in (lib/corrections-store.js), so the same code runs under test with a fake IndexedDB.

import { MAX_CORRECTIONS, nextCorrectionState, pickEvictions } from "./correction-state.js";

const isQuotaError = (err) => err?.name === "QuotaExceededError" || /quota/i.test(String(err?.message || ""));

/**
 * The user confirmed the card an earlier correction (msg.guess.memory.refId) pointed at, from another crop: that is
 * "x2" on the earlier correction instead of a near-duplicate picture. Null when this is not that case.
 * @returns {Promise<{count: number}|null>}
 */
export async function agreeWithReference(store, msg, now = Date.now()) {
  const ref = msg.guess?.memory;
  if (!ref?.refId || ref.cardId !== msg.pickedId || ref.refId === `${msg.scanId}:${msg.index}`) return null;
  const row = await store.getCorrection(ref.refId).catch(() => null);
  if (!row || row.pickedId !== msg.pickedId) return null;
  const count = (row.count || 1) + 1;
  await store.save({ ...row, count, lastAgreed: now });
  return { count };
}

/** Corrections beyond `max` are deleted, the oldest unprotected first (lib/correction-state.js), with their references. */
export async function evictCorrections(store, max = MAX_CORRECTIONS, now = Date.now()) {
  const heads = await store.correctionHeads();
  const ids = pickEvictions(heads, { max, now });
  for (const id of ids) {
    await store.deleteReference(id);
    await store.deleteCorrection(id);
  }
  return ids;
}

// A full disk must not lose the answer: make room, retry, and as a last resort keep the answer without its picture.
async function saveRow(store, record, now) {
  try {
    await store.save(record);
    return;
  } catch (err) {
    if (!isQuotaError(err)) throw err;
  }
  const count = await store.count().catch(() => 0);
  await evictCorrections(store, Math.max(0, count - 10), now).catch(() => []);
  try {
    await store.save(record);
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    await store.save({ ...record, crop: null });
  }
}

/**
 * Stores a correction record (lib/card-picker.js correctionRecord). A later answer for the same crop replaces the
 * active one but keeps the earlier answers and their why-records; the vector of the old answer goes; the cap is held.
 * @returns {Promise<object>} the row as saved (count, history)
 */
export async function storeCorrection(store, draft, { max = MAX_CORRECTIONS, now = Date.now() } = {}) {
  const previous = draft.id ? await store.getCorrection(draft.id).catch(() => null) : null;
  const record = { ...draft, ...nextCorrectionState(previous, draft) };
  // The old answer's vector must not outlive it; a failed delete is caught by the ts check in correctionsToEmbed.
  if (record.id) await store.deleteReference(record.id).catch((err) => console.error("[BG] dropping the old reference failed:", err?.message || err));
  await saveRow(store, record, now);
  await evictCorrections(store, max, now).catch((err) => console.error("[BG] evicting old corrections failed:", err?.message || err));
  return record;
}
