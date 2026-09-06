import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createCollectrCatalog } from '../src/collectr/catalog.js';

const CSV = path.join('data', 'collectr-export.csv');

test('Collectr catalog loads pokemon rows from export.csv', () => {
  const catalog = createCollectrCatalog({ csvPath: CSV });
  const { rowCount } = catalog.stats();
  assert.ok(rowCount > 1000, `expected many pokemon rows, got ${rowCount}`);
});

test('Collectr catalog matches Talonflame Perfect Order by name/set/number', () => {
  const catalog = createCollectrCatalog({ csvPath: CSV });
  const hit = catalog.getMarketPrice({
    name: 'Talonflame',
    set: 'Perfect Order',
    number: '091/088',
  });
  assert.ok(hit);
  assert.equal(hit.market, 2.2);
  assert.equal(hit.source, 'collectr-csv');
});

test('Collectr catalog returns null for unknown cards', () => {
  const catalog = createCollectrCatalog({ csvPath: CSV });
  assert.equal(catalog.getMarketPrice({ name: 'Definitely Not A Real Card', number: '999/999' }), null);
});

test('Collectr catalog reports stale after 24 hours', () => {
  const catalog = createCollectrCatalog({ csvPath: CSV });
  const fresh = catalog.stats(Date.now());
  assert.equal(typeof fresh.stale, 'boolean');
  assert.ok(fresh.ageMs != null);
  const old = catalog.stats((fresh.mtimeMs || Date.now()) + 25 * 60 * 60 * 1000);
  assert.equal(old.stale, true);
});

test('Collectr catalog reload picks up the same path', () => {
  const catalog = createCollectrCatalog({ csvPath: CSV });
  const first = catalog.stats().rowCount;
  const second = catalog.reload().rowCount;
  assert.equal(first, second);
  assert.ok(first > 0);
});
