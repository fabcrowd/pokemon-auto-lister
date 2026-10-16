import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyStorePackage, configuredOrigins, STORE_HOSTS, STRIP_FILES, storeManifest, stripDevBlocks } from '../scripts/lib/store-package.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devManifest = JSON.parse(readFileSync(path.join(repoRoot, 'tools', 'extension-wasm', 'manifest.json'), 'utf8'));

test('stripDevBlocks removes marked lines, markers included, and nothing else', () => {
  const source = ['a();', '// dev-only:start', 'b();', 'c();', '// dev-only:end', 'd();', ''].join('\n');
  assert.equal(stripDevBlocks(source, 'x.js'), 'a();\nd();\n');
});

test('stripDevBlocks handles several blocks and html comments', () => {
  const html = ['<p>1</p>', '<!-- dev-only:start -->', '<p>2</p>', '<!-- dev-only:end -->', '<p>3</p>',
    '<!-- dev-only:start -->', '<p>4</p>', '<!-- dev-only:end -->'].join('\r\n');
  assert.equal(stripDevBlocks(html, 'x.html'), '<p>1</p>\r\n<p>3</p>');
});

test('stripDevBlocks leaves a file with no markers alone', () => {
  assert.equal(stripDevBlocks('x();\n', 'x.js'), 'x();\n');
});

test('stripDevBlocks refuses an unclosed, nested, or stray marker', () => {
  assert.throws(() => stripDevBlocks('// dev-only:start\nx();\n', 'a.js'), /a\.js.*never closed/);
  assert.throws(() => stripDevBlocks('// dev-only:start\n// dev-only:start\n// dev-only:end\n', 'a.js'), /nested/);
  assert.throws(() => stripDevBlocks('x();\n// dev-only:end\n', 'a.js'), /without a start/);
});

test('the store manifest has exactly the required hosts and the optional all-sites grant', () => {
  const store = storeManifest(devManifest);
  assert.deepEqual(store.host_permissions, [
    'https://api.pokemontcg.io/*',
    'https://api.tcgdex.net/*',
    'https://www.pokemonpricetracker.com/*',
    'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/*',
    'https://objects.githubusercontent.com/*',
    'https://release-assets.githubusercontent.com/*',
  ]);
  assert.deepEqual(STORE_HOSTS, store.host_permissions);
  assert.deepEqual(store.optional_host_permissions, ['<all_urls>']);
  // runtime.getContexts needs Chrome 116.
  assert.equal(store.minimum_chrome_version, '116');
  assert.equal(devManifest.minimum_chrome_version, '116');
  assert.deepEqual(store.permissions, ['activeTab', 'scripting', 'storage']);
  assert.equal(store.content_scripts, undefined);
  assert.equal(store.web_accessible_resources, undefined);
  assert.equal(JSON.stringify(store).includes('localhost'), false);
  assert.equal(JSON.stringify(store).includes('127.0.0.1'), false);
});

test('the store name and description are the listing copy', () => {
  const listing = readFileSync(path.join(repoRoot, 'docs', 'store', 'listing.md'), 'utf8');
  const name = listing.split(/^## Name\s*$/m)[1].trim().split('\n')[0].trim();
  const short = listing.split(/^## Short description.*$/m)[1].trim().split('\n')[0].trim();
  const store = storeManifest(devManifest);
  assert.equal(store.name, name);
  assert.equal(store.description, short);
  assert.ok(store.description.length <= 132);
  assert.equal(store.version, devManifest.version);
});

test('the store build refuses a dev manifest that still has a content script or web-accessible files', () => {
  assert.throws(() => storeManifest({ ...devManifest, content_scripts: [{}] }), /content_scripts/);
  assert.throws(() => storeManifest({ ...devManifest, web_accessible_resources: [{}] }), /web_accessible_resources/);
});

test('applyStorePackage strips, drops excluded files, and rejects imports of what it dropped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'store-pkg-'));
  try {
    mkdirSync(path.join(dir, 'lib'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(devManifest));
    writeFileSync(path.join(dir, 'INSTALL.md'), 'doc');
    writeFileSync(path.join(dir, 'lib', 'test-photos.js'), 'export const x = 1;\n');
    for (const name of STRIP_FILES.filter((file) => file.endsWith('.js'))) {
      writeFileSync(path.join(dir, name), 'export const keep = 1;\n// dev-only:start\nexport const drop = 2;\n// dev-only:end\n');
    }
    writeFileSync(path.join(dir, 'options.html'), '<p>keep</p>\n<!-- dev-only:start -->\n<p>drop</p>\n<!-- dev-only:end -->\n');
    applyStorePackage(dir);
    assert.equal(existsSync(path.join(dir, 'INSTALL.md')), false);
    assert.equal(existsSync(path.join(dir, 'lib', 'test-photos.js')), false);
    assert.equal(readFileSync(path.join(dir, 'background.js'), 'utf8'), 'export const keep = 1;\n');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).name, storeManifest(devManifest).name);

    writeFileSync(path.join(dir, 'options.js'), 'import { x } from "./lib/test-photos.js";\n');
    assert.throws(() => applyStorePackage(dir), /test-photos\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const configWith = (relay, manifest) => `export const RELAY_URL = "${relay}";
export const PACK_MANIFEST_URL = "${manifest}";
export const PACK_PUBLIC_KEY = "";
`;

test('the shipped shared-config is empty, so the store build adds no host', () => {
  const text = readFileSync(path.join(repoRoot, 'tools', 'extension-wasm', 'lib', 'shared-config.js'), 'utf8');
  assert.deepEqual(configuredOrigins(text), []);
});

test('a configured relay and pack address add their origins once, and only those', () => {
  assert.deepEqual(configuredOrigins(configWith('https://relay.example.org/contribute', '')), ['https://relay.example.org/*']);
  assert.deepEqual(
    configuredOrigins(configWith('https://relay.example.org/a', 'https://relay.example.org/pack/manifest.json')),
    ['https://relay.example.org/*'],
  );
  assert.deepEqual(
    configuredOrigins(configWith('https://relay.example.org', 'https://packs.example.net/manifest.json')),
    ['https://relay.example.org/*', 'https://packs.example.net/*'],
  );
});

test('a github.com pack address is scoped to that repository release downloads, never all of github.com', () => {
  const url = 'https://github.com/fabcrowd/card-scanner-data/releases/latest/download/manifest.json';
  assert.deepEqual(configuredOrigins(configWith('', url)), ['https://github.com/fabcrowd/card-scanner-data/releases/*']);
  assert.throws(() => configuredOrigins(configWith('', 'https://github.com/fabcrowd/card-scanner-data/raw/main/manifest.json')), /releases/);
  assert.throws(() => configuredOrigins(configWith('', 'https://github.com/manifest.json')), /releases/);
});

test('a configured address that is not https, or is not an address, stops the build', () => {
  assert.throws(() => configuredOrigins(configWith('http://relay.example.org', '')), /https/);
  assert.throws(() => configuredOrigins(configWith('relay', '')), /RELAY_URL/);
  assert.throws(() => configuredOrigins('export const nothing = 1;'), /RELAY_URL/);
});

test('storeManifest appends configured origins after the fixed hosts', () => {
  const store = storeManifest(devManifest, ['https://relay.example.org/*']);
  assert.deepEqual(store.host_permissions, [...STORE_HOSTS, 'https://relay.example.org/*']);
  assert.deepEqual(storeManifest(devManifest).host_permissions, STORE_HOSTS);
});

test('applyStorePackage puts the relay origin in the store manifest only when RELAY_URL is set', () => {
  for (const [relay, expected] of [['', STORE_HOSTS], ['https://relay.example.org/in', [...STORE_HOSTS, 'https://relay.example.org/*']]]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'store-cfg-'));
    try {
      mkdirSync(path.join(dir, 'lib'));
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(devManifest));
      writeFileSync(path.join(dir, 'lib', 'shared-config.js'), configWith(relay, ''));
      for (const name of STRIP_FILES.filter((file) => file.endsWith('.js'))) writeFileSync(path.join(dir, name), 'export const keep = 1;\n');
      writeFileSync(path.join(dir, 'options.html'), '<p>keep</p>\n');
      applyStorePackage(dir);
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).host_permissions, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
