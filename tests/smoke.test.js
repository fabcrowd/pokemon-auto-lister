import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

test('package.json declares test and lint scripts and uses ESM', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.ok(typeof pkg.scripts?.test === 'string' && pkg.scripts.test.length > 0);
  assert.ok(typeof pkg.scripts?.lint === 'string' && pkg.scripts.lint.length > 0);
});

