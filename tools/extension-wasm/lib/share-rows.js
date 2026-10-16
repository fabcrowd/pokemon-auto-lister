// How scan rows become contribution rows (lib/contribution.js has the schema). Pure, so the rules are testable.

import { normalizeBox, scannerOf } from "./contribution.js";
import { splitOf } from "./photo-id.js";

/** What a scan keeps about one card so a later pick or confirmation can be sent: its photo, split, place in it, and the scanner's own answer. */
export function shareFor({ photoId, box, width, height, card }) {
  const normalized = normalizeBox(box, width, height);
  return normalized ? { photoId, split: splitOf(photoId), box: normalized, scanner: scannerOf(card) } : null;
}

/** One picker pick or "Wrong card?" fix on a teach photo. */
export function teachRow({ share, crop, pickedId, via }) {
  return { box: share.box, crop, answer: { cardId: pickedId }, scanner: share.scanner, source: via === "wrong-card" ? "wrong-card" : "pick" };
}

/** photoId -> card indices, for the exam photos of a scan, in order. */
export function examGroups(shares) {
  const groups = new Map();
  (shares || []).forEach((share, index) => {
    if (share?.split !== "exam") return;
    if (!groups.has(share.photoId)) groups.set(share.photoId, []);
    groups.get(share.photoId).push(index);
  });
  return groups;
}

export const wantsExamPrompt = (shares) => examGroups(shares).size > 0;

/**
 * Every row of one exam photo. A fix the user made wins; otherwise the popup's own displayed answer is confirmed
 * (a card id the catalog does not know, or nothing, is "unknown"). Null when any row has no picture, because an
 * exam contribution must hold every row of its photo.
 * @param picks index -> { cardId, source }
 * @param displayed index -> { cardId } | { notACard: true } | { unknown: true }
 */
export function examRows({ shares, indices, crops, picks, displayed, known }) {
  const rows = [];
  for (const index of indices) {
    const crop = crops[index];
    if (!crop) return null;
    const pick = picks[index];
    const shown = displayed[index];
    let answer = { unknown: true };
    let source = "confirm";
    if (pick) {
      answer = { cardId: pick.cardId };
      source = pick.source;
    } else if (shown?.notACard === true) {
      answer = { notACard: true };
    } else if (typeof shown?.cardId === "string" && known(shown.cardId)) {
      answer = { cardId: shown.cardId };
    }
    rows.push({ box: shares[index].box, crop, answer, scanner: shares[index].scanner, source });
  }
  return rows;
}
