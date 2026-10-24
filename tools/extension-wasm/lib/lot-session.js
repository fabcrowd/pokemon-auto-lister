// A saved lot: what the popup needs to redraw the list after the window was closed. One record per page (its URL
// without the hash), kept for 24 h in the area given (chrome.storage.session: memory only, gone when the browser
// closes). The total is capped; the oldest lot goes first. Local only: nothing here is ever sent anywhere.
// Every function degrades to "nothing saved" on a storage error or a damaged record; none of them throws.

export const LOT_TTL_MS = 24 * 60 * 60 * 1000;
export const LOT_CAP_BYTES = 5 * 1024 * 1024;
const STORE_KEY = "lotSessions";
const VERSION = 1;

/** The key for a page: its address without the #fragment. Null when there is no address. */
export function lotKey(url) {
  if (typeof url !== "string" || !url) return null;
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

const validLot = (lot) => Boolean(lot) && typeof lot === "object" && Number.isFinite(lot.savedAt)
  && Boolean(lot.state) && Array.isArray(lot.state.cards) && lot.state.cards.every((c) => c && typeof c === "object");

async function readLots(area) {
  try {
    const raw = (await area.get(STORE_KEY))?.[STORE_KEY];
    if (!raw || raw.v !== VERSION || !raw.lots || typeof raw.lots !== "object" || Array.isArray(raw.lots)) return {};
    return Object.fromEntries(Object.entries(raw.lots).filter(([, lot]) => validLot(lot)));
  } catch {
    return {};
  }
}

async function writeLots(area, lots) {
  try {
    await area.set({ [STORE_KEY]: { v: VERSION, lots } });
    return true;
  } catch {
    return false;
  }
}

const sizeOf = (lot) => JSON.stringify(lot).length;

/** Saves the lot for this page. False when it could not be kept (too big, or storage refused). */
export async function saveLot(area, url, state, now = Date.now()) {
  const key = lotKey(url);
  if (!key || !area) return false;
  const lot = { savedAt: now, state };
  let bytes;
  try { bytes = sizeOf(lot); } catch { return false; }
  if (bytes > LOT_CAP_BYTES) return false;
  const lots = await readLots(area);
  for (const [k, other] of Object.entries(lots)) if (now - other.savedAt > LOT_TTL_MS) delete lots[k];
  lots[key] = lot;
  let total = Object.values(lots).reduce((sum, l) => sum + sizeOf(l), 0);
  for (const [k] of Object.entries(lots).sort((a, b) => a[1].savedAt - b[1].savedAt)) {
    if (total <= LOT_CAP_BYTES) break;
    if (k === key) continue;
    total -= sizeOf(lots[k]);
    delete lots[k];
  }
  return writeLots(area, lots);
}

/** The saved lot for this page, or null when there is none, it is older than 24 h, or the record is damaged. */
export async function loadLot(area, url, now = Date.now()) {
  const key = lotKey(url);
  if (!key || !area) return null;
  const lots = await readLots(area);
  const lot = lots[key];
  if (!lot) return null;
  if (now - lot.savedAt > LOT_TTL_MS || lot.savedAt > now + 60000) {
    delete lots[key];
    await writeLots(area, lots);
    return null;
  }
  return { state: lot.state, savedAt: lot.savedAt };
}

/** Wipes the saved lot of this page. */
export async function clearLot(area, url) {
  const key = lotKey(url);
  if (!key || !area) return;
  const lots = await readLots(area);
  if (!(key in lots)) return;
  delete lots[key];
  await writeLots(area, lots);
}
