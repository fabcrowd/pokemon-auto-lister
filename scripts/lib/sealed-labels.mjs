import { EDITIONS, FINISHES } from '../../tools/extension-wasm/lib/variant.js';

const SHA = /^[0-9a-f]{64}$/;
const BOX_KINDS = ['card', 'not-card', 'unknown', 'bad-box'];
const DRAWN_KINDS = ['card', 'unknown', 'removed'];
const MAX_MISSED = 50;
const MAX_DRAWN = 60;
const MIN_DRAWN_SIDE = 8;

export const isSha = (value) => typeof value === 'string' && SHA.test(value);

const isBox = (box) => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite);

/** A photos.jsonl row is trusted only when its file is exactly photos/<sha>.jpg, so no path needs checking later. */
export function validPhotoRow(row) {
  return Boolean(row)
    && isSha(row.sha)
    && row.file === `photos/${row.sha}.jpg`
    && Array.isArray(row.boxes) && row.boxes.every(isBox)
    && Number.isInteger(row.width) && row.width > 0
    && Number.isInteger(row.height) && row.height > 0;
}

const fail = (why) => {
  throw new Error(`Label: ${why}`);
};

function oneOf(value, allowed, name) {
  if (value == null) return null;
  if (!allowed.includes(value)) fail(`${name} must be one of ${allowed.join(', ')} or empty`);
  return value;
}

function identityOf(body, catalogHas, kind) {
  const edition = oneOf(body.edition, EDITIONS, 'edition');
  const finish = oneOf(body.finish, FINISHES, 'finish');
  if (kind === 'card') {
    if (typeof body.cardId !== 'string' || !catalogHas(body.cardId)) fail('cardId is not in the catalog');
    return { cardId: body.cardId, edition, finish };
  }
  if (body.cardId != null || edition || finish) fail(`a ${kind} box has no card, edition or finish`);
  return { cardId: null, edition: null, finish: null };
}

function validateDrawn(body, photo, catalogHas, now) {
  if (body.boxIndex != null) fail('a drawn box has no detector box index');
  if (!Number.isInteger(body.drawnId) || body.drawnId < 0 || body.drawnId >= MAX_DRAWN) fail(`drawnId must be a whole number from 0 to ${MAX_DRAWN - 1}`);
  if (!DRAWN_KINDS.includes(body.kind)) fail(`a drawn box is one of ${DRAWN_KINDS.join(', ')}`);
  const base = { sha: body.sha, boxIndex: null, drawn: true, drawnId: body.drawnId };
  if (body.kind === 'removed') {
    if (body.box != null || body.cardId != null || body.edition != null || body.finish != null) fail('a removed box has nothing else');
    return { ...base, box: null, cardId: null, edition: null, finish: null, kind: 'removed', ts: now };
  }
  if (!isBox(body.box)) fail('box must be [x1, y1, x2, y2]');
  const box = body.box.map(Math.round);
  const [x1, y1, x2, y2] = box;
  if (x1 < 0 || y1 < 0 || x2 > photo.width || y2 > photo.height || x2 - x1 < MIN_DRAWN_SIDE || y2 - y1 < MIN_DRAWN_SIDE) {
    fail('box must lie on the photo and be at least 8 pixels each way');
  }
  return { ...base, box, ...identityOf(body, catalogHas, body.kind), kind: body.kind, ts: now };
}

/** The row to append to labels.jsonl, or a thrown error naming what is wrong. */
export function validateLabel(body, { photo, catalogHas, now = Date.now() }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body must be an object');
  if (!isSha(body.sha)) fail('sha must be 64 hex digits');
  if (!photo || photo.sha !== body.sha) fail('no such photo');

  if (body.drawn === true) return validateDrawn(body, photo, catalogHas, now);

  if (body.kind === 'photo') {
    if (body.boxIndex != null) fail('a photo row has no box index');
    if (!Number.isInteger(body.missed) || body.missed < 0 || body.missed > MAX_MISSED) {
      fail(`missed must be a whole number from 0 to ${MAX_MISSED}`);
    }
    return { sha: body.sha, boxIndex: null, cardId: null, edition: null, finish: null, kind: 'photo', missed: body.missed, ts: now };
  }

  if (!BOX_KINDS.includes(body.kind)) fail(`kind must be one of ${BOX_KINDS.join(', ')}, photo`);
  if (!Number.isInteger(body.boxIndex) || body.boxIndex < 0 || body.boxIndex >= photo.boxes.length) {
    fail('boxIndex is out of range');
  }
  return { sha: body.sha, boxIndex: body.boxIndex, ...identityOf(body, catalogHas, body.kind), kind: body.kind, ts: now };
}

/** Last row per box, per drawn box and per photo wins. */
export function currentLabels(rows) {
  const boxes = new Map();
  const photos = new Map();
  const drawn = new Map();
  for (const row of rows) {
    if (row.kind === 'photo') photos.set(row.sha, row);
    else if (row.drawn === true) drawn.set(`${row.sha}:${row.drawnId}`, row);
    else boxes.set(`${row.sha}:${row.boxIndex}`, row);
  }
  return { boxes, photos, drawn };
}

export function drawnFor(sha, current) {
  return [...current.drawn.values()]
    .filter((row) => row.sha === sha && row.kind !== 'removed')
    .sort((a, b) => a.drawnId - b.drawnId);
}

/** Every box labeled, and the person has looked the whole photo over for missed cards. */
export function isPhotoDone(photo, current) {
  return current.photos.has(photo.sha)
    && photo.boxes.every((_, index) => current.boxes.has(`${photo.sha}:${index}`));
}

/** One unit per detector box, plus one for finishing each photo. */
export function progressOf(photos, current) {
  let labeled = 0;
  let total = 0;
  for (const photo of photos) {
    total += photo.boxes.length + 1;
    if (current.photos.has(photo.sha)) labeled += 1;
    photo.boxes.forEach((_, index) => {
      if (current.boxes.has(`${photo.sha}:${index}`)) labeled += 1;
    });
  }
  return { labeled, total };
}

/** What the scorer compares against: detector boxes with their labels, drawn boxes, and cards nobody could box. */
export function truthOf(photo, current) {
  const truth = photo.boxes.map((box, index) => {
    const label = current.boxes.get(`${photo.sha}:${index}`);
    return { box, kind: label.kind, cardId: label.cardId ?? null, edition: label.edition ?? null, finish: label.finish ?? null };
  });
  for (const row of drawnFor(photo.sha, current)) {
    truth.push({ box: row.box, kind: row.kind, cardId: row.cardId ?? null, edition: row.edition ?? null, finish: row.finish ?? null });
  }
  return { truth, missed: current.photos.get(photo.sha)?.missed ?? 0 };
}
