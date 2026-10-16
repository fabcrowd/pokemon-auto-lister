import assert from 'node:assert/strict';
import test from 'node:test';
import {
  choosePageFocus,
  imageKey,
  isRelatedHeading,
  isSealedListing,
  sameImageUrl,
  shouldSuppressCards,
} from '../tools/extension-wasm/lib/page-focus.js';

const VIEWPORT = { w: 1100, h: 1200 };

function entry(x, y, w, h, extra = {}) {
  const vx = Math.max(0, x);
  const vy = Math.max(0, y);
  const vw = Math.min(VIEWPORT.w, x + w) - vx;
  const vh = Math.min(VIEWPORT.h, y + h) - vy;
  const hidden = extra.hidden === true;
  return {
    rect: { x, y, w, h, vx, vy, vw: hidden ? 0 : vw, vh: hidden ? 0 : vh, pvw: vw, pvh: vh },
    src: extra.src || `https://img.example/${x}-${y}-${w}x${h}.jpg`,
    ctx: { order: extra.order ?? 0, ogMatch: false, landmarks: [], headings: [], labels: [], ...(extra.ctx || {}) },
  };
}

test('related-item headings are recognised in several wordings', () => {
  for (const text of ['Similar items', 'People who viewed this item also viewed', 'YOU MAY ALSO LIKE',
    'Similar Items Sponsored', 'Recommended for you', 'Customers also bought', 'Recently viewed']) {
    assert.equal(isRelatedHeading(text), true, text);
  }
  for (const text of ['Item Description', 'Pokemon TCG Umbreon Team Plasma Card 64/116', 'Shipping', '', null, undefined]) {
    assert.equal(isRelatedHeading(text), false, String(text));
  }
});

test('same image: only known size markers are ignored', () => {
  const same = [
    ['https://i.ebayimg.com/images/g/AbC~/s-l1600.jpg', 'https://i.ebayimg.com/images/g/AbC~/s-l500.webp?w=500'],
    ['https://cdn.example/p/photo_300x300.jpg', 'https://cdn.example/p/photo_800x800.jpg'],
    ['https://cdn.example/p/photo.jpg?w=300&q=80', 'https://cdn.example/p/photo.jpg?w=900'],
    ['https://cdn.example/w_300,h_400/p/photo.jpg', 'https://cdn.example/w_900,h_1200/p/photo.jpg'],
    ['https://cdn.example/300x400/p/photo.jpg', 'https://cdn.example/900x1200/p/photo.jpg'],
    ['https://cdn.example/thumb/p/photo.jpg', 'https://cdn.example/large/p/photo.jpg'],
  ];
  for (const [a, b] of same) assert.equal(sameImageUrl(a, b), true, a);
});

test('different pictures with numbered names or ids are not the same image', () => {
  const different = [
    ['https://cdn.example/a/img_1.jpg', 'https://cdn.example/a/img_2.jpg'],
    ['https://cdn.example/a/IMG_1234.jpg', 'https://cdn.example/a/IMG_1235.jpg'],
    ['https://cdn.example/image?id=1', 'https://cdn.example/image?id=2'],
    ['https://cdn.example/a/photo.jpg', 'https://cdn.example/b/photo.jpg'],
    ['', 'https://cdn.example/a.jpg'],
    [null, null],
  ];
  for (const [a, b] of different) assert.equal(sameImageUrl(a, b), false, String(a));
});

test('a dominant listing photo is the only thing scanned; thumbnails and related carousels are left alone', () => {
  const hero = entry(117, 453, 475, 475, { order: 5 });
  const thumbs = [0, 1, 2].map((i) => entry(30, 453 + i * 78, 70, 70, { order: 2 + i }));
  const similar = [0, 1, 2, 3].map((i) => entry(40 + i * 250, 700, 230, 320, {
    order: 20 + i,
    ctx: { headings: ['Similar items'] },
  }));
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [hero, ...similar], cards: [...thumbs, ...similar] });
  assert.equal(focus.kind, 'listing');
  assert.equal(focus.main, hero);
  assert.deepEqual(focus.photos, [hero]);
  assert.deepEqual(focus.cards, []);
});

test('related carousels are ignored even when they are larger than the real photo', () => {
  const hero = entry(48, 395, 215, 275, { order: 3 });
  const similar = [0, 1, 2, 3].map((i) => entry(32 + i * 245, 877, 227, 320, {
    order: 30 + i,
    ctx: { headings: ['People who viewed this item also viewed'] },
  }));
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [hero, ...similar], cards: [] });
  assert.equal(focus.kind, 'listing');
  assert.equal(focus.main, hero);
});

test('a card-shaped hero listed as both photo and card keeps both entries so the single-card path still works', () => {
  const photo = entry(59, 302, 570, 795, { order: 4, src: 'https://img.example/hero.jpg' });
  const card = { ...photo, rect: { ...photo.rect }, ctx: { ...photo.ctx } };
  const others = [0, 1, 2, 3].map((i) => entry(700, 300 + i * 120, 80, 112, { order: 10 + i }));
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [photo], cards: [card, ...others] });
  assert.equal(focus.kind, 'listing');
  assert.deepEqual(focus.photos, [photo]);
  assert.deepEqual(focus.cards, [card]);
});

test('the og:image photo is the listing photo when related items are the only other images', () => {
  const a = entry(100, 300, 400, 500, { order: 1, src: 'https://cdn.example/p/AAA/s-l500.jpg' });
  const similar = [0, 1, 2].map((i) => entry(40 + i * 250, 900, 230, 300, { order: 10 + i, ctx: { headings: ['Similar items'] } }));
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [a, ...similar], cards: [], ogImages: ['https://cdn.example/p/AAA/s-l1600.jpg'] });
  assert.equal(focus.kind, 'listing');
  assert.equal(focus.main, a);
  assert.equal(focus.reason, 'og-image');
});

test('an og:image match does not make one of several comparable images the listing photo', () => {
  const a = entry(100, 300, 400, 500, { order: 1, src: 'https://cdn.example/p/AAA/s-l500.jpg' });
  const b = entry(560, 300, 400, 500, { order: 2, src: 'https://cdn.example/p/BBB/s-l960.webp' });
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [a, b], cards: [], ogImages: ['https://cdn.example/p/BBB/s-l1600.jpg'] });
  assert.notEqual(focus.kind, 'listing');
  assert.equal(focus.main, null);
});

test('a shop page whose og:image is its banner stays a grid of its products', () => {
  const banner = entry(40, 120, 900, 300, { order: 1, src: 'https://cdn.example/shop/banner.jpg' });
  const tiles = [0, 1, 2, 3].map((i) => entry(40 + i * 260, 480, 240, 330, { order: 5 + i }));
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [], cards: tiles, ogImages: ['https://cdn.example/shop/banner.jpg'] });
  assert.notEqual(focus.kind, 'listing');
  assert.deepEqual(focus.cards, tiles);
  const withBanner = choosePageFocus({ viewport: VIEWPORT, photos: [banner], cards: tiles, ogImages: ['https://cdn.example/shop/banner.jpg'] });
  assert.notEqual(withBanner.kind, 'listing');
});

test('a featured card above a grid of cards stays a grid', () => {
  const featured = entry(40, 150, 420, 580, { order: 1 });
  const tiles = [0, 1, 2, 3].map((i) => entry(520 + (i % 2) * 280, 150 + Math.floor(i / 2) * 330, 250, 300, { order: 5 + i }));
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [featured], cards: tiles });
  assert.notEqual(focus.kind, 'listing');
  assert.equal(focus.photos.length, 1);
  assert.equal(focus.cards.length, 4);
});

test('dominance uses the whole image, so a hero that runs below the fold still wins', () => {
  const hero = entry(48, 800, 520, 900, { order: 1 });
  const rival = entry(620, 800, 300, 400, { order: 2 });
  assert.equal(choosePageFocus({ viewport: VIEWPORT, photos: [hero, rival], cards: [] }).main, hero);
});

test('hidden gallery slides are not rivals, but are kept as fallback photos', () => {
  const hero = entry(136, 433, 524, 524, { order: 3, src: 'https://img.example/g/AAA/s-l1600.jpg' });
  const slide = entry(700, 433, 524, 524, { order: 4, hidden: true, src: 'https://img.example/g/BBB/s-l1600.jpg' });
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [hero, slide], cards: [], ogImages: ['https://img.example/g/AAA/s-l960.jpg'] });
  assert.equal(focus.kind, 'listing');
  assert.equal(focus.main, hero);
  assert.deepEqual(focus.fallback, [slide]);
});

test('a grid of similar-sized cards has no main photo and everything is scanned', () => {
  const photos = [];
  for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) photos.push(entry(300 + col * 245, 525 + row * 470, 230, 230, { order: row * 3 + col }));
  const cards = [];
  for (let i = 0; i < 24; i++) cards.push(entry(20 + (i % 8) * 130, 100 + Math.floor(i / 8) * 190, 110, 154, { order: i }));
  const search = choosePageFocus({ viewport: VIEWPORT, photos, cards: [] });
  assert.equal(search.kind, 'grid');
  assert.equal(search.main, null);
  assert.deepEqual(search.photos, photos);
  const set = choosePageFocus({ viewport: VIEWPORT, photos: [], cards });
  assert.equal(set.kind, 'grid');
  assert.deepEqual(set.cards, cards);
});

test('two large images with no clear winner are not a listing', () => {
  const a = entry(100, 300, 400, 500, { order: 1 });
  const b = entry(560, 300, 380, 480, { order: 2 });
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [a, b], cards: [] });
  assert.equal(focus.kind, 'unknown');
  assert.equal(focus.main, null);
  assert.deepEqual(focus.photos, [a, b]);
});

test('a wide banner is never the listing photo', () => {
  const banner = entry(0, 100, 1100, 300, { order: 1 });
  const cards = [0, 1, 2, 3, 4].map((i) => entry(20 + i * 200, 500, 150, 210, { order: 10 + i }));
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [banner], cards });
  assert.notEqual(focus.kind, 'listing');
  assert.deepEqual(focus.cards, cards);
});

test('a page with nothing to look at passes through untouched', () => {
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [], cards: [] });
  assert.deepEqual(focus, { kind: 'unknown', main: null, photos: [], cards: [], reason: 'no-candidates' });
});

test('a listing photo with no size signal at all is not forced into a listing', () => {
  const tiny = entry(100, 100, 120, 120, { order: 1 });
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [tiny], cards: [] });
  assert.equal(focus.kind, 'unknown');
});

test('imageKey matches what the background uses to pair photo and card entries', () => {
  assert.equal(imageKey(entry(10.4, 20.6, 100.2, 200.4)), '10,21,100x200');
});

test('a sealed product title with no card number is a sealed listing', () => {
  assert.equal(isSealedListing({ titles: ['Pokemon Mega Evolution Perfect Order Booster Box Sealed'] }), true);
  assert.equal(isSealedListing({ titles: ['Elite Trainer Box Pokemon 151'] }), true);
  assert.equal(isSealedListing({ titles: ['', 'Surging Sparks Booster Bundle'] }), true);
  assert.equal(isSealedListing({ labels: ['Pokemon booster pack art'] }), true);
  assert.equal(isSealedListing({ sealedLabel: true, titles: ['Pokemon Ultra Premium Collection'] }), true);
});

test('words that name a card sold alongside a pack do not make a listing sealed', () => {
  for (const title of ['Charizard ex Booster Pack Fresh Pull', 'Pikachu ETB promo', 'Charizard UPC promo',
    'Mew from Elite Trainer Box pulled', 'Holo blister exclusive Umbreon', 'Collector tin promo Pikachu']) {
    assert.equal(isSealedListing({ titles: [title] }), false, title);
  }
  assert.equal(isSealedListing({ titles: ['Pokemon blister pack 3 booster packs'] }), true);
  assert.equal(isSealedListing({ titles: ['Pokemon case of 6 booster boxes'] }), true);
});

test('sealed is a soft verdict: cards the detector found in the photo are kept', () => {
  assert.equal(shouldSuppressCards({ sealed: true, detectedCards: 0 }), true);
  assert.equal(shouldSuppressCards({ sealed: true, detectedCards: 1 }), false);
  assert.equal(shouldSuppressCards({ sealed: false, detectedCards: 0 }), false);
});

test('single cards, slabs and lots are not sealed even when the title mentions packs', () => {
  assert.equal(isSealedListing({ titles: ['Pokemon TCG Umbreon Team Plasma Card 64/116 Holo Rare MP'] }), false);
  assert.equal(isSealedListing({ titles: ['PSA 10 Charizard from booster box'] }), false);
  assert.equal(isSealedListing({ titles: ['Pokemon Card Lot 100 cards pulled from booster packs'] }), false);
  assert.equal(isSealedListing({ titles: ['Charizard ex 125/197 Obsidian Flames booster fresh'] }), false);
  assert.equal(isSealedListing({ titles: [] }), false);
  assert.equal(isSealedListing({}), false);
  assert.equal(isSealedListing({ sealedLabel: true, titles: ['Umbreon 64/116 Team Plasma holo'] }), false);
});

test('a listing keeps the other gallery photos as a fallback, but never related-item carousels', () => {
  const hero = entry(136, 433, 524, 524, { order: 3 });
  const slide = entry(700, 433, 524, 524, { order: 4, hidden: true });
  const similar = entry(40, 900, 230, 320, { order: 20, ctx: { headings: ['Similar items'] } });
  const thumb = entry(30, 433, 60, 60, { order: 1 });
  const focus = choosePageFocus({ viewport: VIEWPORT, photos: [hero, slide, similar, thumb], cards: [], ogImages: [hero.src] });
  assert.equal(focus.kind, 'listing');
  assert.equal(focus.main, hero);
  assert.deepEqual(focus.fallback, [slide]);
  assert.equal(choosePageFocus({ viewport: VIEWPORT, photos: [], cards: [] }).fallback, undefined);
});
