import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { isRelatedHeading, isSealedListing } from '../tools/extension-wasm/lib/page-focus.js';

// content.js is a classic script injected into pages, so it cannot be imported. Run it against a bare
// stub page and use the pure helpers it exposes for tests.
function loadPure() {
  const source = fs.readFileSync(new URL('../tools/extension-wasm/content.js', import.meta.url), 'utf8');
  const window = { addEventListener() {}, innerWidth: 1100, innerHeight: 1200 };
  const document = { getElementById: () => null, documentElement: {}, querySelectorAll: () => [] };
  const chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } };
  vm.runInNewContext(source, { window, document, chrome, MutationObserver: class {}, getComputedStyle: () => ({}) });
  return window.__cardScanner.pure;
}

const pure = loadPure();
const clip = (box, chain) => ({ ...pure.clipBox(box, chain) });

test('heading text keeps its letters: only whitespace is collapsed', () => {
  assert.equal(pure.tidyText('  Customers   also\n viewed '), 'Customers also viewed');
  for (const text of ['Sponsored', 'Other items', 'Customers also viewed', 'Other sellers', 'Inspired by your search']) {
    assert.equal(isRelatedHeading(pure.tidyText(`  ${text}\n`)), true, text);
  }
});

const slot = (left, top, right, bottom, extra = {}) => ({ position: 'static', clipX: true, clipY: true, root: false, rect: { left, top, right, bottom }, ...extra });
const img = (position = 'static') => ({ position });

test('an overflow-hidden gallery clips a slide that sits outside it', () => {
  const clipped = clip({ x1: 700, y1: 400, x2: 1200, y2: 900 }, [img(), slot(100, 400, 660, 960)]);
  assert.ok(clipped.x2 - clipped.x1 <= 0);
});

test('body and html never clip', () => {
  const whole = clip({ x1: 100, y1: 100, x2: 600, y2: 600 }, [img(), slot(0, 0, 300, 300, { root: true })]);
  assert.deepEqual(whole, { x1: 100, y1: 100, x2: 600, y2: 600 });
});

test('a position:fixed image is not clipped by ancestors', () => {
  const kept = clip({ x1: 100, y1: 100, x2: 600, y2: 600 }, [img('fixed'), slot(0, 0, 300, 300)]);
  assert.deepEqual(kept, { x1: 100, y1: 100, x2: 600, y2: 600 });
});

test('clipping stops at a fixed ancestor such as a lightbox', () => {
  const clipped = clip({ x1: 100, y1: 100, x2: 900, y2: 900 }, [
    img(),
    slot(200, 200, 700, 700, { position: 'fixed' }),
    slot(0, 0, 150, 150),
  ]);
  assert.deepEqual(clipped, { x1: 200, y1: 200, x2: 700, y2: 700 });
});

test('an absolutely positioned image ignores clipping ancestors between it and its containing block', () => {
  const kept = clip({ x1: 100, y1: 100, x2: 600, y2: 600 }, [
    img('absolute'),
    slot(0, 0, 300, 300),
    slot(0, 0, 1000, 1000, { position: 'relative' }),
  ]);
  assert.deepEqual(kept, { x1: 100, y1: 100, x2: 600, y2: 600 });
  const narrowed = clip({ x1: 100, y1: 100, x2: 600, y2: 600 }, [
    img('absolute'),
    slot(0, 0, 300, 300),
    slot(0, 0, 400, 400, { position: 'relative' }),
  ]);
  assert.deepEqual(narrowed, { x1: 100, y1: 100, x2: 400, y2: 400 });
});

test('only the first twelve ancestors are examined', () => {
  const chain = [img()];
  for (let i = 0; i < 20; i++) chain.push(slot(0, 0, 10000, 10000, { clipX: false, clipY: false }));
  chain.push(slot(0, 0, 50, 50));
  assert.deepEqual(clip({ x1: 0, y1: 0, x2: 500, y2: 500 }, chain), { x1: 0, y1: 0, x2: 500, y2: 500 });
});

test('sealed labels come from alt and aria text and need a sealed context word', () => {
  for (const label of ['Pokemon Elite Trainer Box', 'booster box photo', 'Ultra Premium Collection']) {
    assert.equal(pure.isSealedLabel(label), true, label);
  }
  for (const label of ['Umbreon tin foil holo', 'Binder page of cards', 'Playmat photo', 'Charizard bundle lot', 'Case of six cards']) {
    assert.equal(pure.isSealedLabel(label), false, label);
  }
});

test('the card-sold-with-a-pack wording rule is shared with the page-level verdict', () => {
  assert.equal(isSealedListing({ sealedLabel: true, titles: ['Charizard ex Booster Pack Fresh Pull'] }), false);
});


test('an element chain lists its own id then its ancestors, nearest first, with stable ids', () => {
  const page = { parentElement: null };
  const section = { parentElement: page };
  const img = { parentElement: section };
  const other = { parentElement: section };
  const chain = [...pure.chainOf(img)];
  assert.equal(chain.length, 3);
  assert.equal(chain[0], pure.idOf(img));
  assert.equal(chain[1], pure.idOf(section));
  assert.deepEqual([...pure.chainOf(other)].slice(1), chain.slice(1));
  assert.notEqual(pure.idOf(img), pure.idOf(other));
});

test('sourceHints gathers srcset, zoom-like data attributes and an enclosing link', () => {
  const attributes = [
    { name: 'src', value: 'https://cdn.example/t.jpg' },
    { name: 'data-zoom-src', value: 'https://cdn.example/z.jpg' },
    { name: 'data-large', value: 'https://cdn.example/l.jpg' },
    { name: 'data-index', value: '3' },
    { name: 'class', value: 'large' },
  ];
  const img = {
    attributes,
    srcset: 'https://cdn.example/a.jpg 900w',
    parentElement: { tagName: 'PICTURE', querySelectorAll: () => [{ srcset: 'https://cdn.example/b.webp 1200w' }] },
    closest: (selector) => (selector === 'a[href]' ? { href: 'https://cdn.example/full.jpg' } : null),
  };
  const hints = pure.sourceHints(img);
  assert.equal(hints.srcset, 'https://cdn.example/a.jpg 900w, https://cdn.example/b.webp 1200w');
  assert.deepEqual([...hints.attrs], ['https://cdn.example/z.jpg', 'https://cdn.example/l.jpg']);
  assert.equal(hints.link, 'https://cdn.example/full.jpg');
  const empty = pure.sourceHints({ attributes: [], closest: () => null });
  assert.deepEqual([empty.srcset, [...empty.attrs], empty.link], ['', [], '']);
});

// A page stub rich enough for the scan itself: text nodes come from an element's `texts`.
function loadPage({ images = [], sources = [], headings = [], performance, computed = () => ({}) } = {}) {
  const source = fs.readFileSync(new URL('../tools/extension-wasm/content.js', import.meta.url), 'utf8');
  const window = { addEventListener() {}, innerWidth: 1100, innerHeight: 1200 };
  const document = {
    baseURI: 'https://shop.example/item/1',
    getElementById: () => null,
    documentElement: {},
    querySelectorAll: (selector) => {
      if (selector === 'img') return images;
      if (selector === 'picture source[srcset]') return sources;
      if (selector.startsWith('h1,h2')) return headings;
      return [];
    },
    createTreeWalker: (root) => {
      const texts = root?.texts || [];
      let at = 0;
      return { currentNode: null, nextNode: () => (at < texts.length ? { nodeValue: texts[at++], nodeType: 3 } : null) };
    },
  };
  const chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } };
  vm.runInNewContext(source, { window, document, chrome, URL, NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 }, performance, MutationObserver: class {}, getComputedStyle: computed });
  return window.__cardScanner;
}

test('the carousel and heading caches are rebuilt at the start of every scan', () => {
  const style = { overflowX: 'auto' };
  const strip = { parentElement: null, scrollWidth: 900, clientWidth: 300 };
  const slide = { parentElement: strip };
  const heading = { matches: () => true, querySelector: () => null, childElementCount: 0, texts: ['Similar items'], previousElementSibling: null };
  const item = { previousElementSibling: heading };
  const scanner = loadPage({ computed: () => style });
  assert.equal(scanner.pure.scrollsHorizontally(slide), true);
  assert.equal(scanner.pure.headingBefore(item), 'Similar items');

  style.overflowX = 'visible';
  heading.texts = ['Other items'];
  assert.equal(scanner.pure.scrollsHorizontally(slide), true, 'cached within one scan');
  assert.equal(scanner.pure.headingBefore(item), 'Similar items', 'cached within one scan');

  scanner.find();
  assert.equal(scanner.pure.scrollsHorizontally(slide), false);
  assert.equal(scanner.pure.headingBefore(item), 'Other items');
});

const fakeHeading = (texts, extra = {}) => ({
  tagName: 'H2', childElementCount: 0, parentElement: null, texts,
  getAttribute: () => null,
  querySelector: () => null,
  get textContent() { throw new Error('textContent must not be read'); },
  ...extra,
});

test('heading text is read from a bounded prefix, never the whole subtree', () => {
  const visited = [];
  const huge = fakeHeading(new Proxy([], {
    get(target, key) {
      if (key === 'length') return 5000;
      if (typeof key === 'string' && /^\d+$/.test(key)) { visited.push(Number(key)); return 'word '; }
      return target[key];
    },
  }));
  const small = fakeHeading(['Similar ', 'items']);
  const crowded = fakeHeading(['Looks fine'], { childElementCount: 50 });
  const scanner = loadPage({ headings: [huge, crowded, small] });
  const found = scanner.pure.collectHeadings();
  assert.deepEqual([...found].map((h) => h.text), ['Similar items']);
  assert.ok(visited.length <= 60, `walked ${visited.length} text nodes`);
  assert.equal(scanner.pure.boundedText(crowded), '', 'an element with many children is skipped outright');
  assert.ok(scanner.pure.boundedText(huge).length <= 200);
});

test('a labelled container keeps its aria-label without touching its text', () => {
  const region = fakeHeading(['x'.repeat(5000)], { tagName: 'SECTION', getAttribute: (name) => (name === 'aria-label' ? 'Similar items' : null) });
  const found = loadPage({ headings: [region] }).pure.collectHeadings();
  assert.deepEqual([...found].map((h) => h.text), ['Similar items']);
});

test('image hosts come from the page images, their srcsets and the image and css resources it loaded', () => {
  const images = [
    { currentSrc: 'https://i.cdn.example/a-300.jpg', src: 'https://lazy.example/a.jpg', srcset: 'https://i.cdn.example/a-900.jpg 900w, https://big.cdn.example/a,w_1200/x.jpg 1200w' },
    { currentSrc: '', src: 'data:image/gif;base64,AAAA', srcset: '' },
    { currentSrc: '/local/b.jpg', src: '', srcset: '' },
  ];
  const sources = [{ srcset: 'https://pic.example/c.webp 800w' }];
  const entries = [
    { initiatorType: 'img', name: 'https://tracker.example/pixel.gif' },
    { initiatorType: 'css', name: 'https://fonts.example/bg.jpg' },
    { initiatorType: 'script', name: 'https://scripts.example/app.js' },
    { initiatorType: 'fetch', name: 'https://api.example/data.json' },
  ];
  const hosts = loadPage({ images, sources, performance: { getEntriesByType: () => entries } }).pure.collectImageHosts();
  assert.deepEqual([...hosts].sort(), ['big.cdn.example', 'fonts.example', 'i.cdn.example', 'lazy.example', 'pic.example', 'shop.example', 'tracker.example']);
});

test('image hosts work without the performance API and stop at a bound', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ currentSrc: `https://h${i}.example/a.jpg`, src: '', srcset: '' }));
  const hosts = loadPage({ images: many }).pure.collectImageHosts();
  assert.equal(hosts.length, 200);
  assert.deepEqual([...loadPage({}).pure.collectImageHosts()], []);
});

test('a card label shows only its name and one price', () => {
  const id = { name: 'Charmeleon', set: 'Base Set', number: '24' };
  const label = (card) => ({ ...pure.labelText(card) });
  assert.deepEqual(label({ identity: id, display: { price: 4.5, printing: 'Normal', condition: 'NM', footer: 'TCGPlayer' } }), { name: 'Charmeleon', price: '$4.50' });
  assert.deepEqual(label({ identity: id, display: { price: null, printingNote: 'set not sure · $0.71–$8.63' } }), { name: 'Charmeleon', price: '$0.71–$8.63' });
  const grid = { variants: { normal: { market: 1.25 }, holofoil: { market: 38.99 } } };
  assert.deepEqual(label({ identity: id, price_grid: grid }), { name: 'Charmeleon', price: '$1.25–$38.99' });
  assert.deepEqual(label({ identity: id, market_price: 2 }), { name: 'Charmeleon', price: '$2.00' });
  assert.equal(label({ identity: id }).price, '—');
  assert.equal(label({ identity: null, abstain: true }).name, 'Not recognised');
});

test('hovering picks the smallest card frame under the pointer', () => {
  const frame = (x, y, w, h) => ({ rect: { x, y, w, h } });
  const targets = [frame(0, 0, 600, 400), frame(10, 10, 100, 140), frame(200, 10, 100, 140)];
  assert.equal(pure.hoveredTarget(targets, null, null), null);
  assert.equal(pure.hoveredTarget(targets, null, { x: 50, y: 50 }), 1);
  assert.equal(pure.hoveredTarget(targets, null, { x: 250, y: 50 }), 2);
  assert.equal(pure.hoveredTarget(targets, null, { x: 400, y: 300 }), 0);
  assert.equal(pure.hoveredTarget(targets, null, { x: 900, y: 900 }), null);
});

test('an open label stays open while the pointer is on it, even past a small card', () => {
  const targets = [{ rect: { x: 10, y: 10, w: 60, h: 90 } }];
  const hover = { target: 0, rect: { x: 14, y: 14, w: 200, h: 48 } };
  assert.equal(pure.hoveredTarget(targets, hover, { x: 180, y: 40 }), 0);
  assert.equal(pure.hoveredTarget(targets, hover, { x: 400, y: 40 }), null);
  assert.equal(pure.hoveredTarget([], hover, { x: 180, y: 40 }), null);
});

test('narrow boxes get a compact label and no label is wider than its box', () => {
  assert.equal(pure.badgeLayout(100).compact, true);
  assert.equal(pure.badgeLayout(139).compact, true);
  assert.equal(pure.badgeLayout(140).compact, false);
  for (const w of [60, 100, 140, 300]) assert.equal(pure.badgeLayout(w).maxWidth, w);
});

test('fitText ellipsizes to the width and leaves short text alone', () => {
  const measure = (t) => t.length * 10;
  assert.equal(pure.fitText('abc', 30, measure), 'abc');
  assert.equal(pure.fitText('abcdefgh', 50, measure), 'abcd…');
  assert.ok(measure(pure.fitText('abcdefgh', 50, measure)) <= 50);
  assert.equal(pure.fitText('abcdefgh', 5, measure), '');
});

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

test('a box stored relative to its element follows the element when it moves or resizes', () => {
  const captured = rect(100, 200, 300, 480);
  const rel = pure.boxToRel([120, 220, 220, 360], captured);
  assert.deepEqual([...pure.relToBox(rel, captured)], [120, 220, 220, 360]);
  assert.deepEqual([...pure.relToBox(rel, rect(100, -400, 300, -120))], [120, -380, 220, -240]);
  assert.deepEqual([...pure.relToBox(rel, rect(0, 0, 400, 560))], [40, 40, 240, 320]);
});

test('an element with no size cannot anchor a box', () => {
  assert.equal(pure.boxToRel([0, 0, 10, 10], rect(5, 5, 5, 50)), null);
  assert.equal(pure.boxToRel([0, 0, 10, 10], rect(5, 5, 50, 5)), null);
});

test('document coordinates survive scrolling', () => {
  const doc = pure.boxToDoc([50, 80, 150, 220], { x: 0, y: 600 });
  assert.deepEqual([...doc], [50, 680, 150, 820]);
  assert.deepEqual([...pure.docToBox(doc, { x: 0, y: 1000 })], [50, -320, 150, -180]);
  assert.deepEqual([...pure.docToBox(doc, { x: 20, y: 600 })], [30, 80, 130, 220]);
});

test('the anchor is the smallest element that holds the box', () => {
  const anchors = [{ rect: rect(0, 0, 800, 800) }, { rect: rect(100, 100, 400, 500) }, { rect: rect(450, 100, 750, 500) }];
  assert.equal(pure.pickAnchor([120, 120, 380, 480], anchors), 1);
  assert.equal(pure.pickAnchor([470, 120, 730, 480], anchors), 2);
  assert.equal(pure.pickAnchor([10, 600, 90, 700], anchors), 0);
});

test('a box that mostly lies outside every element has no anchor', () => {
  const anchors = [{ rect: rect(100, 100, 200, 200) }];
  assert.equal(pure.pickAnchor([150, 100, 350, 200], anchors), -1);
  assert.equal(pure.pickAnchor([500, 500, 600, 600], anchors), -1);
  assert.equal(pure.pickAnchor([0, 0, 10, 10], []), -1);
});

test('only boxes that reach the viewport are drawn', () => {
  assert.equal(pure.boxInView([10, 10, 100, 100], 1100, 800), true);
  assert.equal(pure.boxInView([10, -300, 100, -1], 1100, 800), false);
  assert.equal(pure.boxInView([10, 800, 100, 900], 1100, 800), false);
  assert.equal(pure.boxInView([-90, 10, -1, 100], 1100, 800), false);
  assert.equal(pure.boxInView([-50, 700, 50, 900], 1100, 800), true);
});

function loadWithMessages() {
  const source = fs.readFileSync(new URL('../tools/extension-wasm/content.js', import.meta.url), 'utf8');
  const frames = [];
  const window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1100, innerHeight: 800, scrollX: 0, scrollY: 0, requestAnimationFrame: (fn) => frames.push(fn) && frames.length, cancelAnimationFrame() {} };
  const canvas = { style: {}, remove() {}, getContext: () => ({ clearRect() {}, setTransform() {} }) };
  const document = { getElementById: () => null, createElement: () => canvas, documentElement: { appendChild() {} }, querySelectorAll: () => [] };
  let listener;
  const chrome = { runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: () => Promise.resolve() } };
  vm.runInNewContext(source, { window, document, chrome, MutationObserver: class {}, getComputedStyle: () => ({}) });
  const send = (msg) => { const replies = []; listener(msg, null, (r) => replies.push(r)); return replies; };
  const nextFrame = () => frames.shift()();
  return { canvas, send, nextFrame, frames };
}

test('hiding the overlay answers only after two frames, so a capture cannot include the badges', () => {
  const page = loadWithMessages();
  page.send({ action: 'showOverlay', cards: [], srcWidth: 1100, srcHeight: 800 });
  const replies = page.send({ action: 'hideOverlay' });
  assert.equal(page.canvas.style.visibility, 'hidden');
  assert.equal(replies.length, 0);
  page.nextFrame();
  assert.equal(replies.length, 0);
  page.nextFrame();
  assert.equal(replies.length, 1);
});

test('a new overlay shows again after a hide, and hiding with no overlay answers at once', () => {
  const page = loadWithMessages();
  assert.equal(page.send({ action: 'hideOverlay' }).length, 1);
  page.send({ action: 'showOverlay', cards: [], srcWidth: 1100, srcHeight: 800 });
  page.send({ action: 'hideOverlay' });
  page.send({ action: 'showOverlay', cards: [], srcWidth: 1100, srcHeight: 800 });
  assert.equal(page.canvas.style.visibility, 'visible');
});

test('restoreOverlay brings back a hidden overlay', () => {
  const page = loadWithMessages();
  page.send({ action: 'showOverlay', cards: [], srcWidth: 1100, srcHeight: 800 });
  page.send({ action: 'hideOverlay' });
  page.send({ action: 'restoreOverlay' });
  assert.equal(page.canvas.style.visibility, 'visible');
});

test('every card tag says its state: identified, printing to pick, your pick, not recognised', () => {
  const id = { name: 'Charizard', number: '4' };
  const tag = (card) => JSON.parse(JSON.stringify(pure.tagText(card)));
  assert.deepEqual(tag({ identity: id, display: { state: 'identified', price: 954.65 } }).lines, ['Charizard #4', '$954.65']);
  assert.deepEqual(tag({ identity: id, display: { state: 'printing', printingNote: 'set not sure · $120.00–$950.00' } }).lines,
    ['Charizard #4', '$120.00–$950.00 · pick printing']);
  assert.deepEqual(tag({ identity: id, display: { state: 'ask' } }).lines, ['Charizard?', 'Pick in scanner']);
  assert.equal(tag({ identity: null, abstain: true }).state, 'none');
  // Straight from the background, before the popup has drawn: the card's own fields decide.
  assert.equal(pure.cardState({ identity: id, unsure: true }), 'ask');
  assert.equal(pure.cardState({ identity: id, confidence: 0.9 }), 'identified');
});

test('tags scale with the card and never sit on another tag', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(pure.tagLayout(60, 85))), { px: 13, lines: 1, maxWidth: 56 });
  assert.equal(pure.tagLayout(200, 280).px, 16);
  assert.equal(pure.tagLayout(200, 280).lines, 2);
  const view = { w: 1000, h: 800 };
  const first = pure.placeTag([100, 100, 200, 240], 90, 30, [], view);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { x: 102, y: 102, w: 90, h: 30 });
  // The same spot is taken: the next free one is inside the bottom of the card.
  const second = pure.placeTag([100, 100, 200, 240], 90, 30, [first], view);
  assert.equal(second.y, 240 - 30 - 2);
  const boxed = [first, second, { x: 102, y: 68, w: 90, h: 30 }, { x: 102, y: 242, w: 90, h: 30 }];
  assert.equal(pure.placeTag([100, 100, 200, 240], 90, 30, boxed, view), null);
});
