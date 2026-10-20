import assert from 'node:assert/strict';
import test from 'node:test';
import { galleryPhotos, mergeAcrossPhotos, MAX_GALLERY_PHOTOS } from '../tools/extension-wasm/lib/gallery.js';

// A Marketplace-like viewer: main photo and a strip of thumbnails share the viewer element; "Today's picks"
// tiles sit in the side column and link to other listings.
const chainUp = (...ids) => [...ids, 'viewer', 'wrap', 'body', 'html'];
const main = { src: 'https://scontent.example.net/v/t1/photo-1.jpg?oh=1', rect: { x: 0, y: 56, w: 900, h: 700 },
  ctx: { chain: chainUp('img-main', 'slide', 'stage') } };
const thumb = (n, extra = {}) => ({ src: `https://scontent.example.net/v/t1/photo-${n}.jpg?oh=${n}`, rect: { x: 100 + n * 64, y: 770, w: 56, h: 56 },
  ctx: { chain: chainUp(`img-${n}`, `tb-${n}`, `li-${n}`, 'strip') }, sources: { link: '' }, thumb: true, ...extra });
const pageUrl = 'https://www.facebook.com/marketplace/item/123/';

test('the gallery is the listing\'s other photos: the strip, not related listings or the main photo again', () => {
  const again = thumb(1);
  const related = { src: 'https://scontent.example.net/v/t1/other.jpg', rect: { x: 950, y: 600, w: 170, h: 110 },
    ctx: { chain: ['img-r', 'a-r', 'rel', 'side', 'wrap', 'body', 'html'] }, sources: { link: 'https://www.facebook.com/marketplace/item/999/' } };
  const otherHost = thumb(5, { src: 'https://ads.example.org/banner-5.jpg' });
  const picked = galleryPhotos({ main, candidates: [again, thumb(2), thumb(3), related, otherHost, thumb(4)], pageUrl });
  assert.deepEqual(picked.map((p) => p.src.match(/photo-(\d)/)[1]), ['2', '3', '4']);
});

test('a picture far from the main photo in the page, or in a "similar items" section, is not part of the gallery', () => {
  const far = { ...thumb(2), ctx: { chain: ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10', 'x11', 'x12', 'x13'] } };
  const similar = thumb(3, { ctx: { chain: chainUp('img-3', 'strip'), headings: ['Similar items'] } });
  assert.deepEqual(galleryPhotos({ main, candidates: [far, similar], pageUrl }), []);
});

test('the gallery is capped', () => {
  const many = Array.from({ length: 20 }, (_, i) => thumb(i + 2));
  assert.equal(galleryPhotos({ main, candidates: many, pageUrl }).length, MAX_GALLERY_PHOTOS);
  assert.deepEqual(galleryPhotos({ main: null, candidates: many, pageUrl }), []);
});

const card = (id, extra = {}) => ({ identity: { id, name: id }, confidence: 0.7, abstain: false, ...extra });
const vec = (...v) => Float32Array.from(v);

test('the same card in two photos is kept once, as its better read, and remembers both photos', () => {
  const items = [
    { photo: 1, height: 110, embedding: vec(1, 0, 0), card: card('base1-4', { unsure: true, confidence: 0.49 }) },
    { photo: 1, height: 110, embedding: vec(0, 1, 0), card: card('base1-2', { unsure: true }) },
    { photo: 2, height: 260, embedding: vec(0.98, 0.1, 0), card: card('base1-4') },
  ];
  const { drop, photos } = mergeAcrossPhotos(items);
  assert.deepEqual([...drop], [0]);
  assert.deepEqual(photos.get(2), [1, 2]);
});

test('two copies of one card in the same photo stay two cards', () => {
  const items = [
    { photo: 1, height: 200, embedding: vec(1, 0), card: card('base1-58') },
    { photo: 1, height: 200, embedding: vec(1, 0), card: card('base1-58') },
    { photo: 2, height: 280, embedding: vec(1, 0.01), card: card('base1-58') },
  ];
  const { drop } = mergeAcrossPhotos(items);
  assert.equal(drop.size, 1);
});

test('different cards in different photos are all kept; sure reads of one printing are the same card', () => {
  const apart = mergeAcrossPhotos([
    { photo: 1, height: 200, embedding: vec(1, 0), card: card('a') },
    { photo: 2, height: 200, embedding: vec(0, 1), card: card('b') },
  ]);
  assert.equal(apart.drop.size, 0);
  const named = mergeAcrossPhotos([
    { photo: 1, height: 150, embedding: vec(1, 0), card: card('a', { confidence: 0.6 }) },
    { photo: 3, height: 280, embedding: vec(0.6, 0.8), card: card('a', { confidence: 0.79 }) },
  ]);
  assert.deepEqual([...named.drop], [0]);
});

test('two cards that are each other\'s closest match in the other photo are one card', () => {
  const items = [
    { photo: 1, height: 120, embedding: vec(1, 0, 0), card: card('a', { unsure: true }) },
    { photo: 1, height: 120, embedding: vec(0, 1, 0), card: card('b', { unsure: true }) },
    { photo: 2, height: 260, embedding: vec(0.85, 0.2, 0.49), card: card('a') },   // 0.85 to the first, its closest
  ];
  assert.deepEqual([...mergeAcrossPhotos(items).drop], [0]);
  // Without the mutual pick it takes the plain threshold.
  assert.equal(mergeAcrossPhotos(items, { mutualSimilarity: 0.95 }).drop.size, 0);
});

test('a guess only one gallery photo shows is dropped; a sure read there, or any read of the main photo, stays', () => {
  const items = [
    { photo: 1, height: 120, embedding: vec(1, 0, 0), card: card('a', { unsure: true }) },
    { photo: 2, height: 260, embedding: vec(0, 1, 0), card: card('b', { unsure: true }) },
    { photo: 2, height: 260, embedding: vec(0, 0, 1), card: card('c') },
  ];
  assert.deepEqual([...mergeAcrossPhotos(items).drop], [1]);
  assert.equal(mergeAcrossPhotos(items, { dropLoneGuesses: false }).drop.size, 0);
});
