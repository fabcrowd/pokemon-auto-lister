import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createQueue } from '../src/queue/queue.js';
import { countPendingInbox, scanInbox } from '../src/inbox/watcher.js';
import { priceDrift, PRICE_DRIFT_THRESHOLD, postedListPrice } from '../src/pricing/pricing.js';
import { rescanListedPrices } from '../src/pricing/monitor.js';
import { createServer } from '../src/server.js';
import { createDraftDispatcher } from '../src/dispatch/draftDispatch.js';

test('PRICE_DRIFT_THRESHOLD is 5%', () => {
  assert.equal(PRICE_DRIFT_THRESHOLD, 0.05);
});

test('priceDrift treats 4.9% as within band and 5.1% as outside', () => {
  assert.equal(priceDrift(100, 104.9).withinBand, true);
  assert.equal(priceDrift(100, 105.1).withinBand, false);
  assert.ok(Math.abs(priceDrift(100, 105.1).delta - 0.051) < 1e-9);
});

test('postedListPrice prefers listPrice over suggested', () => {
  assert.equal(postedListPrice({ listPrice: 12, pricedCache: { suggested: { mercari: 99 } } }), 12);
  assert.equal(postedListPrice({ pricedCache: { suggested: { mercari: 40 } } }), 40);
});

test('countPendingInbox counts unseen flat pairs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pending-inbox-'));
  const inbox = path.join(dir, 'inbox');
  mkdirSync(inbox);
  try {
    const a = path.join(inbox, 'a.jpg');
    const b = path.join(inbox, 'b.jpg');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    const now = Date.now() / 1000;
    utimesSync(a, now - 10, now - 10);
    utimesSync(b, now - 5, now - 5);

    const pending = await countPendingInbox({
      inboxDir: inbox,
      dataDir: dir,
      classifyShotFn: async (photoPath) => ({
        path: photoPath,
        kind: path.basename(photoPath).startsWith('b') ? 'full_back' : 'full_front',
        score: 0.8,
      }),
    });
    assert.equal(pending.pendingPairs, 1);
    assert.equal(pending.pendingTotal, 1);

    const queue = createQueue(dir);
    await scanInbox({
      inboxDir: inbox,
      queue,
      dataDir: dir,
      classifyShotFn: async (photoPath) => ({
        path: photoPath,
        kind: path.basename(photoPath).startsWith('b') ? 'full_back' : 'full_front',
        score: 0.8,
      }),
    });
    assert.equal(
      (
        await countPendingInbox({
          inboxDir: inbox,
          dataDir: dir,
          classifyShotFn: async (photoPath) => ({
            path: photoPath,
            kind: 'closeup',
            score: 0.2,
          }),
        })
      ).pendingTotal,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rescanListedPrices moves drifted cards to needs_review', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'price-mon-'));
  try {
    const queue = createQueue(dir);
    const id = queue.enqueue({
      title: 'drift-card',
      mercari: true,
    });
    queue.patch(id, {
      listPrice: 100,
      pricedCache: {
        identity: { name: 'Pikachu', number: '25', set: 'Base' },
        comps: { pokegrade: 100 },
        suggested: { mercari: 100, ebay: 100 },
        action: 'auto',
      },
    });
    queue.markListed(id, 'mercari', { listingUrl: 'https://www.mercari.com/item/m1/' });

    const summary = await rescanListedPrices({
      queue,
      tcgplayerClient: { getMarketPrice: async () => ({ market: 120 }) },
      ebaySoldsClient: { getRecentSolds: async () => ({ median: 118 }) },
      collectrClient: { getMarketPrice: async () => ({ market: 119 }) },
    });

    assert.equal(summary.drifted, 1);
    const card = queue.get(id);
    assert.equal(card.status, 'needs_review');
    assert.equal(card.pricedCache.action, 'price_drift');
    assert.equal(card.priceMonitor.withinBand, false);
    assert.equal(card.priceMonitor.posted, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rescanListedPrices leaves within-band listings alone', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'price-ok-'));
  try {
    const queue = createQueue(dir);
    const id = queue.enqueue({
      title: 'ok-card',
      mercari: true,
    });
    queue.patch(id, {
      listPrice: 100,
      pricedCache: {
        identity: { name: 'Eevee', number: '133', set: 'Jungle' },
        comps: { pokegrade: 100 },
        suggested: { mercari: 100, ebay: 100 },
        action: 'auto',
      },
    });
    queue.markListed(id, 'mercari', { listingUrl: 'https://www.mercari.com/item/m2/' });

    const summary = await rescanListedPrices({
      queue,
      tcgplayerClient: { getMarketPrice: async () => ({ market: 102 }) },
      ebaySoldsClient: { getRecentSolds: async () => ({ median: 101 }) },
      collectrClient: { getMarketPrice: async () => ({ market: 103 }) },
    });

    assert.equal(summary.drifted, 0);
    assert.equal(queue.get(id).status, 'listed');
    assert.equal(queue.get(id).priceMonitor.withinBand, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirm clears mercari created so Repost can re-drive the driver', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repost-'));
  const publicDir = mkdtempSync(path.join(tmpdir(), 'repost-pub-'));
  writeFileSync(path.join(publicDir, 'index.html'), '<html></html>');
  try {
    const queue = createQueue(dir);
    const id = queue.enqueue({
      title: 'repost-me',
      mercari: true,
      ebay: false,
    });
    queue.patch(id, {
      listPrice: 50,
      pricedCache: {
        identity: { name: 'Mew', number: '151' },
        suggested: { mercari: 60, ebay: 60 },
        action: 'price_drift',
        comps: {},
      },
      priceMonitor: { posted: 50, market: 60, delta: 0.2, withinBand: false },
    });
    queue.markListed(id, 'mercari', { listingUrl: 'https://www.mercari.com/item/old/' });
    queue.setStatus(id, 'needs_review');

    let driverCalls = 0;
    const createDraft = createDraftDispatcher({
      queue,
      dataDir: dir,
      drivers: {
        mercari: async () => {
          driverCalls += 1;
          return { listingUrl: 'https://www.mercari.com/item/new/', published: true };
        },
      },
    });

    const server = createServer({ queue, dataDir: dir, publicDir, createDraft });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const body = JSON.stringify({ price: 60 });
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/cards/${id}/confirm`,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    assert.equal(result.statusCode, 200);
    assert.equal(driverCalls, 1);
    assert.equal(result.body.status, 'listed');
    assert.match(result.body.listingUrl, /\/new\//);

    await new Promise((resolve) => server.close(resolve));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  }
});

test('GET /api/inbox/status and POST /api/inbox/scan enqueue pending pairs', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'inbox-api-'));
  const publicDir = mkdtempSync(path.join(tmpdir(), 'inbox-api-pub-'));
  const inboxDir = path.join(dataDir, 'album');
  mkdirSync(inboxDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<html></html>');
  const a = path.join(inboxDir, '1.jpg');
  const b = path.join(inboxDir, '2.jpg');
  writeFileSync(a, 'one');
  writeFileSync(b, 'two');
  const now = Date.now() / 1000;
  utimesSync(a, now - 2, now - 2);
  utimesSync(b, now - 1, now - 1);

  const queue = createQueue(dataDir);
  const enqueued = [];
  const classifyShotFn = async (photoPath) => ({
    path: photoPath,
    kind: path.basename(photoPath).startsWith('1') ? 'full_front' : 'full_back',
    score: 0.8,
  });
  const server = createServer({
    queue,
    dataDir,
    publicDir,
    inboxDir,
    countPendingInbox: () => countPendingInbox({ inboxDir, dataDir, classifyShotFn }),
    scanInbox: (opts) =>
      scanInbox({
        inboxDir,
        queue,
        dataDir,
        marketplaceDefaults: opts.marketplaceDefaults,
        forceRescan: Boolean(opts.forceRescan),
        onEnqueue: async (id) => enqueued.push(id),
        classifyShotFn,
      }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/inbox/status' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }).on('error', reject);
    });
    assert.equal(status.watching, false);
    assert.equal(status.pendingTotal, 1);

    const scanBody = JSON.stringify({ mercari: true, ebay: false });
    const scan = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/inbox/scan',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(scanBody) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
          );
        },
      );
      req.on('error', reject);
      req.write(scanBody);
      req.end();
    });

    assert.equal(scan.statusCode, 200);
    assert.equal(scan.body.count, 1);
    assert.equal(enqueued.length, 1);
    assert.equal(queue.get(enqueued[0]).ebay, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  }
});
