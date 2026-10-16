import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseFallbackTab, isOwnPage } from '../tools/extension-wasm/lib/page-target.js';

const tab = (id, over = {}) => ({ id, windowId: id, active: true, url: `https://shop.example/${id}`, lastAccessed: id, ...over });

test('the fallback is the most recently used active tab of a normal window, never the scanner window', () => {
  const tabs = [tab(1, { lastAccessed: 10 }), tab(2, { lastAccessed: 50 }), tab(3, { lastAccessed: 90 })];
  assert.deepEqual(chooseFallbackTab(tabs, 3), { tab: tabs[1] });
});

test('background tabs are not candidates', () => {
  assert.deepEqual(chooseFallbackTab([tab(1, { active: false })], null), { tab: null, reason: 'none' });
});

test('browser pages are skipped even when a readable page is older', () => {
  const tabs = [tab(1, { lastAccessed: 1 }), tab(2, { url: 'chrome://extensions', lastAccessed: 99 })];
  assert.equal(chooseFallbackTab(tabs, null).tab.id, 1);
});

test('a candidate whose address cannot be read is not guessed at', () => {
  assert.deepEqual(chooseFallbackTab([tab(1, { url: undefined })], null), { tab: null, reason: 'unreadable' });
});

test('no tabs at all', () => {
  assert.deepEqual(chooseFallbackTab([], null), { tab: null, reason: 'none' });
});

const BASE = 'chrome-extension://abc/';

test('only the extension pages pass, whether or not they are in a tab', () => {
  assert.equal(isOwnPage({ id: 'abc', url: BASE + 'popup.html', tab: { id: 4 } }, 'abc', BASE), true);
  assert.equal(isOwnPage({ id: 'abc', url: BASE + 'options.html' }, 'abc', BASE), true);
  assert.equal(isOwnPage({ id: 'abc', url: 'https://evil.example/', tab: { id: 4 } }, 'abc', BASE), false);
  assert.equal(isOwnPage({ id: 'other', url: BASE + 'popup.html' }, 'abc', BASE), false);
  assert.equal(isOwnPage({ id: 'abc' }, 'abc', BASE), false);
});
