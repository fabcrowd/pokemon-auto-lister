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
