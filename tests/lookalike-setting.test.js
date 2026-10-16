import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripDevBlocks } from '../scripts/lib/store-package.mjs';

const root = path.join('tools', 'extension-wasm');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('the look-alike setting is in the developer and the store options page, unchecked', () => {
  const html = read('options.html');
  for (const text of [html, stripDevBlocks(html, 'options.html')]) {
    assert.match(text, /<input type="checkbox" id="reduce-lookalikes"> Experimental: reduce look-alike matches/);
    assert.doesNotMatch(text, /id="reduce-lookalikes"[^>]*checked/);
  }
});

test('the setting is stored under one key, read as on only when exactly true, and applied in both scan paths', () => {
  const options = stripDevBlocks(read('options.js'), 'options.js');
  assert.match(options, /reduceLookalikes: lookalikeToggle\.checked/);
  assert.match(options, /lookalikeToggle\.checked = reduceLookalikes === true/);
  const background = stripDevBlocks(read('background.js'), 'background.js');
  assert.match(background, /\.reduceLookalikes === true/);
  assert.equal(background.match(/searchCatalog\(embedding, 20, \{ penalty: await lookalikePenaltyInUse\(\) \}\)/g).length, 2);
});

test('the penalty file is a local asset of the extension, never a download', () => {
  const setup = read(path.join('lib', 'setup.js'));
  assert.doesNotMatch(setup, /hub-penalty/);
  assert.match(read('background.js'), /data\/hub-penalty\.bin/);
});

test('three copies of one name in a photo are checked right after that photo is read', () => {
  const background = read('background.js');
  assert.match(background, /markRepeatedNames\(photoReads\)/);
});
