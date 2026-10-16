// Turns a copy of tools/extension-wasm into the Chrome Web Store package.
//
//   node scripts/lib/store-package.mjs <directory>
//
// The developer build is the tracked source. The store build differs in three ways:
//   1. manifest.json: store name and description, only the hosts the shipped features need,
//      and site-wide access as an optional permission.
//   2. Lines between "dev-only:start" and "dev-only:end" comments are removed (test-photo
//      collection, the localhost dashboard, test hooks). Removed, not switched off: the
//      package must not contain code a reviewer would have to reason about.
//   3. Files the store package must not carry are deleted.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORE_NAME = 'Card Scanner & Price Checker for Pokémon TCG';
export const STORE_DESCRIPTION =
  'Find Pokémon cards in photos on the page you are viewing and see their prices. Card recognition runs on your device.';

export const STORE_HOSTS = [
  'https://api.pokemontcg.io/*',
  'https://api.tcgdex.net/*',
  'https://www.pokemonpricetracker.com/*',
  // Models are release files of this repository; GitHub redirects the download to the two hosts below.
  'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/*',
  'https://objects.githubusercontent.com/*',
  'https://release-assets.githubusercontent.com/*',
];

export const STRIP_FILES = ['background.js', 'content.js', 'options.js', 'options.html', 'lib/condition-pricing.js', 'lib/corrections-store.js'];
// The variant model is held back until it passes the sealed test (docs/plans/card-picker-and-sealed-test.md).
export const EXCLUDE_FILES = ['INSTALL.md', 'lib/test-photos.js', 'models/variant.onnx'];

const START = 'dev-only:start';
const END = 'dev-only:end';

export function stripDevBlocks(text, name) {
  const lines = text.split(/(?<=\n)/);
  const kept = [];
  let open = null;
  lines.forEach((line, index) => {
    if (line.includes(START)) {
      if (open !== null) throw new Error(`${name}:${index + 1}: dev-only block nested inside the one from line ${open + 1}`);
      open = index;
    } else if (line.includes(END)) {
      if (open === null) throw new Error(`${name}:${index + 1}: dev-only:end without a start`);
      open = null;
    } else if (open === null) {
      kept.push(line);
    }
  });
  if (open !== null) throw new Error(`${name}:${open + 1}: dev-only block never closed`);
  const result = kept.join('');
  // A block that ended the file leaves the previous line's break behind; the markers' own line break went with them.
  return result === text ? text : result.replace(/(\r?\n)+$/, (tail) => (text.endsWith('\n') ? tail : ''));
}

const CONFIG_FILE = 'lib/shared-config.js';
const ORIGIN_SETTINGS = ['RELAY_URL', 'PACK_MANIFEST_URL'];

// github.com hosts everyone's files, so its pattern is cut down to one repository's release downloads.
function hostPattern(name, url) {
  if (url.hostname !== 'github.com') return `${url.origin}/*`;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\//);
  if (!match) throw new Error(`${name} on github.com must be a release address (https://github.com/<owner>/<repo>/releases/...)`);
  return `https://github.com/${match[1]}/${match[2]}/releases/*`;
}

/**
 * Host permissions for the addresses the owner set in lib/shared-config.js. An empty address adds nothing: the
 * feature is off in that build and the package asks for no more hosts.
 */
export function configuredOrigins(configText) {
  const origins = [];
  for (const name of ORIGIN_SETTINGS) {
    const match = configText.match(new RegExp(`export const ${name} = "([^"]*)"`));
    if (!match) throw new Error(`${CONFIG_FILE} must define ${name} as a string`);
    if (!match[1]) continue;
    let url;
    try {
      url = new URL(match[1]);
    } catch {
      throw new Error(`${name} is not an address: ${match[1]}`);
    }
    if (url.protocol !== 'https:') throw new Error(`${name} must be an https address`);
    const host = hostPattern(name, url);
    if (!origins.includes(host)) origins.push(host);
  }
  return origins;
}

export function storeManifest(dev, extraHosts = []) {
  for (const key of ['content_scripts', 'web_accessible_resources']) {
    if (dev[key] !== undefined) throw new Error(`manifest.json still declares ${key}; the extension injects on demand`);
  }
  return {
    ...dev,
    name: STORE_NAME,
    description: STORE_DESCRIPTION,
    host_permissions: [...STORE_HOSTS, ...extraHosts],
    optional_host_permissions: ['<all_urls>'],
  };
}

function listFiles(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    return entry.isDirectory() ? listFiles(root, child) : [child];
  });
}

// Every relative import in the package must land on a file that is in the package.
function assertImportsResolve(dir) {
  const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  for (const file of listFiles(dir).filter((f) => f.endsWith('.js') && !f.startsWith('vendor/'))) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const target = path.join(dir, path.dirname(file), match[1]);
      if (!existsSync(target)) throw new Error(`${file} imports ${match[1]}, which is not in the store package`);
    }
  }
}

const DENIED = /127\.0\.0\.1|localhost:|__cardScanner\b|findCardsDiag|importReferences|testSetCollection|forceScreenshotPath|dev-only/;
const BANNED_FILE = /(^|\/)models\/|\.map$|\.md$|\.onnx$/i;

/**
 * The last gate before packaging: nothing banned is in the directory, no script has a syntax error,
 * and no dev-only string survived. The vendored onnxruntime file is minified third-party code and is
 * only checked for being the pinned file (by the build), not read here.
 */
export function assertPackageClean(dir) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'store-syntax-'));
  try {
    for (const file of listFiles(dir)) {
      if (BANNED_FILE.test(file)) throw new Error(`${file} must not be in the store package`);
      if (file.startsWith('vendor/') || !/\.(js|html|json)$/.test(file)) continue;
      const text = readFileSync(path.join(dir, file), 'utf8');
      const hit = text.match(DENIED);
      if (hit) throw new Error(`${file} contains "${hit[0]}", which must not ship`);
      if (file.endsWith('.js')) {
        const copy = path.join(scratch, 'check.mjs');
        writeFileSync(copy, text);
        const check = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
        if (check.status !== 0) throw new Error(`${file} has a syntax error: ${check.stderr.split(/\r?\n/).find((l) => /Error/.test(l)) || check.stderr}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function applyStorePackage(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  const configPath = path.join(dir, CONFIG_FILE);
  const extraHosts = existsSync(configPath) ? configuredOrigins(readFileSync(configPath, 'utf8')) : [];
  writeFileSync(manifestPath, JSON.stringify(storeManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), extraHosts), null, 2) + '\n');
  for (const file of STRIP_FILES) {
    const full = path.join(dir, file);
    writeFileSync(full, stripDevBlocks(readFileSync(full, 'utf8'), file));
  }
  for (const file of EXCLUDE_FILES) rmSync(path.join(dir, file), { force: true });
  assertImportsResolve(dir);
  assertPackageClean(dir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: node store-package.mjs <directory>');
  applyStorePackage(path.resolve(process.argv[2]));
}
