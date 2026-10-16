import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'tools', 'extension-wasm');
const pinned = JSON.parse(readFileSync(path.join(repoRoot, 'scripts', 'vendor-hashes.json'), 'utf8')).files;

function listFiles(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? listFiles(root, child) : [child];
  });
}

// What the build ships from the source tree: everything except vendor files that are not pinned.
function shippedSource() {
  return listFiles(sourceRoot).filter((file) => {
    const parts = file.split(path.sep);
    return parts[0] !== 'vendor' || parts[1] in pinned;
  });
}

function build(extraArgs, { script = path.join(repoRoot, 'scripts', 'build-wasm-extension.ps1'), cwd = repoRoot } = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extraArgs],
    { cwd, encoding: 'utf8' },
  );
}

// A checkout as it is before setup_vendor.ps1 runs: the scripts and the tracked source, no vendor folder.
function cleanCheckout() {
  const root = mkdtempSync(path.join(tmpdir(), 'extension-clean-'));
  cpSync(path.join(repoRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  cpSync(sourceRoot, path.join(root, 'tools', 'extension-wasm'), {
    recursive: true,
    filter: (src) => path.relative(sourceRoot, src).split(path.sep)[0] !== 'vendor',
  });
  return root;
}

test('wasm extension build copies all tracked source files and the pinned vendor files, unchanged', { skip: process.platform !== 'win32' }, () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), 'extension-build-'));
  try {
    const result = build(['-OutputRoot', outputRoot]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const expected = shippedSource();
    assert.deepEqual(listFiles(outputRoot).sort(), expected.sort());
    for (const relative of expected) {
      assert.deepEqual(
        readFileSync(path.join(outputRoot, relative)),
        readFileSync(path.join(sourceRoot, relative)),
        `${relative} differs from its built copy`,
      );
    }
    // The threaded builds are not shipped: ort runs single-threaded and never asks for them.
    assert.equal(existsSync(path.join(outputRoot, 'vendor', 'ort-wasm-threaded.wasm')), false);
    assert.equal(existsSync(path.join(outputRoot, 'vendor', 'ort-wasm-simd-threaded.wasm')), false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('the build stops and points at setup_vendor.ps1 when onnxruntime-web is missing', { skip: process.platform !== 'win32' }, () => {
  const checkout = cleanCheckout();
  const outputRoot = path.join(checkout, 'out');
  try {
    for (const flags of [[], ['-Sealed'], ['-Store']]) {
      const result = build(['-OutputRoot', outputRoot, ...flags], { script: path.join(checkout, 'scripts', 'build-wasm-extension.ps1'), cwd: checkout });
      assert.notEqual(result.status, 0, `${flags.join(' ') || 'default'} build should fail`);
      assert.match(result.stderr + result.stdout, /onnxruntime-web is missing/);
      assert.match(result.stderr + result.stdout, /setup_vendor\.ps1/);
      assert.equal(existsSync(outputRoot), false, 'nothing is written when the build refuses');
    }
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('the build refuses a vendor file that is not the pinned upstream file', { skip: process.platform !== 'win32' }, () => {
  const checkout = cleanCheckout();
  try {
    cpSync(path.join(sourceRoot, 'vendor'), path.join(checkout, 'tools', 'extension-wasm', 'vendor'), { recursive: true });
    writeFileSync(path.join(checkout, 'tools', 'extension-wasm', 'vendor', 'ort.wasm.min.js'), '// patched\n');
    const result = build(['-OutputRoot', path.join(checkout, 'out')], { script: path.join(checkout, 'scripts', 'build-wasm-extension.ps1'), cwd: checkout });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /vendor-hashes\.json/);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
