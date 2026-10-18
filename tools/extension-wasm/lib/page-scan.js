// Scanning a page taller than the window: which screens to capture, and which cards seen on two screens are one.

export const MAX_SCREENS = 12;
export const MAX_CARDS = 200;
// Chrome allows about two captureVisibleTab calls a second.
export const CAPTURE_GAP_MS = 550;

const OVERLAP = 0.1;
const SAME_CARD_IOU = 0.5;

/** Scroll positions (document y) whose screens cover the page; [0] when it fits in one. */
export function planScreens(documentHeight, viewportHeight, maxScreens = MAX_SCREENS) {
  const ys = [0];
  if (!(viewportHeight > 0) || !(documentHeight > viewportHeight)) return ys;
  const step = Math.max(1, Math.floor(viewportHeight * (1 - OVERLAP)));
  const lastTop = documentHeight - viewportHeight;
  while (ys.length < maxScreens) {
    const top = ys[ys.length - 1];
    if (top >= lastTop) break;
    ys.push(Math.min(top + step, lastTop));
  }
  return ys;
}

export function toDocBox(box, scroll) {
  return [box[0] + scroll.x, box[1] + scroll.y, box[2] + scroll.x, box[3] + scroll.y];
}

function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Whether a card read on a later screen is one already read: the same page element, or boxes that overlap by
 * more than half. The one with more of the card in view is kept.
 * @param seen [{ docBox, anchor, area }] cards from earlier screens
 * @param card { docBox, anchor, area }
 * @returns {{ verdict: "new" } | { verdict: "skip" } | { verdict: "replace", index: number }}
 */
export function judgeDuplicate(seen, card) {
  const index = seen.findIndex((other) => (card.anchor != null && card.anchor === other.anchor)
    || iou(card.docBox, other.docBox) > SAME_CARD_IOU);
  if (index < 0) return { verdict: "new" };
  return card.area > seen[index].area ? { verdict: "replace", index } : { verdict: "skip" };
}

export function cardRoom(count, cap = MAX_CARDS) {
  return Math.max(0, cap - count);
}

/** How long to wait before the next capture; null when there has been none. */
export function captureWait(lastCaptureAt, now, gap = CAPTURE_GAP_MS) {
  return lastCaptureAt == null ? 0 : Math.max(0, gap - (now - lastCaptureAt));
}

/** Whether the screen cap leaves the bottom of the page unscanned. */
export function screensCapped(documentHeight, viewportHeight) {
  return planScreens(documentHeight, viewportHeight, MAX_SCREENS + 1).length > MAX_SCREENS;
}

/** What to append to the scan message when a cap cut the scan short. */
export function truncationNote(truncated) {
  if (truncated === "cards") return ` (first ${MAX_CARDS} cards)`;
  if (truncated === "screens") return ` (first ${MAX_SCREENS} screens)`;
  return "";
}

/**
 * Whether a card just read is one already kept, or is room for it left.
 * @param slots [{ docBox, anchor, area } | null] per kept card, by index
 * @param dropped indexes of slots replaced by a better view
 * @param count cards kept so far, replaced ones not counted
 * @returns {{ verdict: "new" | "skip" | "full" } | { verdict: "replace", drop: number }}
 */
export function claimSlot(slots, dropped, slot, count) {
  const earlier = [];
  slots.forEach((seen, index) => { if (seen && !dropped.has(index)) earlier.push({ ...seen, index }); });
  const judged = judgeDuplicate(earlier, slot);
  if (judged.verdict === "skip") return { verdict: "skip" };
  if (judged.verdict === "replace") return { verdict: "replace", drop: earlier[judged.index].index };
  // A page element whose earlier view was given up for a better one is still that card. Boxes alone cannot
  // say so once the page has shifted between screens (an ad loading above the grid), but the element can.
  const owner = slot.anchor == null ? null : ownerOfAnchor(slots, dropped, slot.anchor);
  if (owner) return slot.area > owner.area ? { verdict: "replace", drop: owner.index } : { verdict: "skip" };
  return cardRoom(count) <= 0 ? { verdict: "full" } : { verdict: "new" };
}

/** The kept card that stands in for a dropped view of the page element `anchor`, or null when there is none. */
function ownerOfAnchor(slots, dropped, anchor) {
  for (let index = 0; index < slots.length; index++) {
    if (!dropped.has(index) || slots[index]?.anchor !== anchor) continue;
    // Follow the replacements to the card that is still kept.
    let at = index;
    for (let hops = 0; dropped.has(at) && hops <= slots.length; hops++) {
      at = slots.findIndex((other) => other?.replaces === at);
      if (at < 0) break;
    }
    if (at >= 0 && !dropped.has(at)) return { ...slots[at], index: at };
  }
  return null;
}

/** One scan per tab at a time. A request that arrives mid-scan may leave one follow-up for when it ends. */
export function createScanGate() {
  const running = new Map();
  return {
    busy: (tabId) => running.has(tabId),
    begin(tabId) {
      if (running.has(tabId)) return false;
      running.set(tabId, { followUp: false });
      return true;
    },
    queueFollowUp(tabId) {
      const state = running.get(tabId);
      if (!state) return false;
      state.followUp = true;
      return true;
    },
    /** @returns whether a follow-up scan was asked for while this one ran */
    end(tabId) {
      const followUp = running.get(tabId)?.followUp === true;
      running.delete(tabId);
      return followUp;
    },
  };
}

/** Whether the tab is still on the page the scan started on; a new #hash is the same page. */
export function samePage(startUrl, nowUrl) {
  if (typeof startUrl !== "string" || typeof nowUrl !== "string") return false;
  return startUrl.split("#")[0] === nowUrl.split("#")[0];
}

export function isCaptureQuotaError(err) {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(err?.message ?? err ?? ""));
}
