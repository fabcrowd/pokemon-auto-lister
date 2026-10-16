import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createLabelerServer } from '../scripts/lib/sealed-label-server.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const catalog = [
  { id: 'base1-4', name: 'Charizard', set: 'Base Set', setCode: 'base1', number: '4', imageUrl: 'https://img.test/c.png' },
  { id: 'base2-6', name: 'Charizard', set: 'Jungle', setCode: 'base2', number: '6' },
  { id: 'base1-58', name: 'Pikachu', set: 'Base Set', setCode: 'base1', number: '58' },
];

function fixture({ extraRows = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labeler-'));
  fs.mkdirSync(path.join(dir, 'photos'));
  fs.writeFileSync(path.join(dir, 'photos', `${A}.jpg`), 'jpeg-a');
  fs.writeFileSync(path.join(dir, 'photos', `${B}.jpg`), 'jpeg-b');
  const rows = [
    { sha: A, file: `photos/${A}.jpg`, pageUrl: 'https://www.ebay.com/itm/Secret-Title/1', host: 'www.ebay.com', ts: 1, boxes: [[0, 0, 5, 5], [6, 6, 9, 9]], width: 100, height: 100 },
    { sha: B, file: `photos/${B}.jpg`, pageUrl: null, host: null, ts: 2, boxes: [], width: 100, height: 100 },
    ...extraRows,
  ];
  fs.writeFileSync(path.join(dir, 'photos.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labeler-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(staticDir, 'labeler.js'), 'export {}');
  fs.writeFileSync(path.join(staticDir, 'labeler.css'), 'body{}');
  return { dir, staticDir };
}

async function withServer(fn, options = {}) {
  const { dir, staticDir } = fixture(options);
  const server = createLabelerServer({ dir, catalog, staticDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, init = {}) => fetch(base + route, init);
  const post = (body, headers = {}) => call('/api/label', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try {
    await fn({ call, post, dir, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const labelRows = (dir) => fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const finish = (post, sha, missed = 0) => post({ sha, kind: 'photo', missed });

test('next offers the first unlabeled box and hides where the photo came from', async () => {
  await withServer(async ({ call }) => {
    const body = await (await call('/api/next')).json();
    assert.equal(body.done, false);
    assert.equal(body.item.sha, A);
    assert.equal(body.item.boxIndex, 0);
    assert.equal(body.item.review, false);
    assert.deepEqual(body.item.boxes, [[0, 0, 5, 5], [6, 6, 9, 9]]);
    assert.equal(body.item.photoUrl, `/photos/${A}.jpg`);
    assert.equal(body.item.missed, 0);
    assert.deepEqual(body.progress, { labeled: 0, total: 4 });
    assert.equal(/ebay|Secret|pageUrl|host/.test(JSON.stringify(body)), false);
  });
});

test('after the last box the photo is offered for review, and finishing it moves on', async () => {
  await withServer(async ({ call, post, dir }) => {
    const first = await post({ sha: A, boxIndex: 0, kind: 'card', cardId: 'base1-4', edition: 'first', finish: 'holofoil' });
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).progress, { labeled: 1, total: 4 });
    assert.equal((await post({ sha: A, boxIndex: 1, kind: 'bad-box' })).status, 200);
    const review = (await (await call('/api/next')).json()).item;
    assert.equal(review.sha, A);
    assert.equal(review.boxIndex, null);
    assert.equal(review.review, true);
    assert.deepEqual(review.drawn, []);
    assert.equal((await finish(post, A)).status, 200);
    const next = (await (await call('/api/next')).json()).item;
    assert.equal(next.sha, B);
    assert.equal(next.review, true);
    assert.equal(labelRows(dir).length, 3);
  });
});

test('drawn boxes are saved, listed on the review item, and can be removed', async () => {
  await withServer(async ({ call, post }) => {
    await post({ sha: A, boxIndex: 0, kind: 'unknown' });
    await post({ sha: A, boxIndex: 1, kind: 'unknown' });
    assert.equal((await post({ sha: A, drawn: true, drawnId: 0, box: [10, 10, 60, 80], kind: 'card', cardId: 'base2-6', edition: null, finish: 'normal' })).status, 200);
    assert.equal((await post({ sha: A, drawn: true, drawnId: 1, box: [20, 20, 70, 90], kind: 'unknown' })).status, 200);
    const review = (await (await call(`/api/item?sha=${A}`)).json()).item;
    assert.deepEqual(review.drawn.map((d) => [d.drawnId, d.box, d.kind]), [[0, [10, 10, 60, 80], 'card'], [1, [20, 20, 70, 90], 'unknown']]);
    assert.equal(JSON.stringify(review.drawn).includes('base2-6'), false);
    await post({ sha: A, drawn: true, drawnId: 1, kind: 'removed' });
    assert.deepEqual((await (await call(`/api/item?sha=${A}`)).json()).item.drawn.map((d) => d.drawnId), [0]);
    assert.equal((await post({ sha: A, drawn: true, drawnId: 2, box: [0, 0, 500, 80], kind: 'unknown' })).status, 400);
  });
});

test('the unboxable-card count can be raised before finishing a photo', async () => {
  await withServer(async ({ call, post }) => {
    await post({ sha: A, boxIndex: 0, kind: 'unknown' });
    await post({ sha: A, boxIndex: 1, kind: 'unknown' });
    const counted = await (await finish(post, A, 2)).json();
    assert.equal(counted.missed, 2);
    await finish(post, B, 0);
    const done = await (await call('/api/next')).json();
    assert.equal(done.done, true);
    assert.deepEqual(done.progress, { labeled: 4, total: 4 });
    assert.equal((await (await call(`/api/item?sha=${A}`)).json()).item.missed, 2);
  });
});

test('labeling a box again replaces the earlier label', async () => {
  await withServer(async ({ call, post }) => {
    await post({ sha: A, boxIndex: 0, kind: 'unknown' });
    await post({ sha: A, boxIndex: 0, kind: 'card', cardId: 'base2-6' });
    const body = await (await call('/api/next')).json();
    assert.equal(body.item.boxIndex, 1);
    assert.deepEqual(body.progress, { labeled: 1, total: 4 });
  });
});

test('item reopens one box or the photo review and checks its params', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await (await call(`/api/item?sha=${A}&boxIndex=1`)).json()).item.boxIndex, 1);
    assert.equal((await (await call(`/api/item?sha=${A}`)).json()).item.review, true);
    assert.equal((await call(`/api/item?sha=${A}&boxIndex=2`)).status, 400);
    assert.equal((await call(`/api/item?sha=nope&boxIndex=0`)).status, 400);
    assert.equal((await call(`/api/item?sha=${'c'.repeat(64)}&boxIndex=0`)).status, 404);
  });
});

test('rejects labels that do not check out', async () => {
  await withServer(async ({ post, dir }) => {
    const bad = [
      { sha: 'zz', boxIndex: 0, kind: 'unknown' },
      { sha: A, boxIndex: 2, kind: 'unknown' },
      { sha: A, boxIndex: 0, kind: 'card', cardId: 'nope-1' },
      { sha: A, boxIndex: 0, kind: 'card', cardId: 'base1-4', edition: 'second' },
      { sha: A, boxIndex: 0, kind: 'card', cardId: 'base1-4', finish: 'shiny' },
      { sha: 'c'.repeat(64), boxIndex: 0, kind: 'unknown' },
      { sha: A, kind: 'photo', missed: 5000 },
    ];
    for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body));
    assert.equal((await post('{not json')).status, 400);
    assert.equal(fs.existsSync(path.join(dir, 'labels.jsonl')), false);
  });
});

test('a label that cannot be written is a 500, and the server keeps running', async () => {
  await withServer(async ({ call, post, dir }) => {
    fs.mkdirSync(path.join(dir, 'labels.jsonl'));
    assert.equal((await post({ sha: A, boxIndex: 0, kind: 'unknown' })).status, 500);
    assert.equal((await call('/api/next')).status, 500);
    fs.rmdirSync(path.join(dir, 'labels.jsonl'));
    assert.equal((await post({ sha: A, boxIndex: 0, kind: 'unknown' })).status, 200);
  });
});

test('refuses wrong methods, content types, sizes and hosts', async () => {
  await withServer(async ({ call, post, base }) => {
    assert.equal((await call('/api/label')).status, 405);
    assert.equal((await post({ sha: A, boxIndex: 0, kind: 'unknown' }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post('x'.repeat(20000))).status, 413);
    const url = new URL(base);
    const status = await new Promise((resolve, reject) => {
      http.get({ host: url.hostname, port: url.port, path: '/api/next', headers: { host: 'evil.test' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 403);
  });
});

test('every response carries the hardening headers, including errors and photos', async () => {
  await withServer(async ({ call }) => {
    for (const route of ['/api/next', '/nope', `/photos/${A}.jpg`, '/', '/labeler.js']) {
      const res = await call(route);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', route);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', route);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/, route);
      assert.match(csp, /img-src 'self' https:/, route);
      assert.match(csp, /frame-ancestors 'none'/, route);
      await res.arrayBuffer();
    }
  });
});

test('find searches the catalog and returns only what a thumbnail needs', async () => {
  await withServer(async ({ call }) => {
    const body = await (await call('/api/find?q=charizard')).json();
    assert.deepEqual(body.cards.map((c) => c.id), ['base1-4', 'base2-6']);
    assert.deepEqual(Object.keys(body.cards[0]).sort(), ['id', 'imageUrl', 'name', 'number', 'set', 'setCode']);
    assert.deepEqual((await (await call('/api/find?q=')).json()).cards, []);
    assert.deepEqual((await (await call('/api/find?q=' + 'x'.repeat(500))).json()).cards, []);
  });
});

test('index rows whose file is not photos/<sha>.jpg are never served or offered', async () => {
  const sneaky = 'c'.repeat(64);
  await withServer(async ({ call }) => {
    assert.equal((await call(`/photos/${sneaky}.jpg`)).status, 404);
    const body = await (await call('/api/next')).json();
    assert.deepEqual(body.progress, { labeled: 0, total: 4 });
  }, { extraRows: [{ sha: sneaky, file: '../photos.jsonl', boxes: [], width: 10, height: 10 }] });
});

test('serves photos only by a known sha and the three static files only', async () => {
  await withServer(async ({ call }) => {
    const photo = await call(`/photos/${A}.jpg`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.equal(await photo.text(), 'jpeg-a');
    assert.equal((await call(`/photos/${'c'.repeat(64)}.jpg`)).status, 404);
    assert.equal((await call('/photos/..%2Fphotos.jsonl')).status, 404);
    assert.equal((await call('/photos.jsonl')).status, 404);
    assert.equal((await call('/labels.jsonl')).status, 404);
    assert.equal((await call('/')).status, 200);
    assert.match((await call('/labeler.js')).headers.get('content-type'), /javascript/);
    assert.match((await call('/labeler.css')).headers.get('content-type'), /css/);
    assert.equal((await call('/../package.json')).status, 404);
    const lib = await call('/lib/card-picker.js');
    assert.equal(lib.status, 200);
    assert.match(await lib.text(), /renderPickList/);
    assert.equal((await call('/lib/missing.js')).status, 404);
    assert.equal((await call('/lib/..%2F..%2Fmanifest.json')).status, 404);
  });
});
