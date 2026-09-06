import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  buildRolesWithInboxFront,
  listInboxPickerPhotos,
  resolveInboxImagePath,
} from '../src/photos/inboxPick.js';
import { createQueue } from '../src/queue/queue.js';
import { createServer } from '../src/server.js';

test('resolveInboxImagePath accepts basename under inbox and rejects escape', () => {
  const inbox = mkdtempSync(path.join(tmpdir(), 'inbox-pick-'));
  try {
    writeFileSync(path.join(inbox, 'IMG_1.JPG'), 'bytes');
    const resolved = resolveInboxImagePath(inbox, 'IMG_1.JPG');
    assert.ok(resolved.endsWith('IMG_1.JPG'));
    const outside = path.join(tmpdir(), 'outside-secret.jpg');
    writeFileSync(outside, 'nope');
    assert.throws(() => resolveInboxImagePath(inbox, outside), /inside the inbox/);
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});

test('buildRolesWithInboxFront puts chosen front first and keeps back/extras', () => {
  const roles = buildRolesWithInboxFront(
    {
      photos: ['/inbox/corner.jpg', '/inbox/back.jpg'],
      frontImagePath: '/inbox/corner.jpg',
      backImagePath: '/inbox/back.jpg',
    },
    '/inbox/real-front.jpg',
    { extraPaths: ['/inbox/corner2.jpg'] },
  );
  assert.equal(roles.frontImagePath, '/inbox/real-front.jpg');
  assert.equal(roles.backImagePath, '/inbox/back.jpg');
  assert.equal(roles.photos[0], '/inbox/real-front.jpg');
  assert.ok(roles.photos.includes('/inbox/corner.jpg'));
  assert.ok(roles.photos.includes('/inbox/corner2.jpg'));
});

test('listInboxPickerPhotos marks photos already on a card', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'inbox-list-'));
  const inbox = path.join(root, 'inbox');
  const dataDir = path.join(root, 'data');
  mkdirSync(inbox);
  mkdirSync(dataDir);
  try {
    const a = path.join(inbox, 'a.jpg');
    const b = path.join(inbox, 'b.jpg');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    const queue = createQueue(dataDir);
    const id = queue.enqueue({
      title: 't',
      photos: [a],
      frontImagePath: a,
    });
    const list = listInboxPickerPhotos(inbox, { queue });
    assert.equal(list.length, 2);
    const rowA = list.find((p) => p.name === 'a.jpg');
    const rowB = list.find((p) => p.name === 'b.jpg');
    assert.equal(rowA.usedByCardId, id);
    assert.equal(rowB.usedByCardId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/inbox/photos and POST front-from-inbox set front and reprocess', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'inbox-api-front-'));
  const inbox = path.join(root, 'inbox');
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  mkdirSync(inbox);
  mkdirSync(dataDir);
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<html></html>');
  writeFileSync(path.join(inbox, 'IMG_9.JPG'), 'front-bytes');
  writeFileSync(path.join(inbox, 'IMG_8.JPG'), 'corner-bytes');

  const queue = createQueue(dataDir);
  const id = queue.enqueue({
    title: 'needs-front',
    photos: [path.join(inbox, 'IMG_8.JPG')],
    frontImagePath: path.join(inbox, 'IMG_8.JPG'),
    backImagePath: null,
  });
  queue.setStatus(id, 'needs_review');

  const reprocessed = [];
  const server = createServer({
    queue,
    dataDir,
    publicDir,
    inboxDir: inbox,
    onEnqueue: async (cardId) => {
      reprocessed.push(cardId);
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const list = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/inbox/photos' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
        );
      }).on('error', reject);
    });
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 2);

    const body = JSON.stringify({ name: 'IMG_9.JPG', rematchCloseups: false });
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/cards/${id}/photos/front-from-inbox`,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    assert.equal(result.status, 200);
    assert.ok(result.body.frontImagePath.endsWith('IMG_9.JPG'));
    assert.deepEqual(reprocessed, [id]);
    assert.equal(queue.get(id).frontImagePath.endsWith('IMG_9.JPG'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
