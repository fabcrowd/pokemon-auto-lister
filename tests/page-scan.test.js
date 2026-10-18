import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CARDS,
  MAX_SCREENS,
  cardRoom,
  captureWait,
  judgeDuplicate,
  claimSlot,
  coveredByBetterView,
  createScanGate,
  isCaptureQuotaError,
  samePage,
  planScreens,
  screensCapped,
  truncationNote,
  toDocBox,
} from '../tools/extension-wasm/lib/page-scan.js';

test('a page that fits one screen is a single screen at the top', () => {
  assert.deepEqual(planScreens(800, 900), [0]);
  assert.deepEqual(planScreens(900, 900), [0]);
  assert.deepEqual(planScreens(0, 900), [0]);
  assert.deepEqual(planScreens(undefined, 900), [0]);
  assert.deepEqual(planScreens(NaN, 900), [0]);
});

test('screens step by the viewport minus a 10% overlap', () => {
  assert.deepEqual(planScreens(2000, 1000), [0, 900, 1000]);
  assert.deepEqual(planScreens(1900, 1000), [0, 900]);
  assert.deepEqual(planScreens(2700, 1000), [0, 900, 1700]);
});

test('the last screen ends at the bottom of the page and no position repeats', () => {
  const ys = planScreens(5123, 777);
  assert.equal(ys[ys.length - 1], 5123 - 777);
  assert.equal(new Set(ys).size, ys.length);
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] > ys[i - 1]);
});

test('every part of the page is inside some screen', () => {
  const docH = 5345;
  const vh = 640;
  const ys = planScreens(docH, vh);
  for (let y = 0; y < docH; y += 25) assert.ok(ys.some((top) => y >= top && y < top + vh), String(y));
});

test('a very long page stops at the screen cap', () => {
  const ys = planScreens(1_000_000, 900);
  assert.equal(ys.length, MAX_SCREENS);
  assert.equal(MAX_SCREENS, 12);
  assert.equal(ys[0], 0);
});

test('a page of exactly the cap needs no cut', () => {
  const ys = planScreens(900 + 810 * 11, 900);
  assert.equal(ys.length, 12);
  assert.equal(ys[11], 810 * 11);
});

test('a viewport box becomes a document box at the scroll it was captured at', () => {
  assert.deepEqual(toDocBox([10, 20, 110, 160], { x: 0, y: 1800 }), [10, 1820, 110, 1960]);
  assert.deepEqual(toDocBox([10, 20, 110, 160], { x: 5, y: 0 }), [15, 20, 115, 160]);
});

const item = (docBox, anchor, area, screen = 0) => ({ docBox, anchor, area, screen });

test('the same page element on two screens is one card', () => {
  const seen = [item([0, 900, 100, 1040], 7, 9000)];
  assert.deepEqual(judgeDuplicate(seen, item([0, 900, 100, 1040], 7, 9000, 1)), { verdict: 'skip' });
});

test('the same element with a larger visible part replaces the earlier read', () => {
  const seen = [item([0, 900, 100, 1040], 7, 6000)];
  assert.deepEqual(judgeDuplicate(seen, item([0, 900, 100, 1040], 7, 14000, 1)), { verdict: 'replace', index: 0 });
});

test('different elements apart from each other are different cards', () => {
  const seen = [item([0, 0, 100, 140], 1, 14000)];
  assert.deepEqual(judgeDuplicate(seen, item([200, 0, 300, 140], 2, 14000, 1)), { verdict: 'new' });
});

test('different elements in the same place are still one card by overlap', () => {
  const seen = [item([0, 0, 100, 140], 1, 14000)];
  assert.equal(judgeDuplicate(seen, item([0, 0, 100, 140], 2, 14000, 1)).verdict, 'skip');
});

test('without an anchor, boxes that overlap by more than half are one card', () => {
  const seen = [item([0, 0, 100, 140], undefined, 14000)];
  assert.equal(judgeDuplicate(seen, item([5, 10, 105, 150], undefined, 14000, 1)).verdict, 'skip');
  assert.equal(judgeDuplicate(seen, item([60, 0, 160, 140], undefined, 14000, 1)).verdict, 'new');
});

test('a box with no anchor that overlaps an anchored card is still compared by overlap', () => {
  const seen = [item([0, 0, 100, 140], 3, 14000)];
  assert.equal(judgeDuplicate(seen, item([0, 0, 100, 140], undefined, 20000, 1)).verdict, 'replace');
});

test('a card beside the earlier ones is new, and the first overlap decides', () => {
  const seen = [item([0, 0, 100, 140], 1, 14000), item([0, 500, 100, 640], 2, 14000)];
  assert.deepEqual(judgeDuplicate(seen, item([0, 1000, 100, 1140], 3, 14000, 1)), { verdict: 'new' });
  assert.deepEqual(judgeDuplicate(seen, item([0, 500, 100, 640], 2, 20000, 1)), { verdict: 'replace', index: 1 });
});

test('degenerate boxes never match by overlap', () => {
  const seen = [item([0, 0, 0, 0], undefined, 0)];
  assert.equal(judgeDuplicate(seen, item([0, 0, 0, 0], undefined, 0, 1)).verdict, 'new');
});

test('room for cards stops at the cap', () => {
  assert.equal(MAX_CARDS, 200);
  assert.equal(cardRoom(0), 200);
  assert.equal(cardRoom(199), 1);
  assert.equal(cardRoom(200), 0);
  assert.equal(cardRoom(350), 0);
  assert.equal(cardRoom(5, 8), 3);
});

test('captures are at least 550 ms apart and the first one never waits', () => {
  assert.equal(captureWait(null, 1000), 0);
  assert.equal(captureWait(1000, 1100), 450);
  assert.equal(captureWait(1000, 1550), 0);
  assert.equal(captureWait(1000, 3000), 0);
});

test('a scan cut short by the screen cap is told apart from one that fits', () => {
  assert.equal(screensCapped(800, 900), false);
  assert.equal(screensCapped(9810, 900), false);
  assert.equal(screensCapped(900 * MAX_SCREENS * 3, 900), true);
});

test('the truncation note names what was cut', () => {
  assert.equal(truncationNote(null), '');
  assert.equal(truncationNote(undefined), '');
  assert.equal(truncationNote('cards'), ` (first ${MAX_CARDS} cards)`);
  assert.equal(truncationNote('screens'), ` (first ${MAX_SCREENS} screens)`);
});

test('one card read as an image and as the slot behind it is claimed once, on a single screen too', () => {
  const slots = [{ docBox: [10, 10, 110, 150], anchor: undefined, area: 14000 }];
  const dropped = new Set();
  const twin = { docBox: [12, 12, 108, 148], anchor: undefined, area: 13000 };
  assert.deepEqual(claimSlot(slots, dropped, twin, 1), { verdict: 'skip' });
  const bigger = { docBox: [10, 10, 110, 150], anchor: undefined, area: 15000 };
  assert.deepEqual(claimSlot(slots, dropped, bigger, 1), { verdict: 'replace', drop: 0 });
});

test('claiming ignores dropped and empty slots, and says full at the cap', () => {
  const slots = [{ docBox: [0, 0, 100, 140], area: 1 }, null];
  const other = { docBox: [500, 0, 600, 140], area: 1 };
  assert.deepEqual(claimSlot(slots, new Set([0]), { docBox: [0, 0, 100, 140], area: 1 }, 0), { verdict: 'new' });
  assert.deepEqual(claimSlot(slots, new Set(), other, MAX_CARDS), { verdict: 'full' });
});

test('one scan at a time per tab; a request during a scan queues at most one follow-up', () => {
  const gate = createScanGate();
  assert.equal(gate.begin(1), true);
  assert.equal(gate.begin(1), false);
  assert.equal(gate.begin(2), true);
  assert.equal(gate.busy(1), true);
  assert.equal(gate.queueFollowUp(1), true);
  assert.equal(gate.queueFollowUp(1), true);
  assert.equal(gate.end(1), true);
  assert.equal(gate.busy(1), false);
  assert.equal(gate.end(2), false);
  assert.equal(gate.begin(1), true);
  assert.equal(gate.end(1), false);
});

test('a follow-up is only queued for a tab that is scanning', () => {
  const gate = createScanGate();
  assert.equal(gate.queueFollowUp(7), false);
  assert.equal(gate.begin(7), true);
  assert.equal(gate.end(7), false);
});

test('the same page ignores the hash and nothing else', () => {
  assert.equal(samePage('https://a.com/x?y=1#top', 'https://a.com/x?y=1#bottom'), true);
  assert.equal(samePage('https://a.com/x', 'https://a.com/z'), false);
  assert.equal(samePage('https://a.com/x', undefined), false);
  assert.equal(samePage('https://a.com/x?y=1', 'https://a.com/x?y=2'), false);
});

test('the capture rate limit is recognised by its Chrome message', () => {
  assert.equal(isCaptureQuotaError(new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')), true);
  assert.equal(isCaptureQuotaError('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND'), true);
  assert.equal(isCaptureQuotaError(new Error('No tab with id')), false);
  assert.equal(isCaptureQuotaError(null), false);
});

test('an element whose view was dropped for a better one stays one card after the page shifts', () => {
  // Screen 1 read the tile twice (slot 0 = <img>, slot 1 = background slot, which won). Screen 2 sees the
  // same element 90px lower, so no box overlaps any earlier one, but the element id says it is the same card.
  const slots = [
    { docBox: [10, 10, 110, 150], anchor: 7, area: 13000 },
    { docBox: [10, 10, 110, 150], anchor: 9, area: 14000, replaces: 0 },
  ];
  const dropped = new Set([0]);
  const shifted = { docBox: [10, 100, 110, 240], anchor: 7, area: 9000 };
  assert.deepEqual(claimSlot(slots, dropped, shifted, 1), { verdict: 'skip' });
  const better = { docBox: [10, 100, 110, 240], anchor: 7, area: 15000 };
  assert.deepEqual(claimSlot(slots, dropped, better, 1), { verdict: 'replace', drop: 1 });
  const unrelated = { docBox: [10, 400, 110, 540], anchor: 8, area: 15000 };
  assert.deepEqual(claimSlot(slots, dropped, unrelated, 1), { verdict: 'new' });
});

test('a grid tile seen as both <img> and slot is read once; the bigger view wins, then the earlier', () => {
  const views = [
    { docBox: [10, 10, 110, 150], area: 13000 },
    { docBox: [12, 12, 112, 152], area: 14000 },
    { docBox: [300, 10, 400, 150], area: 14000 },
    { docBox: [300, 10, 400, 150], area: 14000 },
  ];
  assert.deepEqual([...coveredByBetterView(views)].sort(), [0, 3]);
  assert.deepEqual([...coveredByBetterView([])], []);
});
