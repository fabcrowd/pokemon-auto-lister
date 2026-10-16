import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sendToTab } from '../tools/extension-wasm/lib/tab-messaging.js';

const NO_RECEIVER = new Error('Could not establish connection. Receiving end does not exist.');

function fakeChrome({ sends, injectError = null }) {
  const calls = { sent: [], injected: [] };
  return {
    calls,
    tabs: {
      sendMessage: async (tabId, message) => {
        calls.sent.push([tabId, message]);
        const next = sends.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    scripting: {
      executeScript: async (details) => {
        calls.injected.push(details);
        if (injectError) throw injectError;
      },
    },
  };
}

test('a page that already has the script is not injected', async () => {
  const api = fakeChrome({ sends: [{ ok: 1 }] });
  assert.deepEqual(await sendToTab(api, 7, { action: 'findCards' }), { ok: 1 });
  assert.deepEqual(api.calls.injected, []);
});

test('no receiver: inject content.js once, then send again', async () => {
  const api = fakeChrome({ sends: [NO_RECEIVER, { cards: [] }] });
  assert.deepEqual(await sendToTab(api, 7, { action: 'findCards' }), { cards: [] });
  assert.deepEqual(api.calls.injected, [{ target: { tabId: 7 }, files: ['content.js'] }]);
  assert.equal(api.calls.sent.length, 2);
});

test('it retries only once', async () => {
  const api = fakeChrome({ sends: [NO_RECEIVER, new Error('Receiving end does not exist.')] });
  await assert.rejects(sendToTab(api, 7, { action: 'x' }), /Receiving end/);
  assert.equal(api.calls.injected.length, 1);
  assert.equal(api.calls.sent.length, 2);
});

test('other errors are not retried or injected', async () => {
  const api = fakeChrome({ sends: [new Error('No tab with id: 7.')] });
  await assert.rejects(sendToTab(api, 7, { action: 'x' }), /No tab/);
  assert.deepEqual(api.calls.injected, []);
});

test('a page the extension may not touch rejects with the injection error', async () => {
  const api = fakeChrome({ sends: [NO_RECEIVER], injectError: new Error('Cannot access contents of the page.') });
  await assert.rejects(sendToTab(api, 7, { action: 'x' }), /Cannot access/);
  assert.equal(api.calls.sent.length, 1);
});
