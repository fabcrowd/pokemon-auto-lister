import assert from 'node:assert/strict';
import test from 'node:test';
import { createBudget, decodePlan, finalUrlAllowed, imageSize, photoTypeVerdict, readCapped, sniffImageType } from '../tools/extension-wasm/lib/photo-fetch.js';
const { ReadableStream, Headers, Blob } = globalThis;

const pad = (bytes, to = 64) => Uint8Array.from([...bytes, ...new Array(Math.max(0, to - bytes.length)).fill(0)]);
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];
const text = (s) => [...s].map((c) => c.charCodeAt(0));

test('a PNG header gives its size', () => {
  const png = pad([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(3000), ...be32(2000)]);
  assert.deepEqual(imageSize(png), { width: 3000, height: 2000 });
});

test('a GIF header gives its size', () => {
  assert.deepEqual(imageSize(pad([...text('GIF89a'), 0x40, 0x01, 0xf0, 0x00])), { width: 320, height: 240 });
});

test('a JPEG gives the size from its frame header, skipping earlier segments', () => {
  const app0 = [0xff, 0xe0, ...be16(16), ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, ...be16(17), 8, ...be16(4000), ...be16(6000), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  assert.deepEqual(imageSize(pad([0xff, 0xd8, ...app0, ...sof])), { width: 6000, height: 4000 });
  const dht = [0xff, 0xc4, ...be16(6), 0, 0, 0, 0];
  assert.deepEqual(imageSize(pad([0xff, 0xd8, ...dht, ...sof])), { width: 6000, height: 4000 });
});

test('a JPEG whose frame header is past the bytes read, or a scan first, has no known size', () => {
  assert.equal(imageSize(pad([0xff, 0xd8, 0xff, 0xe1, ...be16(5000)])), null);
  assert.equal(imageSize(pad([0xff, 0xd8, 0xff, 0xda, ...be16(8)])), null);
});

test('WebP lossy, lossless and extended headers give their size', () => {
  const riff = [...text('RIFF'), 0, 0, 0, 0, ...text('WEBP')];
  const lossy = pad([...riff, ...text('VP8 '), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]);
  assert.deepEqual(imageSize(lossy), { width: 640, height: 480 });
  const w = 999;
  const h = 699;
  const lossless = pad([...riff, ...text('VP8L'), 0, 0, 0, 0, 0x2f, w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 15]);
  assert.deepEqual(imageSize(lossless), { width: 1000, height: 700 });
  const wide = 5000 - 1;
  const high = 3000 - 1;
  const extended = pad([...riff, ...text('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, wide & 255, (wide >> 8) & 255, wide >> 16, high & 255, (high >> 8) & 255, high >> 16]);
  assert.deepEqual(imageSize(extended), { width: 5000, height: 3000 });
});

test('unknown formats and short files have no size', () => {
  assert.equal(imageSize(pad(text('not an image at all, just text'))), null);
  assert.equal(imageSize(new Uint8Array(5)), null);
  assert.equal(imageSize(null), null);
});

test('a picture beyond 10000 pixels is rejected before it is decoded', () => {
  assert.deepEqual(decodePlan({ width: 12000, height: 800 }, 1600), { known: true, reject: true });
  assert.deepEqual(decodePlan({ width: 800, height: 10001 }, 0), { known: true, reject: true });
});

test('a large picture is shrunk along its long side only, a small one is decoded as is', () => {
  assert.deepEqual(decodePlan({ width: 4000, height: 3000 }, 1600), { known: true, resize: { resizeWidth: 1600, resizeQuality: 'high' } });
  assert.deepEqual(decodePlan({ width: 3000, height: 4000 }, 1600), { known: true, resize: { resizeHeight: 1600, resizeQuality: 'high' } });
  assert.deepEqual(decodePlan({ width: 1200, height: 900 }, 1600), { known: true });
  assert.deepEqual(decodePlan({ width: 4000, height: 3000 }, 0), { known: true });
  assert.deepEqual(decodePlan(null, 1600), { known: false });
});

const streamOf = (chunkSizes, headers = { 'content-type': 'image/jpeg' }) => {
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= chunkSizes.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(chunkSizes[sent++]).fill(7));
    },
  });
  return new Response(body, { headers });
};

test('the body is read whole when it is within the cap', async () => {
  const read = await readCapped(streamOf([100, 100, 50]), 1000, 120);
  assert.equal(read.blob.size, 250);
  assert.equal(read.blob.type, 'image/jpeg');
  assert.equal(read.head.length, 120);
  assert.equal(read.head[119], 7);
});

test('a body over the cap is cut off without reading the rest', async () => {
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(400)); },
  });
  const read = await readCapped(new Response(body, { headers: { 'content-type': 'image/png' } }), 1000);
  assert.equal(read, null);
  assert.ok(pulls <= 6, `kept reading: ${pulls} pulls`);
});

test('a response without a stream falls back to its blob and still obeys the cap', async () => {
  const bare = (size) => ({ headers: new Headers({ 'content-type': 'image/png' }), body: null, blob: async () => new Blob([new Uint8Array(size)], { type: 'image/png' }) });
  assert.equal((await readCapped(bare(10), 100)).blob.size, 10);
  assert.equal(await readCapped(bare(101), 100), null);
});

test('a redirect must end on a public https host the page loaded images from', () => {
  const hosts = new Set(['cdn.example']);
  assert.equal(finalUrlAllowed('https://cdn.example/a.jpg', hosts).hostname, 'cdn.example');
  assert.equal(finalUrlAllowed('https://other.example/a.jpg', hosts), null);
  assert.equal(finalUrlAllowed('https://192.168.0.4/a.jpg', null), null);
  assert.equal(finalUrlAllowed('http://cdn.example/a.jpg', hosts), null);
  assert.equal(finalUrlAllowed('', hosts), null);
  assert.equal(finalUrlAllowed('https://other.example/a.jpg', null).hostname, 'other.example');
});

test('the time budget counts down from its first use and never goes negative', () => {
  let t = 1000;
  const budget = createBudget(8000, () => t);
  assert.equal(budget.remaining(), 8000);
  t += 3000;
  assert.equal(budget.remaining(), 5000);
  t += 9000;
  assert.equal(budget.remaining(), 0);
});

test('content-type verdict: images pass, generic or missing types need their bytes to prove it, the rest are rejected', () => {
  assert.equal(photoTypeVerdict('image/jpeg'), 'image');
  assert.equal(photoTypeVerdict('IMAGE/AVIF; charset=x'), 'image');
  assert.equal(photoTypeVerdict('application/octet-stream'), 'sniff');
  assert.equal(photoTypeVerdict('Application/Octet-Stream; x=1'), 'sniff');
  assert.equal(photoTypeVerdict(''), 'sniff');
  assert.equal(photoTypeVerdict(null), 'sniff');
  for (const bad of ['text/html', 'application/json', 'application/pdf', 'binary/octet-stream']) assert.equal(photoTypeVerdict(bad), 'reject', bad);
});

test('magic-number sniffing names JPEG, PNG, WebP, GIF and AVIF and nothing else', () => {
  const text = (s) => [...s].map((c) => c.charCodeAt(0));
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png');
  assert.equal(sniffImageType(new Uint8Array([...text('RIFF'), 1, 2, 3, 4, ...text('WEBPVP8 ')])), 'image/webp');
  assert.equal(sniffImageType(new Uint8Array(text('GIF89a....'))), 'image/gif');
  assert.equal(sniffImageType(new Uint8Array([0, 0, 0, 0x20, ...text('ftypavif'), 0])), 'image/avif');
  assert.equal(sniffImageType(new Uint8Array([...text('RIFF'), 1, 2, 3, 4, ...text('WAVEfmt ')])), '');
  assert.equal(sniffImageType(new Uint8Array(text('<!doctype html>'))), '');
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8])), '');
  assert.equal(sniffImageType(new Uint8Array(0)), '');
  assert.equal(sniffImageType(null), '');
});

test('acceptance rule: octet-stream or no type is taken only when the bytes are a picture', () => {
  const accept = (type, head) => { const v = photoTypeVerdict(type); return v === 'image' || (v === 'sniff' && sniffImageType(head) !== ''); };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);
  const html = new Uint8Array([...'<html>'].map((c) => c.charCodeAt(0)));
  assert.equal(accept('application/octet-stream', jpeg), true);
  assert.equal(accept('', jpeg), true);
  assert.equal(accept('application/octet-stream', html), false);
  assert.equal(accept('text/html', jpeg), false);
});
