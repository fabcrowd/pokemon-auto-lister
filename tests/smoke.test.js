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

test('listing-defaults.json has expected shape with multipliers defaulted to 1.0', () => {
  const defaults = JSON.parse(readFileSync(path.join(root, 'config', 'listing-defaults.json'), 'utf8'));
  assert.ok('condition' in defaults);
  assert.ok('sellerPaidShipping' in defaults);
  assert.equal(defaults.smartPricingOff, true);
  assert.equal(defaults.mercariMultiplier, 1.0);
  assert.equal(defaults.ebayMultiplier, 1.0);
});
