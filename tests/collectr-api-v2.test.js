import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCollectrApiV2Client } from '../src/collectr/apiV2.js';
import { createCollectrClient } from '../src/collectr/client.js';

const SAMPLE = {
  product_id: '1',
  catalog_category: '3',
  catalog_category_name: 'Pokemon',
  catalog_group: 'Perfect Order',
  product_name: 'Talonflame',
  card_number: '091/088',
  market_price: '2.20',
  card_condition: 'NM',
};

function mockFetch(pages) {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const u = String(url);
    if (u.includes('/accounts/') && u.includes('/collections')) {
      return {
        ok: true,
        async json() {
          return [{ id: 'coll-1', name: 'Main' }];
        },
      };
    }
    if (u.includes('/products')) {
      const offset = Number(new URL(u).searchParams.get('offset') || 0);
      const page = pages[offset / 30] || [];
      return {
        ok: true,
        async json() {
          return { data: page };
        },
      };
    }
    return { ok: false, status: 404, async text() { return 'missing'; } };
  };
  fetchImpl.calls = () => calls;
  return fetchImpl;
}

test('api-v2 sync builds lookup catalog from portfolio pages', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'collectr-v2-'));
  const fetchImpl = mockFetch([[SAMPLE]]);
  const client = createCollectrApiV2Client({
    token: 'tok',
    userId: 'user-1',
    collectionId: 'coll-1',
    cachePath: path.join(dir, 'cache.json'),
    fetchImpl,
  });

  await client.sync();
  const hit = await client.getMarketPrice({
    name: 'Talonflame',
    set: 'Perfect Order',
    number: '091/088',
  });
  assert.ok(hit);
  assert.equal(hit.market, 2.2);
  assert.equal(hit.source, 'collectr-api-v2');
  assert.equal(client.stats().rowCount, 1);
  assert.equal(client.stats().mode, 'api-v2');
  rmSync(dir, { recursive: true, force: true });
});

test('api-v2 soft-fails on 401 and keeps empty stats', async () => {
  const client = createCollectrApiV2Client({
    token: 'bad',
    userId: 'user-1',
    collectionId: 'coll-1',
    fetchImpl: async () => ({ ok: false, status: 401, async text() { return '{"message":"Unauthorized Request"}'; } }),
    log() {},
  });
  await client.sync();
  assert.match(client.stats().lastError || '', /401/);
  assert.equal(await client.getMarketPrice({ name: 'Talonflame' }), null);
});

test('createCollectrClient uses api-v2 when token+user set', () => {
  const client = createCollectrClient({
    token: 't',
    userId: 'u',
    collectionId: 'c',
    dataDir: os.tmpdir(),
    fetchImpl: async () => ({ ok: true, async json() { return { data: [] }; } }),
  });
  assert.equal(client.mode, 'api-v2');
});

test('createCollectrClient falls back to CSV without token', async () => {
  const client = createCollectrClient({
    token: '',
    userId: '',
    csvPath: 'data/collectr-export.csv',
  });
  assert.equal(client.mode, 'csv');
  assert.ok(client.stats().rowCount > 0);
});
