import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_SITES, hasAllSites, hasSiteAccess, originPattern, releaseAllSites, requestAllSites, shouldOfferSiteAccess, watchAllSites,
} from '../tools/extension-wasm/lib/site-access.js';

function fakePermissions({ granted = [], requestResult = true } = {}) {
  const listeners = { added: [], removed: [] };
  const api = {
    asked: [],
    contains: async ({ origins }) => origins.every((o) => granted.includes('<all_urls>') || granted.includes(o)),
    request: async (req) => { api.asked.push(req); if (requestResult) granted.push(...req.origins); return requestResult; },
    remove: async (req) => { for (const o of req.origins) granted.splice(granted.indexOf(o), 1); return true; },
    onAdded: { addListener: (fn) => listeners.added.push(fn) },
    onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    fire: (kind) => listeners[kind].forEach((fn) => fn({ origins: ['<all_urls>'] })),
  };
  return api;
}

test('originPattern gives scheme and host with any path, no port', () => {
  assert.equal(originPattern('https://i.ebayimg.com/images/g/abc/s-l1600.jpg?x=1'), 'https://i.ebayimg.com/*');
  assert.equal(originPattern('http://127.0.0.1:3100/img/0.jpg'), 'http://127.0.0.1/*');
  assert.equal(originPattern('data:image/png;base64,AAAA'), null);
  assert.equal(originPattern('not a url'), null);
  assert.equal(originPattern(''), null);
});

test('without access to the image origin the answer is no', async () => {
  const permissions = fakePermissions({ granted: ['https://api.pokemontcg.io/*'] });
  assert.equal(await hasSiteAccess(permissions, 'https://i.ebayimg.com/a.jpg'), false);
});

test('all-sites access covers every image origin', async () => {
  const permissions = fakePermissions({ granted: ['<all_urls>'] });
  assert.equal(await hasSiteAccess(permissions, 'https://i.ebayimg.com/a.jpg'), true);
});

test('a url that is not http(s) never has access, and a throwing API means no', async () => {
  assert.equal(await hasSiteAccess(fakePermissions({ granted: ['<all_urls>'] }), 'blob:https://x/1'), false);
  const broken = { contains: async () => { throw new Error('boom'); } };
  assert.equal(await hasSiteAccess(broken, 'https://a.example/x.jpg'), false);
  assert.equal(await hasAllSites(broken), false);
});

test('requesting asks for all sites and reports the answer; a throw is a no', async () => {
  const permissions = fakePermissions({ requestResult: false });
  assert.equal(await requestAllSites(permissions), false);
  assert.deepEqual(permissions.asked, [ALL_SITES]);
  assert.equal(await requestAllSites({ request: async () => { throw new Error('no gesture'); } }), false);
});

test('release removes the grant and reports whether it is gone', async () => {
  const permissions = fakePermissions({ granted: ['<all_urls>'] });
  assert.equal(await releaseAllSites(permissions), true);
  assert.equal(await hasAllSites(permissions), false);
  assert.equal(await releaseAllSites({ remove: async () => { throw new Error('required'); }, contains: async () => true }), false);
});

test('watch reports the current state after a grant or a removal', async () => {
  const granted = [];
  const permissions = fakePermissions({ granted });
  const seen = [];
  watchAllSites(permissions, (value) => seen.push(value));
  granted.push('<all_urls>');
  permissions.fire('added');
  await new Promise((resolve) => setTimeout(resolve, 0));
  granted.length = 0;
  permissions.fire('removed');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [true, false]);
});

const DAY = 24 * 60 * 60 * 1000;
const NO_ACCESS_SCAN = { usedScreenshotPath: true, reason: 'no-site-access' };

test('the popup offers site access after a screenshot scan that lacked it', () => {
  assert.equal(shouldOfferSiteAccess({ scan: NO_ACCESS_SCAN, hasAll: false, dismissedAt: null, now: 1000 }), true);
});

test('it is not offered when access is granted, the scan did not need it, or there is no scan', () => {
  assert.equal(shouldOfferSiteAccess({ scan: NO_ACCESS_SCAN, hasAll: true, dismissedAt: null, now: 1000 }), false);
  assert.equal(shouldOfferSiteAccess({ scan: { usedScreenshotPath: true, reason: 'other' }, hasAll: false, dismissedAt: null, now: 1000 }), false);
  assert.equal(shouldOfferSiteAccess({ scan: {}, hasAll: false, dismissedAt: null, now: 1000 }), false);
  assert.equal(shouldOfferSiteAccess({ scan: null, hasAll: false, dismissedAt: null, now: 1000 }), false);
});

test('a dismissal hides the offer for 14 days, then it returns', () => {
  const t0 = 5 * DAY;
  assert.equal(shouldOfferSiteAccess({ scan: NO_ACCESS_SCAN, hasAll: false, dismissedAt: t0, now: t0 + 13 * DAY }), false);
  assert.equal(shouldOfferSiteAccess({ scan: NO_ACCESS_SCAN, hasAll: false, dismissedAt: t0, now: t0 + 14 * DAY }), true);
  assert.equal(shouldOfferSiteAccess({ scan: NO_ACCESS_SCAN, hasAll: false, dismissedAt: 'junk', now: t0 }), true);
});

test('a refused permission request counts as a dismissal for the next scan', () => {
  const refusedAt = 9 * DAY;
  assert.equal(shouldOfferSiteAccess({ scan: NO_ACCESS_SCAN, hasAll: false, dismissedAt: refusedAt, now: refusedAt + 1000 }), false);
});

test('after a grant the notice is not shown on the next popup open, whatever was stored before', () => {
  for (const dismissedAt of [null, undefined, 5 * DAY]) {
    assert.equal(shouldOfferSiteAccess({ scan: NO_ACCESS_SCAN, hasAll: true, dismissedAt, now: 40 * DAY }), false);
  }
});
