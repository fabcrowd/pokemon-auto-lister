// Reading a page's full-size photo needs access to the site that serves it. That access is
// optional: without it the scan uses a screenshot of the visible tab.

export const ALL_SITES = { origins: ["<all_urls>"] };

/** The match pattern for the site a URL is on, or null for anything but http(s). */
export function originPattern(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${url.protocol}//${url.hostname}/*`;
}

export async function hasSiteAccess(permissions, rawUrl) {
  const pattern = originPattern(rawUrl);
  if (!pattern) return false;
  try {
    return await permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function hasAllSites(permissions) {
  try {
    return await permissions.contains(ALL_SITES);
  } catch {
    return false;
  }
}

// Must be called straight from a click: the browser refuses a request made later.
export async function requestAllSites(permissions) {
  try {
    return await permissions.request(ALL_SITES);
  } catch {
    return false;
  }
}

export async function releaseAllSites(permissions) {
  try {
    return await permissions.remove(ALL_SITES);
  } catch {
    return false;
  }
}

/** Calls onChange(boolean) whenever the grant is added or removed, from any page or the browser's own settings. */
export function watchAllSites(permissions, onChange) {
  const refresh = async () => onChange(await hasAllSites(permissions));
  permissions.onAdded.addListener(refresh);
  permissions.onRemoved.addListener(refresh);
}

export const SITE_ACCESS_DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

/** Whether the popup should offer to turn on site access after this scan. */
export function shouldOfferSiteAccess({ scan, hasAll, dismissedAt, now }) {
  if (hasAll) return false;
  if (!scan || scan.usedScreenshotPath !== true || scan.reason !== "no-site-access") return false;
  if (typeof dismissedAt === "number" && now - dismissedAt < SITE_ACCESS_DISMISS_MS) return false;
  return true;
}

// One site's grant: the page and the hosts its photos come from (Marketplace photos are on fbcdn.net, not on
// facebook.com). All of these sit inside the optional <all_urls>, so asking for them needs no manifest change.
export const MAX_SITE_ORIGINS = 6;

/** Match patterns for the page and the photo hosts a scan could not read, page first, without repeats. */
export function siteOrigins(pageUrl, photoUrls = []) {
  const out = [];
  for (const url of [pageUrl, ...photoUrls]) {
    const pattern = originPattern(url);
    if (pattern && !out.includes(pattern)) out.push(pattern);
    if (out.length >= MAX_SITE_ORIGINS) break;
  }
  return out;
}

/** "facebook.com" for https://www.facebook.com/marketplace/item/1; empty for anything but http(s). */
export function siteLabel(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.hostname.replace(/^(?:www|m|web)\./, "");
  } catch {
    return "";
  }
}

// Must be called straight from a click, like requestAllSites.
export async function requestSites(permissions, origins) {
  if (!Array.isArray(origins) || !origins.length) return false;
  try {
    return await permissions.request({ origins });
  } catch {
    return false;
  }
}

/** Why the popup asks: what the scan could not read on this site, and what reading it gives. */
export function accessOfferText({ site, galleryUnread = 0 }) {
  const where = site ? ` on ${site}` : " on sites you scan";
  const gallery = galleryUnread > 0
    ? ` and the other ${galleryUnread} photo${galleryUnread === 1 ? "" : "s"} of this listing`
    : "";
  return `Card Scanner read a screenshot here. Allow it to read the original photos${where}${gallery}: small cards come out sharper, so more of them are named right.`;
}

/** Whether this site's offer was put off: by "Not now" on this site, or on any site before per-site answers. */
export function dismissedFor({ site, dismissedSites, dismissedAt, now }) {
  const at = site && dismissedSites && typeof dismissedSites[site] === "number" ? dismissedSites[site] : dismissedAt;
  return typeof at === "number" && now - at < SITE_ACCESS_DISMISS_MS;
}
