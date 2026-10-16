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
