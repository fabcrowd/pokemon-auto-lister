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
  // A card to choose has no name on its label: the label asks for a pick and never asserts a card.
  assert.equal(label({ identity: null, abstain: true }).name, 'Choose a card');
  assert.equal(label({ identity: id, display: { state: 'choose' } }).name, 'Choose a card');
  assert.equal(label({ cardBack: true, display: { state: 'none' } }).name, 'Not recognised');
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

test('every card tag says its state: identified, printing to pick, choose, card back', () => {
  const id = { name: 'Charizard', number: '4' };
  const tag = (card) => JSON.parse(JSON.stringify(pure.tagText(card)));
  assert.deepEqual(tag({ identity: id, display: { state: 'identified', price: 954.65 } }).lines, ['Charizard #4', '$954.65']);
  assert.deepEqual(tag({ identity: id, display: { state: 'printing', printingNote: 'set not sure · $120.00–$950.00' } }).lines,
    ['Charizard #4', '$120.00–$950.00 · pick printing']);
  // Choose: no name and no price, only the ask.
  assert.deepEqual(tag({ identity: id, display: { state: 'choose' } }).lines, ['Choose', 'Tap to choose']);
  assert.equal(tag({ identity: id, display: { state: 'choose' } }).short, 'Choose');
  assert.equal(tag({ identity: null, abstain: true }).state, 'choose');
  assert.equal(tag({ cardBack: true }).state, 'none');
  assert.deepEqual(tag({ cardBack: true }).lines, ['Not recognised', 'Turn it over']);
  // Straight from the background, before the popup has drawn: the card's own fields decide.
  assert.equal(pure.cardState({ identity: id, unsure: true }), 'choose');
  // The removed guess tier is not a state any more.
  assert.equal(pure.cardState({ identity: id, display: { state: 'guess', guess: { name: 'Charizard' } } }), 'identified');
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

const plain = (value) => JSON.parse(JSON.stringify(value));
const TAG_TOP_BAND_FOR_TEST = 24;
const hitsBand = (rect, other) => rect.x < other[2] && other[0] < rect.x + rect.w && rect.y < other[1] + TAG_TOP_BAND_FOR_TEST && other[1] < rect.y + rect.h;

test('a tag does not land on a neighbouring card when another spot is free', () => {
  const view = { w: 1000, h: 800 };
  const box = [100, 100, 200, 240];
  // The card below starts 4 px under this one and the card above ends 2 px over it, so a spot above or below is on a neighbour.
  const above = [100, 0, 200, 98];
  const below = [100, 244, 200, 400];
  const topTaken = { x: 102, y: 102, w: 90, h: 30 };
  // Inside the top is taken: the inside bottom is free and is on no neighbour.
  assert.equal(pure.placeTag(box, 90, 30, [topTaken], view, [above, below]).y, 208);
  // Without neighbours given the old order is unchanged.
  assert.deepEqual(plain(pure.placeTag(box, 90, 30, [], view)), { x: 102, y: 102, w: 90, h: 30 });
  // A neighbour whose box overlaps this card's top: skip that spot, take the inside bottom.
  const overlapping = [100, 60, 200, 130];
  assert.equal(pure.placeTag(box, 90, 30, [], view, [overlapping]).y, 208);
});

test('the ladder shrinks to the short tag before it settles for a neighbour', () => {
  const view = { w: 1000, h: 800 };
  const box = [100, 100, 200, 240];
  const above = [100, 0, 200, 98];
  const below = [100, 244, 200, 400];
  // Another card's tag sits on the right half of both inside spots, so the full tag (90 wide) fits neither inside spot,
  // and the spots above and below are on neighbours. The short tag (48 wide) fits beside it, inside this card.
  const taken = [{ x: 150, y: 102, w: 60, h: 30 }, { x: 150, y: 208, w: 60, h: 30 }];
  const sizes = [{ w: 90, h: 30 }, { w: 48, h: 22 }];
  const fit = pure.placeTagLadder(box, sizes, taken, view, [above, below]);
  assert.equal(fit.size, 1);
  assert.deepEqual(plain(fit.rect), { x: 102, y: 102, w: 48, h: 22 });
  assert.deepEqual(plain(pure.placeTagLadder(box, sizes, taken, view, [above, below])), plain(fit));
});

test('the ladder gives up on neighbours last, never on another tag, and answers null when nothing is free', () => {
  const view = { w: 1000, h: 800 };
  const box = [100, 100, 200, 240];
  const taken = [{ x: 102, y: 102, w: 90, h: 30 }, { x: 102, y: 208, w: 90, h: 30 }, { x: 102, y: 134, w: 90, h: 72 }];
  const above = [100, 0, 200, 98];
  const below = [100, 244, 200, 400];
  const sizes = [{ w: 90, h: 30 }, { w: 50, h: 22 }];
  // Inside is full of tags; above lies on the lower part of the neighbour but not its top band: the relaxed pass takes it.
  const relaxed = pure.placeTagLadder(box, sizes, taken, view, [above, below]);
  assert.equal(relaxed.size, 0);
  assert.equal(relaxed.rect.y, 68);
  assert.ok(!hitsBand(relaxed.rect, above) && !hitsBand(relaxed.rect, below));
  // Neighbour tags above and below as well: nothing is free, the tag is left to hover.
  const wall = [...taken, { x: 102, y: 66, w: 90, h: 32 }, { x: 102, y: 242, w: 90, h: 32 }];
  assert.equal(pure.placeTagLadder(box, sizes, wall, view, [above, below]), null);
});

test('a crowded grid: no tag covers another tag or the top edge of another card, and every card keeps a tag', () => {
  const view = { w: 520, h: 420 };
  const boxes = [];
  // Four rows of six 78 x 100 cards, 3 px apart, every other card nudged 7 px so neighbours overlap a little.
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 6; c += 1) {
      const nudge = (r + c) % 2 ? 7 : 0;
      const x = 6 + c * 81;
      const y = 8 + r * 103 + nudge;
      boxes.push([x, y, x + 78, y + 100]);
    }
  }
  const sizes = [{ w: 74, h: 30 }, { w: 48, h: 22 }];
  const run = (order) => {
    const taken = [];
    const placed = new Map();
    for (const i of order) {
      const others = boxes.filter((_, j) => j !== i);
      const fit = pure.placeTagLadder(boxes[i], sizes, taken, view, others);
      if (!fit) continue;
      taken.push(fit.rect);
      placed.set(i, plain(fit.rect));
    }
    return placed;
  };
  const order = boxes.map((_, i) => i);
  const placed = run(order);
  assert.equal(placed.size, boxes.length, 'every card keeps its tag');
  for (const [i, rect] of placed) {
    for (const [j, other] of placed) assert.ok(i === j || !(rect.x < other.x + other.w && other.x < rect.x + rect.w && rect.y < other.y + other.h && other.y < rect.y + rect.h), `tags ${i} and ${j} overlap`);
    boxes.forEach((other, j) => assert.ok(i === j || !hitsBand(rect, other), `tag ${i} covers the top edge of card ${j}`));
    assert.ok(rect.x >= 2 && rect.y >= 2 && rect.x + rect.w <= view.w - 2 && rect.y + rect.h <= view.h - 2);
  }
  // Deterministic: the same boxes in the same order give the same spots.
  assert.deepEqual([...run(order)], [...placed]);
});

test('cards whose boxes overlap their neighbours still keep a tag, clear of every other tag', () => {
  const view = { w: 520, h: 420 };
  const boxes = [];
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 6; c += 1) {
      const x = 6 + c * 72;
      const y = 8 + r * 103 + ((r + c) % 2 ? 9 : 0);
      boxes.push([x, y, x + 78, y + 100]);
    }
  }
  const sizes = [{ w: 74, h: 30 }, { w: 48, h: 22 }];
  const taken = [];
  boxes.forEach((box, i) => {
    const fit = pure.placeTagLadder(box, sizes, taken, view, boxes.filter((_, j) => j !== i));
    if (!fit) return;
    assert.ok(!taken.some((other) => other.x < fit.rect.x + fit.rect.w && fit.rect.x < other.x + other.w && other.y < fit.rect.y + fit.rect.h && fit.rect.y < other.y + other.h), `tag ${i} overlaps a tag`);
    taken.push(fit.rect);
  });
  assert.ok(taken.length >= 20, `${taken.length} of ${boxes.length} cards have a tag`);
});

test('tag rows: Choose never reads "Tap to c...", a price is never cut mid-number', () => {
  const m = (t) => t.length * 7; // 7 px per character
  const rows = (card, two, max) => JSON.parse(JSON.stringify(pure.tagRows(pure.tagText(card), two, max, m)));
  const id = { name: 'Charizard', number: '4' };
  const choose = { identity: id, display: { state: 'choose' } };
  assert.deepEqual(rows(choose, true, 100), ['Choose', 'Tap to choose']);
  assert.deepEqual(rows(choose, true, 60), ['Choose']);
  const range = { identity: id, display: { state: 'printing', printingNote: 'set not sure · $1.43–$20.00' } };
  // Small card: name before price; the price shows only when the name cannot, and whole or as "from".
  assert.deepEqual(rows(range, false, 200), ['Charizard $1.43–$20.00']);
  assert.deepEqual(rows(range, false, 70), ['Charizard']);
  assert.deepEqual(rows(range, false, 24), []);
  assert.equal(pure.fitPrice('$1.43–$20.00', 100, m), '$1.43–$20.00');
  assert.equal(pure.fitPrice('$1.43–$20.00', 80, m), 'from $1.43');
  assert.equal(pure.fitPrice('$1.43–$20.00', 50, m), '');
  assert.equal(pure.fitPrice('$9.99', 20, m), '');
  const name = rows({ identity: { name: 'Charizard ex' }, display: { state: 'identified', price: 4.5 } }, false, 56);
  assert.deepEqual(name, ['Chariza…']);
  assert.ok(!name.some((t) => /\$.*…/.test(t)));
  // Two lines: a price line that does not fit is dropped, not cut.
  assert.equal(rows(range, true, 80)[1], 'from $1.43');
  assert.deepEqual(rows(range, true, 50), ['Chariz…']);
});
