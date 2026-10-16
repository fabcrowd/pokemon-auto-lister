import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertPackageClean } from '../scripts/lib/store-package.mjs';

test('assertPackageClean fails on a denied string, a syntax error, or a banned file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'store-clean-'));
  try {
    writeFileSync(path.join(dir, 'ok.js'), 'export const a = 1;\n');
    assertPackageClean(dir);

    const denied = ['127.0.0.1', 'localhost:3000', '__cardScanner', 'findCardsDiag', 'importReferences', 'testSetCollection', 'forceScreenshotPath', 'dev-only'];
    for (const bad of denied) {
      writeFileSync(path.join(dir, 'bad.js'), `export const a = "${bad}";\n`);
      assert.throws(() => assertPackageClean(dir), (err) => err.message.includes('bad.js') && /must not ship/.test(err.message), bad);
    }

    writeFileSync(path.join(dir, 'bad.js'), 'export const = ;\n');
    assert.throws(() => assertPackageClean(dir), /bad\.js.*syntax/i);
    rmSync(path.join(dir, 'bad.js'));

    for (const banned of ['m.onnx', 'x.js.map', 'README.md']) {
      writeFileSync(path.join(dir, banned), 'x');
      assert.throws(() => assertPackageClean(dir), (err) => err.message.includes(banned), banned);
      rmSync(path.join(dir, banned));
    }

    mkdirSync(path.join(dir, 'models'));
    writeFileSync(path.join(dir, 'models', 'a.bin'), 'x');
    assert.throws(() => assertPackageClean(dir), /models/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vendor files are not scanned for text or syntax', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'store-clean-'));
  try {
    mkdirSync(path.join(dir, 'vendor'));
    writeFileSync(path.join(dir, 'vendor', 'ort.wasm.min.js'), 'var x="localhost:1";');
    assertPackageClean(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
