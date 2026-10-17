import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';

import { EXCLUDE_FILES, STRIP_FILES } from '../scripts/lib/store-package.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'tools', 'extension-wasm');
const win32 = { skip: process.platform !== 'win32' };

function listFiles(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    return entry.isDirectory() ? listFiles(root, child) : [child];
  });
}

// File names in a zip, read from its central directory so no extraction tool is needed.
function zipNames(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, 'not a zip file');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    names.push(buffer.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

let workDir;
let storeDir;
let devDir;

before(() => {
  if (process.platform !== 'win32') return;
  workDir = mkdtempSync(path.join(tmpdir(), 'extension-store-'));
  storeDir = path.join(workDir, 'store');
  devDir = path.join(workDir, 'dev');
  const script = path.join(repoRoot, 'scripts', 'build-wasm-extension.ps1');
  for (const [out, flags] of [[storeDir, ['-Store']], [devDir, []]]) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputRoot', out, ...flags], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const manifestOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

test('store manifest: exactly the specified permissions and hosts', win32, () => {
  const manifest = manifestOf(storeDir);
  assert.equal(manifest.name, 'Card Scanner & Price Checker for Pokémon TCG');
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, [
    'https://api.pokemontcg.io/*',
    'https://api.tcgdex.net/*',
    'https://www.pokemonpricetracker.com/*',
    'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/*',
    'https://objects.githubusercontent.com/*',
    'https://release-assets.githubusercontent.com/*',
    'https://card-scanner-relay.fabcrowd.workers.dev/*',
    'https://github.com/fabcrowd/card-scanner-data/releases/*',
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  assert.equal(manifest.version, '2.1.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal('content_scripts' in manifest, false);
  assert.equal('web_accessible_resources' in manifest, false);
  assert.doesNotMatch(JSON.stringify(manifest), /localhost|127\.0\.0\.1|"tabs"/);
});

test('store package carries no dev code, test hooks, or localhost addresses', win32, () => {
  const dev = /https?:\/\/(?:localhost|127\.0\.0\.1)|testSetCollection|testPhoto|__cardScanner\b|findCardsDiag|importReferences|forceScreenshotPath|dev-only|photoIds|savePhoto|Local dashboard|Test photos/;
  for (const file of listFiles(storeDir).filter((f) => /\.(js|html|json)$/.test(f) && !f.startsWith('vendor/'))) {
    const text = readFileSync(path.join(storeDir, file), 'utf8');
    assert.doesNotMatch(text, dev, file);
  }
  assert.doesNotMatch(readFileSync(path.join(storeDir, 'background.js'), 'utf8'), /chrome\.tabs\.query\(\{\s*url/);
  for (const dropped of EXCLUDE_FILES) assert.equal(existsSync(path.join(storeDir, dropped)), false, dropped);
});

test('every store script still parses, and every import resolves', win32, () => {
  writeFileSync(path.join(storeDir, 'package.json'), '{"type":"module"}');
  try {
    for (const file of listFiles(storeDir).filter((f) => f.endsWith('.js') && !f.startsWith('vendor/'))) {
      const check = spawnSync(process.execPath, ['--check', path.join(storeDir, file)], { encoding: 'utf8' });
      assert.equal(check.status, 0, `${file}: ${check.stderr}`);
    }
  } finally {
    rmSync(path.join(storeDir, 'package.json'));
  }
});

test('store zip holds exactly the package, with the manifest at the root and no test or fixture files', win32, () => {
  const zipPath = `${storeDir}.zip`;
  const names = zipNames(readFileSync(zipPath));
  assert.deepEqual(names.slice().sort(), listFiles(storeDir).sort());
  assert.ok(names.includes('manifest.json'));
  for (const name of names) {
    assert.doesNotMatch(name, /\\/, name);
    assert.doesNotMatch(name, /(^|\/)(tests?|fixtures?|e2e|__tests__)\//i, name);
    assert.doesNotMatch(name, /\.(test|spec)\.[cm]?js$|\.map$|\.md$|\.pt$/i, name);
  }
  assert.ok(!names.some((name) => name.startsWith('models/')), 'unvalidated models must not ship');
  assert.ok(names.includes('vendor/ort.wasm.min.js'));
  assert.ok(names.every((name) => !name.includes('threaded')));
});

test('store files not stripped are identical to the source; stripped ones only lose lines', win32, () => {
  const changed = new Set([...STRIP_FILES, 'manifest.json']);
  const built = listFiles(storeDir);
  const expected = listFiles(sourceRoot).filter((f) => !EXCLUDE_FILES.includes(f) && (!f.startsWith('vendor/') || built.includes(f)));
  assert.deepEqual(built.slice().sort(), expected.sort());
  for (const file of built.filter((f) => !changed.has(f))) {
    assert.deepEqual(readFileSync(path.join(storeDir, file)), readFileSync(path.join(sourceRoot, file)), file);
  }
  for (const file of STRIP_FILES) {
    const sourceLines = readFileSync(path.join(sourceRoot, file), 'utf8').split('\n');
    const storeLines = readFileSync(path.join(storeDir, file), 'utf8').split('\n');
    assert.ok(storeLines.length < sourceLines.length, `${file} lost nothing`);
    let at = 0;
    for (const line of storeLines) {
      while (at < sourceLines.length && sourceLines[at] !== line) at += 1;
      assert.ok(at < sourceLines.length, `${file}: store line is not in the source in order: ${line}`);
      at += 1;
    }
  }
});

test('developer build keeps what the tests rely on and loses only what the store plan removes', win32, () => {
  const manifest = manifestOf(devDir);
  assert.equal(manifest.name, 'Pokémon Card Scanner');
  assert.equal(manifest.version, '2.1.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.ok(manifest.host_permissions.includes('<all_urls>'));
  assert.ok(manifest.host_permissions.includes('https://api.tcgdex.net/*'));
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1:3000/*'));
  assert.equal('optional_host_permissions' in manifest, false);
  assert.equal('content_scripts' in manifest, false);
  assert.equal('web_accessible_resources' in manifest, false);
  assert.match(manifest.description, /Card recognition runs on your device; prices come from public APIs/);

  const read = (file) => readFileSync(path.join(devDir, file), 'utf8');
  assert.match(read('options.html'), /Advanced: Local dashboard/);
  assert.match(read('options.html'), /Test-set collection/);
  assert.match(read('content.js'), /window\.__cardScanner = /);
  assert.match(read('background.js'), /importReferences/);
  assert.match(read('background.js'), /forceScreenshotPath/);
  assert.match(read('lib/condition-pricing.js'), /127\.0\.0\.1:3000/);
  assert.match(read('options.js'), /requestAllSites/);
});

test('both builds carry the disclaimer on the options page', win32, () => {
  for (const dir of [storeDir, devDir]) {
    assert.match(readFileSync(path.join(dir, 'options.html'), 'utf8'), /Not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company\./);
  }
});
