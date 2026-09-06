import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { downloadPhotosToInbox, getDownloadPhotosStatus } from '../src/inbox/downloadPhotos.js';
import { createQueue } from '../src/queue/queue.js';
import { createServer } from '../src/server.js';
import { countPendingInbox } from '../src/inbox/watcher.js';

test('downloadPhotosToInbox copies new recent images and skips existing names', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dl-photos-'));
  const photos = path.join(root, 'photos');
  const inbox = path.join(root, 'inbox');
  const dataDir = path.join(root, 'data');
  mkdirSync(photos);
  mkdirSync(inbox);
  mkdirSync(dataDir);

  try {
    const old = path.join(photos, 'old.jpg');
    const neu = path.join(photos, 'new.jpg');
    const already = path.join(photos, 'dup.jpg');
    writeFileSync(old, 'old-bytes');
    writeFileSync(neu, 'new-bytes');
    writeFileSync(already, 'dup-bytes');
    writeFileSync(path.join(inbox, 'dup.jpg'), 'already-here');

    const now = Date.now() / 1000;
    utimesSync(old, now - 100 * 3600, now - 100 * 3600);
    utimesSync(neu, now - 1, now - 1);
    utimesSync(already, now - 1, now - 1);

    const result = downloadPhotosToInbox({
      photosDir: photos,
      inboxDir: inbox,
      dataDir,
      sinceHours: 72,
    });

    assert.equal(result.copied, 1);
    assert.ok(existsSync(path.join(inbox, 'new.jpg')));
    const srcMtime = statSync(neu).mtimeMs;
    const destMtime = statSync(path.join(inbox, 'new.jpg')).mtimeMs;
    assert.ok(Math.abs(srcMtime - destMtime) < 2000, 'copied file should keep source mtime');
    assert.equal(getDownloadPhotosStatus({ photosDir: photos, inboxDir: inbox, dataDir }).lastCopied, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/inbox/download-photos copies into inbox', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dl-api-'));
  const photos = path.join(root, 'photos');
  const inbox = path.join(root, 'inbox');
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  mkdirSync(photos);
  mkdirSync(inbox);
  mkdirSync(dataDir);
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<html></html>');
  writeFileSync(path.join(photos, 'card.jpg'), 'card-bytes');
  const now = Date.now() / 1000;
  utimesSync(path.join(photos, 'card.jpg'), now, now);

  const queue = createQueue(dataDir);
  const server = createServer({
    queue,
    dataDir,
    publicDir,
    inboxDir: inbox,
    countPendingInbox: () => countPendingInbox({ inboxDir: inbox, dataDir }),
    downloadPhotos: (opts = {}) =>
      downloadPhotosToInbox({ photosDir: photos, inboxDir: inbox, dataDir, sinceHours: opts.sinceHours }),
    getDownloadPhotosStatus: () =>
      getDownloadPhotosStatus({ photosDir: photos, inboxDir: inbox, dataDir }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const body = JSON.stringify({ sinceHours: 72 });
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/inbox/download-photos',
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
    assert.equal(result.body.copied, 1);
    assert.ok(existsSync(path.join(inbox, 'card.jpg')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
