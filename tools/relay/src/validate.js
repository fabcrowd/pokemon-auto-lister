/* global atob */
// Strict validation of contribution schema v1. Anything not listed here is rejected.

export const MAX_ITEMS = 20;
export const MAX_CARDS = 30;
export const MAX_CROP_CHARS = 40000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const RECEIVED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_DAY_SKEW_MS = 2 * 86400000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CARD_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const STRIPES = new Set(["high", "medium", "low", "none"]);
const SOURCES = new Set(["pick", "wrong-card", "confirm"]);

/**
 * The split a photo must belong to: the low 32 bits of photoId (its last 8 hex digits) mod 5.
 * 0 is "exam" (about 20% of photos), everything else "teach". The extension must use the same rule.
 */
export function splitFor(photoId) {
  return parseInt(photoId.slice(-8), 16) % 5 === 0 ? "exam" : "teach";
}

const fail = (error) => ({ ok: false, error });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const unknownKey = (obj, allowed) => Object.keys(obj).find((k) => !allowed.includes(k));
const inUnit = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

function validDay(day) {
  if (typeof day !== "string" || !DAY.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

export const MAX_CROP_SIDE = 400;
export const MIN_CROP_LONG_SIDE = 64;

/**
 * Reads the frame header of a JPEG and applies the size limits. It walks the marker segments up to the
 * first SOF0/SOF1/SOF2 (before any scan), so bytes hidden after the image data are never interpreted.
 */
function jpegAcceptable(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return false;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return false;
    while (b[i] === 0xff && i < b.length) i++;
    const marker = b[i++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return false; // end or scan before any frame header
    if (i + 2 > b.length) return false;
    const length = (b[i] << 8) | b[i + 1];
    if (length < 2) return false;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8 || i + length > b.length) return false;
      const height = (b[i + 3] << 8) | b[i + 4];
      const width = (b[i + 5] << 8) | b[i + 6];
      const components = b[i + 7];
      if (components < 1 || components > 3 || length !== 8 + 3 * components) return false;
      return width >= 1 && height >= 1 && width <= MAX_CROP_SIDE && height <= MAX_CROP_SIDE && Math.max(width, height) >= MIN_CROP_LONG_SIDE;
    }
    i += length;
  }
  return false;
}

function validCrop(crop) {
  if (typeof crop !== "string" || crop.length < 8 || crop.length > MAX_CROP_CHARS) return false;
  if (crop.length % 4 !== 0 || !BASE64.test(crop)) return false;
  const binary = atob(crop);
  const bytes = new Uint8Array(binary.length);
  for (let k = 0; k < binary.length; k++) bytes[k] = binary.charCodeAt(k);
  return jpegAcceptable(bytes);
}

function validAnswer(answer) {
  if (!isObject(answer)) return false;
  const keys = Object.keys(answer);
  if (keys.length !== 1) return false;
  if (keys[0] === "cardId") return typeof answer.cardId === "string" && CARD_ID.test(answer.cardId);
  if (keys[0] === "notACard") return answer.notACard === true;
  if (keys[0] === "unknown") return answer.unknown === true;
  return false;
}

function validateScanner(s) {
  if (!isObject(s)) return "scanner must be an object";
  const extra = unknownKey(s, ["cardId", "confidence", "stripe"]);
  if (extra) return `scanner has unknown field ${extra}`;
  if (s.cardId !== null && !(typeof s.cardId === "string" && CARD_ID.test(s.cardId))) return "scanner.cardId must be an id or null";
  if (!inUnit(s.confidence)) return "scanner.confidence must be 0..1";
  if (!STRIPES.has(s.stripe)) return "scanner.stripe is not an allowed value";
  return null;
}

function validateCard(c) {
  if (!isObject(c)) return "must be an object";
  const extra = unknownKey(c, ["box", "crop", "answer", "scanner", "source"]);
  if (extra) return `unknown field ${extra}`;
  if (!Array.isArray(c.box) || c.box.length !== 4 || !c.box.every(inUnit) || c.box[2] <= 0 || c.box[3] <= 0) {
    return "box must be [x,y,w,h] in 0..1 with positive size";
  }
  if (!validCrop(c.crop)) return `crop must be a base64 JPEG of at most ${MAX_CROP_CHARS} characters`;
  if (!validAnswer(c.answer)) return "answer must be exactly one of {cardId}, {notACard:true}, {unknown:true}";
  const scannerError = validateScanner(c.scanner);
  if (scannerError) return scannerError;
  if (!SOURCES.has(c.source)) return "source is not an allowed value";
  return null;
}

/**
 * @param {object} [options]
 *   now: server clock; when given, `day` must be within 2 days of it (the client only chooses a label, never an order).
 *   stored: the form kept by the relay, where `install` is the 16-hex HMAC and `received` is the server time.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateContribution(item, { now, stored = false } = {}) {
  if (!isObject(item)) return fail("contribution must be an object");
  const extra = unknownKey(item, ["v", "install", "split", "photoId", "day", "model", "catalog", "cards", ...(stored ? ["received"] : [])]);
  if (extra) return fail(`unknown field ${extra}`);
  if (stored && (typeof item.received !== "string" || !RECEIVED.test(item.received))) return fail("received must be a server timestamp");
  if (item.v !== 1) return fail("v must be 1");
  if (typeof item.install !== "string" || !(stored ? HEX16 : UUID).test(item.install)) return fail(stored ? "install must be 16 hex digits" : "install must be a lowercase uuid");
  if (typeof item.photoId !== "string" || !HEX16.test(item.photoId)) return fail("photoId must be 16 lowercase hex digits");
  if (item.split !== "teach" && item.split !== "exam") return fail("split must be teach or exam");
  if (item.split !== splitFor(item.photoId)) return fail("split does not match the photoId rule");
  if (!validDay(item.day)) return fail("day must be a real date as YYYY-MM-DD");
  if (now && Math.abs(Date.parse(`${item.day}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) > MAX_DAY_SKEW_MS) return fail("day is too far from today");
  const m = item.model;
  if (!isObject(m) || unknownKey(m, ["clip", "crop"]) || typeof m.clip !== "string" || !HEX16.test(m.clip) || !Number.isSafeInteger(m.crop) || m.crop < 0) {
    return fail("model must be {clip: 16 hex, crop: non-negative integer}");
  }
  if (typeof item.catalog !== "string" || !HEX16.test(item.catalog)) return fail("catalog must be 16 lowercase hex digits");
  if (!Array.isArray(item.cards) || item.cards.length < 1 || item.cards.length > MAX_CARDS) return fail(`cards must hold 1..${MAX_CARDS} entries`);
  for (let i = 0; i < item.cards.length; i++) {
    const error = validateCard(item.cards[i]);
    if (error) return fail(`cards[${i}]: ${error}`);
  }
  return { ok: true };
}

/** Validates a request body { v: 1, contributions: [...] }, the shape lib/contribution.js uploads. */
export function validateBatch(body, options = {}) {
  if (!isObject(body)) return fail("body must be an object");
  const extra = unknownKey(body, ["v", "contributions"]);
  if (extra) return fail(`unknown field ${extra}`);
  if (body.v !== 1) return fail("v must be 1");
  const list = body.contributions;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) return fail(`contributions must hold 1..${MAX_ITEMS} entries`);
  for (let i = 0; i < list.length; i++) {
    const r = validateContribution(list[i], options);
    if (!r.ok) return fail(`contributions[${i}]: ${r.error}`);
  }
  return { ok: true };
}
