import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('wasm extension build copies all tracked source files', { skip: process.platform !== 'win32' }, () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), 'extension-build-'));
  try {
    const build = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'build-wasm-extension.ps1'), '-OutputRoot', outputRoot],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);

    for (const relative of listFiles(sourceRoot)) {
      assert.deepEqual(
        readFileSync(path.join(outputRoot, relative)),
        readFileSync(path.join(sourceRoot, relative)),
        `${relative} differs from its built copy`,
      );
    }
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
