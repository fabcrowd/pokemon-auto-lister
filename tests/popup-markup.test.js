import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASSETS, downloadSizeText } from '../tools/extension-wasm/lib/setup.js';

const html = readFileSync(new URL('../tools/extension-wasm/popup.html', import.meta.url), 'utf8');

test('the lot totals are a polite live region, so a change in the lot value is announced', () => {
  const tag = html.match(/<div[^>]*id="lot-totals"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /aria-live="polite"/);
  assert.match(tag, /aria-atomic="true"/);
});

test('the setup screen quotes the rounded sum of the pinned asset sizes', () => {
  const quoted = html.match(/id="setup-size">([^<]*)</)?.[1];
  assert.equal(quoted, downloadSizeText(ASSETS));
  assert.equal(ASSETS.reduce((n, a) => n + a.bytes, 0), 146_839_306);
  assert.match(readFileSync(new URL('../tools/extension-wasm/INSTALL.md', import.meta.url), 'utf8'), /downloads about 147 MB/);
});
