// Pages show a thumbnail of the listing photo and keep a larger rendition one rewrite or attribute away.
// Reading cards out of a 230px thumbnail leaves each card too small to identify, so the scan looks for
// the larger picture first. Everything here is pure: content.js gathers the raw hints, the background
// decides with them and loads the pixels.

import { publicHttpsUrl } from "./net.js";
import { sameImageUrl } from "./page-focus.js";

const TARGET_SIDE = 1600;            // the rendition requested from CDNs that resize on demand
const MAX_CANDIDATES = 4;            // each one costs a fetch, so only the likeliest few are tried
const MIN_GROWTH = 1.25;             // a candidate must be this much wider than what the page shows
const ASPECT_TOLERANCE = 0.03;       // a rewrite that changes the shape is a different picture
const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|gif|avif)$/i;

// Rough size each kind of hint is expected to have, only used to order the tries.
const ASSUMED = { rewrite: TARGET_SIDE, original: 1500, attribute: 1400, link: 1300, og: 1200 };

function parseSrcset(text, naturalWidth) {
  const out = [];
  for (const match of String(text || "").matchAll(/(\S+?)(?:\s+(\d+(?:\.\d+)?)([wx]))?\s*(?:,|$)/g)) {
    const raw = match[1].replace(/,+$/, "");
    if (!raw) continue;
    const amount = match[2] ? Number(match[2]) : 1;
    const size = match[3] === "w" ? amount : amount * (naturalWidth || 500);
    out.push({ raw, size });
  }
  return out;
}

function rewrites(url) {
  const out = [];
  const { pathname } = url;
  const ebay = pathname.match(/^(.*\/s-l)(\d+)(\.[a-z0-9]{2,5})$/i);
  if (ebay && /(?:^|\.)ebayimg\.com$/i.test(url.hostname) && Number(ebay[2]) < TARGET_SIDE) {
    const next = new URL(url.href);
    next.pathname = ebay[1] + TARGET_SIDE + ebay[3];
    out.push({ href: next.href, size: ASSUMED.rewrite });
  }
  const suffix = pathname.match(/^(.*[^/])[_-]\d{2,4}x\d{0,4}(\.[a-z0-9]{2,5})$/i);
  if (suffix) {
    const next = new URL(url.href);
    next.pathname = suffix[1] + suffix[2];
    out.push({ href: next.href, size: ASSUMED.original });
  }
  const next = new URL(url.href);
  let changed = false;
  for (const key of ["w", "width"]) {
    const width = Number(url.searchParams.get(key));
    if (!(width > 0 && width < TARGET_SIDE)) continue;
    next.searchParams.set(key, String(TARGET_SIDE));
    changed = true;
    const heightKey = key === "w" ? "h" : "height";
    const height = Number(url.searchParams.get(heightKey));
    if (height > 0) next.searchParams.set(heightKey, String(Math.round(height * TARGET_SIDE / width)));
  }
  if (changed) out.push({ href: next.href, size: ASSUMED.rewrite });
  return out;
}

function resolve(raw, base) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 2000 || /\s/.test(text)) return null;
  if (!/^(?:https?:)?\/|^[^:]+\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(text)) return null;
  return publicHttpsUrl(text, base);
}

/**
 * Larger renditions of a displayed image, largest first, best guess first among equals.
 * Never contains the displayed URL, a non-https URL, or a host the page did not itself name.
 *
 * @param {{src?: string, currentSrc?: string, naturalWidth?: number, srcset?: string, attrs?: string[],
 *          link?: string, ogImages?: string[], base?: string}} hints
 * @returns {string[]}
 */
export function fullSizeCandidates({ src = "", currentSrc = "", naturalWidth = 0, srcset = "", attrs = [], link = "", ogImages = [], base } = {}) {
  const shown = new Set([src, currentSrc].map((raw) => resolve(raw, base)?.href).filter(Boolean));
  const found = new Map();
  const add = (href, size) => {
    if (!href || shown.has(href) || (found.get(href) ?? -1) >= size) return;
    found.set(href, size);
  };
  const addUrl = (url, size) => { if (url) add(url.href, size); };

  for (const raw of [src, currentSrc]) {
    const url = resolve(raw, base);
    if (url) rewrites(url).forEach((entry) => add(entry.href, entry.size));
  }
  for (const entry of parseSrcset(srcset, naturalWidth)) {
    if (naturalWidth > 0 && entry.size < naturalWidth * MIN_GROWTH) continue;
    addUrl(resolve(entry.raw, base), entry.size);
  }
  for (const raw of Array.isArray(attrs) ? attrs : []) addUrl(resolve(raw, base), ASSUMED.attribute);
  const linked = resolve(link, base);
  if (linked && (IMAGE_EXTENSION.test(linked.pathname) || sameImageUrl(linked.href, src))) addUrl(linked, ASSUMED.link);
  for (const raw of Array.isArray(ogImages) ? ogImages : []) {
    const og = resolve(raw, base);
    if (og && sameImageUrl(og.href, src || currentSrc)) addUrl(og, ASSUMED.og);
  }

  return [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATES).map(([href]) => href);
}

/** Width/height ratios within tolerance of each other. */
export function sameAspect(a, b, tolerance = ASPECT_TOLERANCE) {
  if (!(a?.width > 0 && a?.height > 0 && b?.width > 0 && b?.height > 0)) return false;
  return Math.abs((b.width / b.height) / (a.width / a.height) - 1) <= tolerance;
}

/**
 * The first candidate whose pixels load, are clearly larger than the displayed image and have its shape.
 * `load(url)` resolves to an image bitmap or null; rejected candidates are closed.
 *
 * @returns {Promise<{url: string, bitmap: {width: number, height: number, close?: () => void}} | null>}
 */
export async function loadFullSize(candidates, natural, load) {
  if (!(natural?.width > 0 && natural?.height > 0)) return null;
  for (const url of candidates) {
    let bitmap = null;
    try {
      bitmap = await load(url);
    } catch {
      bitmap = null;
    }
    if (!bitmap) continue;
    if (bitmap.width >= natural.width * MIN_GROWTH && sameAspect(natural, bitmap)) return { url, bitmap };
    bitmap.close?.();
  }
  return null;
}
