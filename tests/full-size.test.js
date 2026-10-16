import assert from 'node:assert/strict';
import test from 'node:test';
import { fullSizeCandidates, loadFullSize, sameAspect } from '../tools/extension-wasm/lib/full-size.js';
import { imageToViewportTransform, mapPhotoBoxToViewport, rescaleTransform } from '../tools/extension-wasm/photo-detection.js';

const BASE = 'https://shop.example/item/1';

test('an eBay thumbnail is rewritten to the 1600 rendition, other hints follow', () => {
  const urls = fullSizeCandidates({
    src: 'https://i.ebayimg.com/images/g/AbC/s-l300.jpg',
    naturalWidth: 234,
    base: BASE,
  });
  assert.equal(urls[0], 'https://i.ebayimg.com/images/g/AbC/s-l1600.jpg');
  assert.equal(urls.includes('https://i.ebayimg.com/images/g/AbC/s-l300.jpg'), false);
});

test('an eBay image already at 1600 is not rewritten', () => {
  assert.deepEqual(fullSizeCandidates({ src: 'https://i.ebayimg.com/images/g/AbC/s-l1600.webp', naturalWidth: 900, base: BASE }), []);
});

test('srcset entries are ordered by width and smaller-than-displayed ones are dropped', () => {
  const urls = fullSizeCandidates({
    src: 'https://cdn.example/p/a-300.jpg',
    naturalWidth: 300,
    srcset: 'https://cdn.example/p/a-300.jpg 300w, https://cdn.example/p/a-900.jpg 900w, /p/a-600.jpg 600w, https://cdn.example/p/a-200.jpg 200w',
    base: BASE,
  });
  assert.deepEqual(urls, ['https://cdn.example/p/a-900.jpg', 'https://shop.example/p/a-600.jpg']);
});

test('x descriptors are understood', () => {
  const urls = fullSizeCandidates({
    src: 'https://cdn.example/a.jpg',
    naturalWidth: 400,
    srcset: 'https://cdn.example/a.jpg 1x, https://cdn.example/a@3x.jpg 3x, https://cdn.example/a@2x.jpg 2x',
    base: BASE,
  });
  assert.deepEqual(urls, ['https://cdn.example/a@3x.jpg', 'https://cdn.example/a@2x.jpg']);
});

test('zoom attributes and an image link are candidates; a page link and og:image of another picture are not', () => {
  const urls = fullSizeCandidates({
    src: 'https://cdn.example/t/thumb.jpg',
    naturalWidth: 200,
    attrs: ['https://cdn.example/t/zoom.jpg', '//cdn.example/t/large.png', 'not a url', 'javascript:alert(1)'],
    link: 'https://cdn.example/t/big.jpeg?x=1',
    ogImages: ['https://cdn.example/other/cover.jpg'],
    base: BASE,
  });
  assert.deepEqual(urls, ['https://cdn.example/t/zoom.jpg', 'https://cdn.example/t/large.png', 'https://cdn.example/t/big.jpeg?x=1']);
  assert.deepEqual(fullSizeCandidates({ src: 'https://cdn.example/t/thumb.jpg', naturalWidth: 200, link: 'https://shop.example/item/2', base: BASE }), []);
});

test('og:image counts only when it is the same picture at another size', () => {
  const urls = fullSizeCandidates({
    src: 'https://cdn.example/p/card_300x400.jpg',
    naturalWidth: 300,
    ogImages: ['https://cdn.example/p/card_1200x1600.jpg', 'https://cdn.example/p/different.jpg'],
    base: BASE,
  });
  assert.equal(urls.includes('https://cdn.example/p/card_1200x1600.jpg'), true);
  assert.equal(urls.includes('https://cdn.example/p/different.jpg'), false);
});

test('size suffixes and width parameters are rewritten', () => {
  assert.equal(fullSizeCandidates({ src: 'https://blog.example/wp/card-300x420.jpg', naturalWidth: 300, base: BASE })[0],
    'https://blog.example/wp/card.jpg');
  assert.equal(fullSizeCandidates({ src: 'https://cdn.example/card_240x.jpg', naturalWidth: 240, base: BASE })[0],
    'https://cdn.example/card.jpg');
  assert.equal(fullSizeCandidates({ src: 'https://img.example/a.jpg?w=300&auto=format', naturalWidth: 300, base: BASE })[0],
    'https://img.example/a.jpg?w=1600&auto=format');
  assert.equal(fullSizeCandidates({ src: 'https://img.example/a.jpg?width=300&height=400', naturalWidth: 300, base: BASE })[0],
    'https://img.example/a.jpg?width=1600&height=2133');
});

test('only https URLs on hosts the page itself named are produced', () => {
  const urls = fullSizeCandidates({
    src: 'http://insecure.example/a-300.jpg',
    naturalWidth: 300,
    srcset: 'http://insecure.example/a-900.jpg 900w, https://ok.example/a-900.jpg 900w, ftp://x.example/a.jpg 1200w',
    attrs: ['http://insecure.example/zoom.jpg', 'https://user:pw@ok.example/zoom.jpg', 'data:image/png;base64,AAAA'],
    base: BASE,
  });
  assert.deepEqual(urls, ['https://ok.example/a-900.jpg']);
});

test('duplicates collapse and the displayed URL is never returned', () => {
  const urls = fullSizeCandidates({
    src: 'https://i.ebayimg.com/images/g/X/s-l500.jpg',
    currentSrc: 'https://i.ebayimg.com/images/g/X/s-l500.jpg',
    naturalWidth: 400,
    srcset: 'https://i.ebayimg.com/images/g/X/s-l1600.jpg 1600w',
    attrs: ['https://i.ebayimg.com/images/g/X/s-l1600.jpg'],
    base: BASE,
  });
  assert.deepEqual(urls, ['https://i.ebayimg.com/images/g/X/s-l1600.jpg']);
});

test('garbage input yields no candidates', () => {
  assert.deepEqual(fullSizeCandidates({}), []);
  assert.deepEqual(fullSizeCandidates({ src: '', srcset: ',,', attrs: [null, 5] }), []);
});

test('sameAspect allows about 3 percent', () => {
  assert.equal(sameAspect({ width: 234, height: 300 }, { width: 1600, height: 2051 }), true);
  assert.equal(sameAspect({ width: 234, height: 300 }, { width: 1600, height: 1600 }), false);
  assert.equal(sameAspect({ width: 234, height: 300 }, { width: 1600, height: 2200 }), false);
  assert.equal(sameAspect({ width: 0, height: 300 }, { width: 10, height: 10 }), false);
});

const bitmap = (width, height, log = []) => ({ width, height, close: () => log.push(`close ${width}x${height}`) });

test('loadFullSize takes the first candidate that is larger and has the same shape', async () => {
  const closed = [];
  const tried = [];
  const sources = {
    a: null,
    b: bitmap(1000, 1000, closed),
    c: bitmap(234, 300, closed),
    d: bitmap(1600, 2050, closed),
    e: bitmap(2000, 2564, closed),
  };
  const got = await loadFullSize(['a', 'b', 'c', 'd', 'e'], { width: 234, height: 300 }, async (url) => {
    tried.push(url);
    return sources[url];
  });
  assert.equal(got.url, 'd');
  assert.equal(got.bitmap.width, 1600);
  assert.deepEqual(tried, ['a', 'b', 'c', 'd']);
  assert.deepEqual(closed, ['close 1000x1000', 'close 234x300']);
});

test('loadFullSize survives a loader that throws and returns null when nothing fits', async () => {
  const got = await loadFullSize(['a', 'b'], { width: 100, height: 100 }, async (url) => {
    if (url === 'a') throw new Error('network');
    return null;
  });
  assert.equal(got, null);
  assert.equal(await loadFullSize([], { width: 100, height: 100 }, async () => bitmap(500, 500)), null);
  assert.equal(await loadFullSize(['a'], { width: 0, height: 0 }, async () => bitmap(500, 500)), null);
});

test('boxes found in an upgraded image land where the same box would in the displayed one', () => {
  const rect = { x: 100, y: 50, w: 234, h: 300 };
  const shown = imageToViewportTransform(rect, 234, 300, { fit: 'fill', position: '50% 50%' });
  const upgraded = rescaleTransform(shown, 234 / 1600, 300 / 2051);
  const small = mapPhotoBoxToViewport([10, 20, 110, 160], shown);
  const big = mapPhotoBoxToViewport([10 * 1600 / 234, 20 * 2051 / 300, 110 * 1600 / 234, 160 * 2051 / 300], upgraded);
  small.forEach((value, i) => assert.ok(Math.abs(value - big[i]) < 1e-9, `${i}: ${value} vs ${big[i]}`));
});

test('rescaling keeps object-fit none, which is sized by the displayed image, correct', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const shown = imageToViewportTransform(rect, 234, 300, { fit: 'none', position: '0% 0%' });
  const upgraded = rescaleTransform(shown, 234 / 1600, 300 / 2051);
  const [x1, , x2] = mapPhotoBoxToViewport([0, 0, 1600, 2051], upgraded);
  assert.ok(Math.abs(x1) < 1e-9 && Math.abs(x2 - 234) < 1e-9, `${x1} ${x2}`);
  assert.equal(rescaleTransform(null, 1, 1), null);
});

test('candidates on a host the page never loaded images from are dropped', () => {
  const hints = {
    src: 'https://cdn.example/p/a-300.jpg',
    naturalWidth: 300,
    srcset: 'https://cdn.example/p/a-900.jpg 900w, https://evil.example/a-1200.jpg 1200w',
    attrs: ['https://other.example/zoom.jpg'],
    base: BASE,
  };
  assert.deepEqual(fullSizeCandidates({ ...hints, allowedHosts: new Set(['cdn.example']) }), ['https://cdn.example/p/a-900.jpg']);
  assert.deepEqual(fullSizeCandidates({ ...hints, allowedHosts: ['CDN.example', 'other.example'] }),
    ['https://other.example/zoom.jpg', 'https://cdn.example/p/a-900.jpg']);
  assert.deepEqual(fullSizeCandidates({ ...hints, allowedHosts: new Set() }), []);
});

test('a rewritten thumbnail stays on its own host, so it passes when that host is allowed', () => {
  const src = 'https://i.ebayimg.com/images/g/AbC/s-l300.jpg';
  assert.equal(fullSizeCandidates({ src, naturalWidth: 234, base: BASE, allowedHosts: new Set(['i.ebayimg.com']) })[0], 'https://i.ebayimg.com/images/g/AbC/s-l1600.jpg');
  assert.deepEqual(fullSizeCandidates({ src, naturalWidth: 234, base: BASE, allowedHosts: new Set(['cdn.example']) }), []);
});
