// The largest rendition each listing site serves for a photo it shows small, by URL pattern. The rules were measured
// against the sites' own CDNs (card-scanner-data/data/reports/rendition/README.md); only an exact pattern match
// rewrites, the host never changes, and a URL that is already the largest (or unknown) gives null. Pure: the caller
// still runs the result through the public-https, allowed-host, size and time checks before fetching it.

import { publicHttpsUrl } from "./net.js";

const CRAIGSLIST_FULL = "1200x900";
const CRAIGSLIST_SMALLER = new Set(["50x50c", "300x300", "600x450"]);

const hostIs = (url, name) => url.hostname.toLowerCase() === name;
const hostEndsWith = (url, domain) => {
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith("." + domain);
};

// Mercari: the bare /photos/<id>.jpg is the upload; /thumb/ and ?width=&quality= are resizes of it.
function mercari(url) {
  if (!hostEndsWith(url, "mercdn.net")) return null;
  const match = url.pathname.match(/^(?:\/thumb)?(\/photos\/[^/]+\.jpe?g)$/i);
  if (!match || (url.pathname === match[1] && !url.search)) return null;
  const next = new URL(url.href);
  next.pathname = match[1];
  next.search = "";
  return next.href;
}

// HiBid: w=0&h=0 with sz=MAX is the original. Gallery URLs carry w=720&h=720 and no sz, list thumbs repeat h and w
// at the end. The query is edited as raw text so the signed checksum keeps its encoding.
function hibid(url) {
  if (!hostEndsWith(url, "hibid.com") || !/\/img\.axd$/i.test(url.pathname)) return null;
  const parts = url.search.replace(/^\?/, "").split("&");
  const value = (key) => parts.find((part) => part.startsWith(key + "="))?.slice(key.length + 1);
  if (!value("id") || !value("checksum")) return null;
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const key = part.split("=")[0];
    if (key === "w" || key === "h") {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key + "=0");
    } else if (key === "sz") {
      continue;
    } else if (key === "checksum") {
      out.push("sz=MAX", part);
    } else {
      out.push(part);
    }
  }
  const search = "?" + out.join("&");
  if (search === url.search) return null;
  const next = new URL(url.href);
  next.search = search;
  return next.href;
}

// ShopGoodwill: <name>_<MMDD>t<k>.jpeg is the thumbnail of <name>_<MMDD><k>.jpg.
function shopgoodwill(url) {
  if (!hostEndsWith(url, "shopgoodwillimages.azureedge.net")) return null;
  const match = url.pathname.match(/^(.*_\d{4})t(\d+)\.jpeg$/i);
  if (!match) return null;
  const next = new URL(url.href);
  next.pathname = `${match[1]}${match[2]}.jpg`;
  return next.href;
}

// Craigslist: the same id served at 1200x900 (the page markup only names 600x450 and 50x50c).
function craigslist(url) {
  if (!hostIs(url, "images.craigslist.org")) return null;
  const match = url.pathname.match(/^(\/[^/]+_)(\d+x\d+c?)\.jpg$/i);
  if (!match || !CRAIGSLIST_SMALLER.has(match[2])) return null;
  const next = new URL(url.href);
  next.pathname = `${match[1]}${CRAIGSLIST_FULL}.jpg`;
  return next.href;
}

// Poshmark: s_ and m_ swap to l_ (1000 px). A _wp_ webp twin stays a webp twin: the plain jpg twins sometimes 404.
function poshmark(url) {
  if (!hostIs(url, "di2ponv0v5otw.cloudfront.net")) return null;
  const match = url.pathname.match(/^(\/posts\/\d{4}\/\d{1,2}\/\d{1,2}\/[^/]+\/)[sm]_((?:wp_)?[^/]+\.(?:jpe?g|webp))$/i);
  if (!match) return null;
  const next = new URL(url.href);
  next.pathname = `${match[1]}l_${match[2]}`;
  return next.href;
}

const RULES = [mercari, hibid, shopgoodwill, craigslist, poshmark];

const MEASURED_HOSTS = [
  [/(?:^|.)mercdn.net$/i],
  [/(?:^|.)hibid.com$/i],
  [/^shopgoodwillimages.azureedge.net$/i],
  [/^images.craigslist.org$/i],
  [/^di2ponv0v5otw.cloudfront.net$/i],
];

/** Whether a host is one of the sites whose renditions were measured; the generic size guesses leave these to the rules. */
export function isMeasuredRenditionHost(host) {
  return MEASURED_HOSTS.some(([pattern]) => pattern.test(String(host || "")));
}

/**
 * The largest rendition the site serves for a photo URL, or null when the URL is not a known small rendition.
 * @param {string} raw
 * @returns {string|null}
 */
export function upgradeRenditionUrl(raw) {
  if (typeof raw !== "string") return null;
  const url = publicHttpsUrl(raw);
  if (!url) return null;
  for (const rule of RULES) {
    const href = rule(url);
    if (!href) continue;
    const next = publicHttpsUrl(href);
    return next && next.hostname === url.hostname && next.href !== url.href ? next.href : null;
  }
  return null;
}

/**
 * A grid tile's picture: the site's largest rendition when the caller may read it and it fits (is shaped like the
 * tile's subject), otherwise the shown URL. A failed, rejected or ill-shaped upgraded read is silent; only the final
 * read decides whether the caller counts a failure.
 *
 * @param {string} rawUrl
 * @param {{load: (url: string, limits: object) => Promise<any>, readable: (url: string) => Promise<boolean>,
 *          limits?: object, fits: (bitmap: any) => boolean}} deps
 */
export async function loadTileSource(rawUrl, { load, readable, limits = {}, fits }) {
  const upgraded = upgradeRenditionUrl(rawUrl);
  if (upgraded && await readable(upgraded)) {
    let bitmap = null;
    try {
      bitmap = await load(upgraded, limits);
    } catch {
      bitmap = null;
    }
    if (bitmap && fits(bitmap)) return bitmap;
    bitmap?.close?.();
  }
  return load(rawUrl, limits);
}
