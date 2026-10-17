import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptWholePhoto,
  displayedRegion,
  mergeTileDetections,
  tileRects,
  planHeroCard,
  WHOLE_PHOTO_MIN_SIMILARITY,
} from '../tools/extension-wasm/photo-detection.js';

test('a box the size filter accepts needs no fallback', () => {
  const plan = planHeroCard({ imageW: 540, imageH: 720, detections: [{ box: [120, 40, 420, 460], score: 0.7 }] });
  assert.deepEqual(plan, { kind: 'detected' });
});

test('a card that fills the frame is kept as the hero card instead of being dropped for size', () => {
  const plan = planHeroCard({ imageW: 660, imageH: 920, detections: [{ box: [2, 0, 660, 918], score: 0.28 }] });
  assert.equal(plan.kind, 'large-box');
  assert.deepEqual(plan.box, [2, 0, 660, 918]);
  assert.equal(plan.score, 0.28);
});

test('the most confident large box wins', () => {
  const plan = planHeroCard({
    imageW: 768,
    imageH: 1024,
    detections: [{ box: [0, 0, 760, 1020], score: 0.3 }, { box: [10, 5, 758, 1010], score: 0.9 }],
  });
  assert.equal(plan.kind, 'large-box');
  assert.equal(plan.score, 0.9);
});

test('a large box that is not card-shaped is not a card', () => {
  const plan = planHeroCard({ imageW: 1200, imageH: 1000, detections: [{ box: [0, 0, 1200, 500], score: 0.9 }] });
  assert.equal(plan.kind, 'none');
});

test('with no detection at all a card-shaped photo is tried whole and as centred zooms', () => {
  const plan = planHeroCard({ imageW: 768, imageH: 1023, detections: [] });
  assert.equal(plan.kind, 'whole-photo');
  assert.equal(plan.crops.length, 3);
  assert.deepEqual(plan.crops[0], [0, 0, 768, 1023]);
  for (const [x1, y1, x2, y2] of plan.crops) {
    assert.ok(x1 >= 0 && y1 >= 0 && x2 <= 768 && y2 <= 1023);
    assert.ok(Number.isInteger(x1) && Number.isInteger(y1) && Number.isInteger(x2) && Number.isInteger(y2));
    assert.ok(Math.abs((x2 - x1) / (y2 - y1) - 768 / 1023) < 0.01);
    assert.ok(Math.abs(x1 + x2 - 768) <= 1 && Math.abs(y1 + y2 - 1023) <= 1);
  }
  assert.ok(plan.crops[2][2] - plan.crops[2][0] < plan.crops[1][2] - plan.crops[1][0]);
});

test('a slab-shaped photo is still tried whole', () => {
  assert.equal(planHeroCard({ imageW: 600, imageH: 1000, detections: [] }).kind, 'whole-photo');
});

test('a landscape photo with no detection is not turned into a card', () => {
  assert.equal(planHeroCard({ imageW: 1200, imageH: 800, detections: [] }).kind, 'none');
  assert.equal(planHeroCard({ imageW: 2000, imageH: 800, detections: [] }).kind, 'none');
});

test('a squarish photo with no detection is tried as centred card-shaped crops and must name a card', () => {
  const plan = planHeroCard({ imageW: 714, imageH: 714, detections: [] });
  assert.equal(plan.kind, 'whole-photo');
  assert.equal(plan.strict, true);
  assert.equal(plan.crops.length, 3);
  for (const [x1, y1, x2, y2] of plan.crops) {
    assert.ok(Math.abs((x2 - x1) / (y2 - y1) - 5 / 7) < 0.01);
    assert.ok(x1 >= 0 && y1 >= 0 && x2 <= 714 && y2 <= 714);
    assert.ok(Math.abs(x1 + x2 - 714) <= 1 && Math.abs(y1 + y2 - 714) <= 1);
  }
  assert.equal(planHeroCard({ imageW: 768, imageH: 1023, detections: [] }).strict, false);
});

test('bad input yields no plan rather than a throw', () => {
  assert.equal(planHeroCard({ imageW: 0, imageH: 0, detections: [] }).kind, 'none');
  assert.equal(planHeroCard({ imageW: 500, imageH: 700, detections: null }).kind, 'whole-photo');
});

test('a whole-photo read is kept when it named a card, or when it at least resembles one', () => {
  assert.equal(acceptWholePhoto({ abstain: false, identity: { name: 'Umbreon' }, catalogTop: 0.5 }), true);
  assert.equal(acceptWholePhoto({ abstain: true, identity: null, catalogTop: WHOLE_PHOTO_MIN_SIMILARITY }), true);
  assert.equal(acceptWholePhoto({ abstain: true, identity: null, catalogTop: WHOLE_PHOTO_MIN_SIMILARITY - 0.01 }), false);
  assert.equal(acceptWholePhoto({ abstain: true, identity: null }), false);
  assert.equal(acceptWholePhoto({ abstain: true, cardBack: true, catalogTop: 0.9 }), false);
  assert.equal(acceptWholePhoto(null), false);
  assert.equal(acceptWholePhoto({ abstain: true, identity: null, catalogTop: 0.9 }, { strict: true }), false);
  assert.equal(acceptWholePhoto({ abstain: false, identity: { name: 'Umbreon' } }, { strict: true }), true);
});

test('a letterboxed screenshot crop is cut down to the picture itself', () => {
  // 524x524 slot, 660x920 picture shown with contain at 1.5x device pixels
  const rect = { x: 136, y: 433, w: 524, h: 524, vx: 136, vy: 433, vw: 524, vh: 524 };
  const region = displayedRegion(rect, 660, 920, { fit: 'contain', position: '50% 50%' }, 1.5);
  assert.ok(region);
  assert.equal(region.h, 786);
  assert.ok(Math.abs(region.w - 786 * 660 / 920) <= 1);
  assert.equal(region.x, Math.round((786 - region.w) / 2));
  assert.equal(region.y, 0);
});

test('a picture that fills its slot, or has no known size, keeps the whole crop', () => {
  const rect = { x: 0, y: 0, w: 400, h: 300, vx: 0, vy: 0, vw: 400, vh: 300 };
  assert.equal(displayedRegion(rect, 800, 600, { fit: 'contain' }, 1), null);
  assert.equal(displayedRegion(rect, null, null, { fit: 'contain' }, 1), null);
  assert.equal(displayedRegion({ ...rect, vx: 50, vw: 350 }, 400, 300, { fit: 'fill' }, 1), null);
});

test('tiles cover the photo, overlap, and stay inside it', () => {
  for (const n of [2, 3]) {
    const tiles = tileRects(800, 800, n);
    assert.equal(tiles.length, n * n);
    for (const [x1, y1, x2, y2] of tiles) {
      assert.ok(x1 >= 0 && y1 >= 0 && x2 <= 800 && y2 <= 800 && x2 > x1 && y2 > y1);
    }
    assert.ok(tiles.some(([, , x2]) => x2 === 800));
    assert.ok(tiles.some(([x1]) => x1 === 0));
    assert.ok(tiles[0][2] > tiles[1][0], 'neighbouring tiles overlap');
  }
});

test('cards found in different tiles are kept and one card seen in two tiles is merged', () => {
  const tiles = [[0, 0, 500, 500], [300, 0, 800, 500]];
  const merged = mergeTileDetections([
    { rect: tiles[0], detections: [{ box: [20, 40, 220, 340], score: 0.9 }, { box: [330, 40, 490, 330], score: 0.8 }] },
    { rect: tiles[1], detections: [{ box: [30, 40, 190, 330], score: 0.7 }, { box: [250, 20, 450, 320], score: 0.85 }] },
  ]);
  assert.equal(merged.length, 3);
  assert.ok(merged.some(({ box }) => Math.abs(box[0] - 20) < 5));
  assert.ok(merged.some(({ box }) => Math.abs(box[0] - 550) < 5));
  assert.ok(merged[0].score >= merged[1].score);
});

test('tile detections that are not card-shaped are ignored', () => {
  assert.deepEqual(mergeTileDetections([{ rect: [0, 0, 400, 400], detections: [{ box: [0, 0, 400, 100], score: 0.9 }] }]), []);
});

test('a cover-cropped screenshot keeps an abstained read that resembles a card as a suggestion', () => {
  const read = { abstain: true, identity: null, catalogTop: WHOLE_PHOTO_MIN_SIMILARITY };
  assert.equal(acceptWholePhoto(read, { strict: true }), false);
  assert.equal(acceptWholePhoto(read, { strict: true, croppedView: true }), true);
  assert.equal(acceptWholePhoto({ ...read, catalogTop: 0.3 }, { strict: true, croppedView: true }), false);
});

test('weak tile detections are not evidence of a lot', () => {
  const merged = mergeTileDetections([
    { rect: [0, 0, 500, 500], detections: [{ box: [20, 40, 220, 340], score: 0.14 }, { box: [250, 40, 450, 340], score: 0.13 }] },
  ]);
  assert.deepEqual(merged, []);
  assert.equal(mergeTileDetections([{ rect: [0, 0, 500, 500], detections: [{ box: [20, 40, 220, 340], score: 0.14 }] }], { minScore: 0.1 }).length, 1);
});
