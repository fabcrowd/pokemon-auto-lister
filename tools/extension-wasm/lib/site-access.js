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
