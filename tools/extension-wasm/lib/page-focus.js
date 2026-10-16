// Which pictures on a page should be scanned. A listing page has one photo the seller
// is selling; everything else (thumbnails, "similar items", sponsored carousels) is
// somebody else's card and only produces confident wrong answers. A grid page (search
// results, set lists) has no such photo, and every card on it is wanted.
//
// All functions are pure. content.js gathers the raw signals (`ctx`), the background
// decides with them here.

const MAIN_MIN_FRACTION = 0.04;      // visible area / viewport area for a photo with no other signal
const OG_MIN_FRACTION = 0.02;        // a photo that is the page's og:image may be smaller
const DOMINANCE = 2;                 // the main photo is this many times larger than any rival
const GRID_MIN_ITEMS = 3;
const GRID_SIZE_SPREAD = 2.5;
const GRID_MIN_FRACTION = 0.005;
const MAIN_RATIO_MIN = 0.4;          // visible w/h of a listing photo; a banner is far wider
const MAIN_RATIO_MAX = 1.7;
const SIDE_LANDMARKS = new Set(["nav", "aside", "footer", "complementary", "navigation", "contentinfo"]);

const RELATED_HEADING = /\b(?:similar|related|recommended|recommendations?|also (?:viewed|bought|like|liked)|you (?:may|might) (?:also )?(?:like|want|need)|more (?:from|like)|sponsored|recently viewed|customers (?:also|who)|people (?:also|who)|inspired by|frequently bought|other (?:items|listings|sellers))\b/i;

const SEALED_TITLE = /\b(?:booster[\s-]*(?:box(?:es)?|bundles?|packs?|displays?)|display[\s-]*box(?:es)?|elite[\s-]*trainer[\s-]*box(?:es)?|etb|build\s*(?:&|and)\s*battle|sealed[\s-]*(?:box|case|pack|tin|deck|product)|(?:ultra[\s-]*)?premium[\s-]*collection|(?:collection|mini|pokeball|poke ball)[\s-]*tin|starter[\s-]*deck|theme[\s-]*deck|case of \d+ (?:booster|boxes|displays))\b/i;
// A card number, a grading company or a lot means cards are the thing for sale even if a pack is mentioned.
const NOT_SEALED = /\b\d{1,3}\s*\/\s*\d{2,3}\b|\b(?:psa|bgs|cgc|sgc|graded|slab|gem\s*mint)\b|\b(?:lot|bulk|singles?|promos?|pulled|pull|pulls)\b/i;

export function isRelatedHeading(text) {
  return typeof text === "string" && RELATED_HEADING.test(text);
}

function relatedContext(ctx) {
  if (!ctx) return false;
  if ((ctx.landmarks || []).some((name) => SIDE_LANDMARKS.has(String(name).toLowerCase()))) return true;
  return [...(ctx.headings || []), ...(ctx.labels || [])].some(isRelatedHeading);
}

const SIZE_PARAMS = new Set(["w", "h", "width", "height", "size", "q", "quality", "fit", "format", "fmt", "dpr", "resize", "crop", "auto", "wid", "hei"]);
const SIZE_NAMES = new Set(["thumb", "thumbs", "thumbnail", "small", "medium", "large", "original", "full", "preview"]);

// Only markers that mean "this picture, resized": s-l500, _300x300, w_300, a 300x400 folder, ?w=300.
// Counters (img_1, IMG_1234) and ids (?id=7) are different pictures and stay in the key.
function normalizedImage(url) {
  if (typeof url !== "string" || !url) return null;
  let parsed;
  try {
    parsed = new URL(url, "https://page.invalid/");
  } catch {
    return null;
  }
  const segments = parsed.pathname.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").split("/").filter(Boolean)
    .map((part) => part
      .replace(/(^|[,_-])(?:w|h|width|height)[_-]?\d+(?=$|[,_-])/g, "$1")
      .replace(/^s-l\d+$/, "s-l")
      .replace(/[_-]\d{2,4}x\d{2,4}$/, "")
      .replace(/^[,_-]+|[,_-]+$/g, ""))
    .filter((part) => part && !/^\d{2,4}x\d{2,4}$/.test(part) && !SIZE_NAMES.has(part));
  const query = [...parsed.searchParams.entries()]
    .filter(([key]) => !SIZE_PARAMS.has(key.toLowerCase()))
    .map(([key, value]) => key + "=" + value).sort().join("&");
  return parsed.host + "/" + segments.join("/") + (query ? "?" + query : "");
}

/** The same picture served at another size or format. */
export function sameImageUrl(a, b) {
  const first = normalizedImage(a);
  return first !== null && first === normalizedImage(b);
}

/** Same spelling the scan uses to pair a photo entry with its card entry. */
export function imageKey(entry) {
  const r = entry?.rect || {};
  return `${Math.round(r.x || 0)},${Math.round(r.y || 0)},${Math.round(r.w || 0)}x${Math.round(r.h || 0)}`;
}

const area = (entry) => Math.max(0, entry?.rect?.w || 0) * Math.max(0, entry?.rect?.h || 0);
const COMPARABLE_FRACTION = 0.25;    // a rival this large (vs the main photo) counts toward a grid

function seenArea(entry) {
  const r = entry?.rect || {};
  return Math.max(0, r.vw || 0) * Math.max(0, r.vh || 0);
}

// A gallery slide scrolled out of an overflow:hidden strip has a layout box but nothing on screen.
function isHidden(entry) {
  const r = entry?.rect || {};
  const onScreen = Math.max(0, r.pvw ?? r.vw ?? 0) * Math.max(0, r.pvh ?? r.vh ?? 0);
  return onScreen > 0 && seenArea(entry) < onScreen * 0.25;
}

function overlapsMostly(a, b) {
  const w = Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - Math.max(a.rect.x, b.rect.x);
  const h = Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - Math.max(a.rect.y, b.rect.y);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / Math.min(area(a), area(b)) > 0.5;
}

function passThrough(kind, photos, cards, reason) {
  return { kind, main: null, photos, cards, reason };
}

/**
 * Classify the page and choose what to scan.
 *   listing: one dominant photo outside any "similar items" zone, with no group of comparable
 *            images beside it. Only it is scanned.
 *   grid:    many comparable cards and no dominant photo. Everything is scanned.
 *   unknown: neither. Everything is scanned, as before.
 * Sizes are layout sizes, so a hero that runs below the fold still counts. An og:image match only
 * lowers the size a main photo needs; it never lets one of several comparable images win.
 *
 * @param {{viewport: {w: number, h: number}, photos: object[], cards: object[], ogImages?: string[]}} page
 */
export function choosePageFocus({ viewport, photos = [], cards = [], ogImages = [] }) {
  const all = [];
  const seen = new Set();
  for (const entry of [...photos, ...cards]) {
    const key = imageKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(entry);
  }
  if (!all.length) return passThrough("unknown", photos, cards, "no-candidates");

  const viewportArea = Math.max(1, (viewport?.w || 0) * (viewport?.h || 0));
  const own = all.filter((entry) => !relatedContext(entry.ctx));
  const shown = own.filter((entry) => !isHidden(entry));
  const plausible = (entry) => {
    const ratio = entry.rect.h > 0 ? entry.rect.w / entry.rect.h : 0;
    return ratio >= MAIN_RATIO_MIN && ratio <= MAIN_RATIO_MAX;
  };
  const fraction = (entry) => area(entry) / viewportArea;
  const bySize = [...shown].sort((a, b) => area(b) - area(a));
  const isOg = (entry) => entry.ctx?.ogMatch === true || ogImages.some((url) => sameImageUrl(url, entry.src));

  const candidate = bySize.find((entry) => isOg(entry) && plausible(entry) && fraction(entry) >= OG_MIN_FRACTION)
    || bySize.find((entry) => plausible(entry) && fraction(entry) >= MAIN_MIN_FRACTION);
  let main = null;
  let reason = null;
  if (candidate) {
    const rivals = shown.filter((entry) => entry !== candidate && !overlapsMostly(entry, candidate));
    const dominant = rivals.every((entry) => area(candidate) >= DOMINANCE * area(entry));
    const crowd = rivals.filter((entry) => area(entry) >= COMPARABLE_FRACTION * area(candidate)).length >= GRID_MIN_ITEMS;
    if (dominant && !crowd) {
      main = candidate;
      reason = isOg(candidate) ? "og-image" : "dominant";
    }
  }

  if (main) {
    const mainKey = imageKey(main);
    return {
      kind: "listing",
      main,
      photos: photos.filter((entry) => imageKey(entry) === mainKey),
      // Other gallery photos, tried only when the main one holds no card (a lot photo the detector missed).
      fallback: photos.filter((entry) => imageKey(entry) !== mainKey && !relatedContext(entry.ctx) && fraction(entry) >= MAIN_MIN_FRACTION),
      cards: cards.filter((entry) => imageKey(entry) === mainKey),
      reason,
    };
  }

  const sizes = shown.map((entry) => seenArea(entry)).filter((a) => a / viewportArea >= GRID_MIN_FRACTION).sort((a, b) => b - a);
  const alike = sizes.filter((a) => a * GRID_SIZE_SPREAD >= sizes[0]);
  const grid = alike.length >= GRID_MIN_ITEMS;
  return passThrough(grid ? "grid" : "unknown", photos, cards, grid ? "similar-sizes" : "no-main-photo");
}

/**
 * True when the page is selling a sealed product (booster box, ETB, tin), judged from
 * titles (page title, og:title, h1) and the photo's own alt/aria text. `sealedLabel` is the
 * content script's own verdict on that alt/aria text.
 */
export function isSealedListing({ titles = [], labels = [], sealedLabel = false } = {}) {
  const text = [...titles, ...labels].filter((part) => typeof part === "string" && part).join(" ");
  return (sealedLabel === true || SEALED_TITLE.test(text)) && !NOT_SEALED.test(text);
}

/** Sealed is a soft verdict: cards the detector really found in the photo are kept. */
export function shouldSuppressCards({ sealed, detectedCards }) {
  return sealed === true && !(detectedCards > 0);
}
