// Which tab a scan reads, and which callers may ask for one.

const BROWSER_PAGE = /^(chrome-extension|chrome|about|edge|devtools|chrome-search|view-source):/;

/**
 * The tab to scan when none was chosen: the most recently used active tab of a normal window that is not
 * the scanner window. A tab whose address the extension may not read is never guessed at, since it could be
 * a browser page; the caller then tells the user to click the icon on the page.
 * @param tabs active tabs of normal windows (tabs.query({ active: true, windowType: "normal" }))
 * @returns {{ tab: object } | { tab: null, reason: "none" | "unreadable" }}
 */
export function chooseFallbackTab(tabs, scannerWindowId) {
  const open = tabs
    .filter((tab) => tab.active && tab.windowId !== scannerWindowId)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const readable = open.find((tab) => tab.url && !BROWSER_PAGE.test(tab.url));
  if (readable) return { tab: readable };
  return { tab: null, reason: open.some((tab) => !tab.url) ? "unreadable" : "none" };
}

/** True for a message sent by one of this extension's own pages (the popup is in a tab; a page's content script is not). */
export function isOwnPage(sender, extensionId, extensionBaseUrl) {
  return sender?.id === extensionId && typeof sender.url === "string" && sender.url.startsWith(extensionBaseUrl);
}
