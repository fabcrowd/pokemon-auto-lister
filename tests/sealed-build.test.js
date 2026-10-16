import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'tools', 'extension-wasm');

function listFiles(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? listFiles(root, child) : [child];
  });
}

test('the sealed test build differs from the shipped one only in the source-URL check', { skip: process.platform !== 'win32' }, async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), 'extension-sealed-'));
  try {
    const build = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'build-wasm-extension.ps1'), '-OutputRoot', outputRoot, '-Sealed'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);

    // The ONNX runtime is downloaded into tools/extension-wasm/vendor by setup_vendor.ps1; only the pinned files ship.
    const pinned = JSON.parse(readFileSync(path.join(repoRoot, 'scripts', 'vendor-hashes.json'), 'utf8')).files;
    const built = listFiles(outputRoot).map((file) => file.split(path.sep).join('/')).sort();
    const source = listFiles(sourceRoot).map((file) => file.split(path.sep).join('/'))
      .filter((file) => !file.startsWith('vendor/') || file.slice('vendor/'.length) in pinned)
      .sort();
    assert.deepEqual(built, [...source, 'lib/net-shipped.js'].sort());
    for (const relative of source.filter((file) => file !== 'lib/net.js')) {
      assert.deepEqual(readFileSync(path.join(outputRoot, relative)), readFileSync(path.join(sourceRoot, relative)), relative);
    }
    assert.deepEqual(readFileSync(path.join(outputRoot, 'lib', 'net-shipped.js')), readFileSync(path.join(sourceRoot, 'lib', 'net.js')));

    writeFileSync(path.join(outputRoot, 'package.json'), '{"type":"module"}');
    const net = await import(pathToFileURL(path.join(outputRoot, 'lib', 'net.js')).href);
    for (const ok of ['http://127.0.0.1:3100/img/0.jpg', 'http://127.0.0.1/img/0.jpg', 'https://cdn.example/a.jpg']) {
      assert.ok(net.publicHttpsUrl(ok), ok);
    }
    assert.equal(net.publicHttpsUrl('/img/1.jpg', 'http://127.0.0.1:3100/page/1').href, 'http://127.0.0.1:3100/img/1.jpg');
    for (const no of [
      'http://192.168.1.2/a.jpg', 'http://localhost:3100/a.jpg', 'https://127.0.0.1/a.jpg', 'http://10.0.0.1/a.jpg',
      'http://user:pw@127.0.0.1:3100/a.jpg', 'http://127.0.0.1.evil.test/a.jpg', 'http://example.com/a.jpg', 'ftp://127.0.0.1/a.jpg',
    ]) {
      assert.equal(net.publicHttpsUrl(no), null, no);
    }
    assert.equal(net.isPrivateHost('127.0.0.1'), true);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
