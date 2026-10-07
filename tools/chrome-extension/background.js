// MV3 service worker — relays overlay events from popup to the active tab's content script.
chrome.runtime.onInstalled.addListener(() => {
  console.log('Pokemon Card Scanner installed');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'relayOverlay' && msg.action !== 'relayClear') return;

  (async () => {
    const tabs  = await chrome.tabs.query({ active: true });
    const target = tabs.find(
      (t) => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://')
    );
    if (!target?.id) return;

    const tabMsg = msg.action === 'relayOverlay'
      ? { action: 'showOverlay', cards: msg.cards, srcWidth: msg.srcWidth, srcHeight: msg.srcHeight }
      : { action: 'clearOverlay' };

    chrome.tabs.sendMessage(target.id, tabMsg).catch(() => {});
  })();
});
