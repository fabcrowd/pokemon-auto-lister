// The other photos of a listing. A seller often shows the whole lot in one picture and the cards up close in
// the rest of the gallery (a carousel with a thumbnail strip on Facebook Marketplace, eBay, Mercari). The close
// ups are where the cards can be read, so a listing scan looks at them too, then keeps each card once.
//
// All functions are pure: content.js gathers the thumbnails, background.js fetches and reads them.

import { findRelatedEntries, isRelatedHeading, sameImageUrl } from "./page-focus.js";

// Photos of one listing beyond its main one; each costs a fetch and a detector run.
export const MAX_GALLERY_PHOTOS = 8;
// Time for all of them, fetches and reads together. What is left when it runs out is skipped.
export const GALLERY_BUDGET_MS = 45000;
// A gallery thumbnail sits this close to the main photo in the page: their nearest shared element is at most
// this many levels above the main photo (a Marketplace viewer nests its strip 4-6 levels up).
export const GALLERY_ANCESTOR_DEPTH = 10;
// A fetched photo with a longer side under this cannot show a card large enough to read.
export const MIN_GALLERY_SIDE = 300;

const SIDE_LANDMARKS = new Set(["nav", "aside", "footer", "complementary", "navigation", "contentinfo"]);

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// A tile that links to another page is another listing; a gallery thumbnail is a button or links to the photo.
function linksElsewhere(entry, pageUrl) {
  const link = entry?.sources?.link;
  if (!link || sameImageUrl(link, entry.src)) return false;
  try {
    const target = new URL(link);
    const here = new URL(pageUrl);
    return target.origin + target.pathname !== here.origin + here.pathname;
  } catch {
    return true;
  }
}

function besideTheListing(ctx) {
  if (!ctx) return false;
  if ((ctx.landmarks || []).some((name) => SIDE_LANDMARKS.has(String(name).toLowerCase()))) return true;
  return [...(ctx.headings || []), ...(ctx.labels || [])].some(isRelatedHeading);
}

/**
 * The listing's other photos, in page order: large slides of the same viewer and the thumbnails of its strip.
 * A picture counts when it shares an element with the main photo close above it, comes from the same image host,
 * is not in a "similar items" section, does not link to another page (a related listing's tile), and is not the
 * main photo again at another size.
 *
 * @param {{main: object, candidates: object[], headings?: object[], pageUrl?: string, max?: number}} input
 *   candidates: photo and thumbnail entries from content.js ({src, rect, ctx: {chain, ...}}).
 */
export function galleryPhotos({ main, candidates = [], headings = [], pageUrl = "", max = MAX_GALLERY_PHOTOS }) {
  if (!main?.src || !Array.isArray(main.ctx?.chain)) return [];
  const near = new Set(main.ctx.chain.slice(1, GALLERY_ANCESTOR_DEPTH + 1));
  const host = hostOf(main.src);
  const related = findRelatedEntries({ entries: candidates, headings, candidate: null });
  const picked = [];
  for (const entry of candidates) {
    if (picked.length >= max) break;
    if (!entry?.src || entry === main || related.has(entry) || besideTheListing(entry.ctx)) continue;
    if (!Array.isArray(entry.ctx?.chain) || !entry.ctx.chain.some((id) => near.has(id))) continue;
    if (hostOf(entry.src) !== host || linksElsewhere(entry, pageUrl)) continue;
    if (sameImageUrl(entry.src, main.src) || picked.some((other) => sameImageUrl(other.src, entry.src))) continue;
    picked.push(entry);
  }
  return picked;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

// Two crops that are each other's closest card in the other photo show the same card from this close. On the two
// Marketplace fixtures the same card across a lot photo and a close-up scored 0.86-0.95; a plain threshold without the
// mutual pick also joined look-alikes (Altaria with Altaria EX at 0.93), so there is none.
export const MUTUAL_SIMILARITY = 0.8;

// Between two guesses, a crop this many times taller is the better read (on the Facebook photos guesses from
// 200-299 px crops were right 89% of the time, from crops under 120 px 16%).
const MUCH_TALLER = 1.5;

/**
 * The better read of one card: a name before none, sure before asked; between two guesses the much taller crop, else
 * the earlier photo (the one the seller put first); then confidence.
 */
function better(a, b) {
  const ca = a.card || {};
  const cb = b.card || {};
  if (Boolean(ca.abstain) !== Boolean(cb.abstain)) return !ca.abstain;
  if (Boolean(ca.unsure) !== Boolean(cb.unsure)) return !ca.unsure;
  const ha = Number(a.height) || 0;
  const hb = Number(b.height) || 0;
  if (ha >= hb * MUCH_TALLER || hb >= ha * MUCH_TALLER) return ha > hb;
  if (ca.unsure && a.photo !== b.photo) return a.photo < b.photo;
  return (Number(ca.confidence) || 0) > (Number(cb.confidence) || 0);
}

/**
 * The same card seen in more than one photo of a listing, kept once. Pairs from different photos are joined,
 * closest first, when each is the other's closest card in the other photo and they are close, or when both are sure
 * reads of the same printing; a group never holds
 * two cards from one photo (a lot may have two copies of a card side by side). Each group keeps its best read. A guess
 * seen in one gallery photo only (not the main one) is dropped.
 *
 * @param {{photo: number, height: number, embedding?: ArrayLike<number>, card: object}[]} items
 * @returns {{drop: Set<number>, photos: Map<number, number[]>, similar: string[]}} indexes to drop; for each kept
 *   index of a group of two or more, the photos it was seen in; the closest cross-photo pairs, for the log.
 */
export function mergeAcrossPhotos(items, { mutualSimilarity = MUTUAL_SIMILARITY, dropLoneGuesses = true } = {}) {
  const pairs = [];
  const closest = [];
  // For each card, its closest card in every other photo: two cards that pick each other are one card seen twice.
  const nearest = items.map(() => new Map());
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!a || !b || a.photo === b.photo || a.card?.cardBack || b.card?.cardBack) continue;
      const sim = cosine(a.embedding, b.embedding);
      closest.push({ sim, i, j });
      for (const [k, other, otherPhoto] of [[i, j, b.photo], [j, i, a.photo]]) {
        const best = nearest[k].get(otherPhoto);
        if (!best || sim > best.sim) nearest[k].set(otherPhoto, { index: other, sim });
      }
    }
  }
  for (const { sim, i, j } of closest) {
    const a = items[i];
    const b = items[j];
    const mutual = nearest[i].get(b.photo)?.index === j && nearest[j].get(a.photo)?.index === i;
    const sureSame = !a.card?.abstain && !b.card?.abstain && !a.card?.unsure && !b.card?.unsure
      && a.card?.identity?.id && a.card.identity.id === b.card?.identity?.id;
    if ((mutual && sim >= mutualSimilarity) || sureSame) pairs.push({ i, j, sim: sureSame ? Math.max(sim, 1) : sim });
  }
  pairs.sort((p, q) => q.sim - p.sim);
  const group = items.map((_, i) => [i]);
  const groupOf = items.map((_, i) => i);
  for (const { i, j } of pairs) {
    const gi = groupOf[i];
    const gj = groupOf[j];
    if (gi === gj) continue;
    const photosI = new Set(group[gi].map((k) => items[k].photo));
    if (group[gj].some((k) => photosI.has(items[k].photo))) continue;
    for (const k of group[gj]) groupOf[k] = gi;
    group[gi].push(...group[gj]);
    group[gj] = [];
  }
  const drop = new Set();
  const photos = new Map();
  for (const members of group) {
    // A card only one gallery photo shows, and only as a guess, is most often a lot card the photos did not match up,
    // or a misread: the main photo already lists every card it could see.
    if (members.length === 1) {
      const only = items[members[0]];
      if (dropLoneGuesses && only.photo > 1 && (only.card?.abstain || only.card?.unsure)) drop.add(members[0]);
      continue;
    }
    let best = members[0];
    for (const k of members) if (better(items[k], items[best])) best = k;
    for (const k of members) if (k !== best) drop.add(k);
    photos.set(best, [...new Set(members.map((k) => items[k].photo))].sort((a, b) => a - b));
  }
  const label = (k) => items[k].card?.identity?.name || "?";
  const similar = closest.sort((p, q) => q.sim - p.sim).slice(0, 12)
    .map(({ sim, i, j }) => `${sim.toFixed(2)}:${label(i)}|${label(j)}`);
  return { drop, photos, similar };
}
