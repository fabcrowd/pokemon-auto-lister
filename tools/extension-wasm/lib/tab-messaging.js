// content.js is not declared in the manifest. It is injected when a page needs it, so every
// message to a page has to survive the page not having the script yet.

const NO_RECEIVER = /could not establish connection|receiving end does not exist/i;

/** Send to the page; if nothing is listening, inject content.js and send once more. */
export async function sendToTab(api, tabId, message) {
  try {
    return await api.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (!NO_RECEIVER.test(String(err?.message || err))) throw err;
  }
  await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return api.tabs.sendMessage(tabId, message);
}
