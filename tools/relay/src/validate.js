/* global atob */
// Strict validation of contribution schema v1. Anything not listed here is rejected.

export const MAX_ITEMS = 20;
export const MAX_CARDS = 30;
export const MAX_CROP_CHARS = 40000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX16 = /^[0-9a-f]{16}$/;
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

function validCrop(crop) {
  if (typeof crop !== "string" || crop.length < 8 || crop.length > MAX_CROP_CHARS) return false;
  if (crop.length % 4 !== 0 || !BASE64.test(crop)) return false;
  const head = atob(crop.slice(0, 4));
  return head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8 && head.charCodeAt(2) === 0xff;
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

/** @returns {{ok: true} | {ok: false, error: string}} */
export function validateContribution(item) {
  if (!isObject(item)) return fail("contribution must be an object");
  const extra = unknownKey(item, ["v", "install", "split", "photoId", "day", "model", "catalog", "cards"]);
  if (extra) return fail(`unknown field ${extra}`);
  if (item.v !== 1) return fail("v must be 1");
  if (typeof item.install !== "string" || !UUID.test(item.install)) return fail("install must be a lowercase uuid");
  if (typeof item.photoId !== "string" || !HEX16.test(item.photoId)) return fail("photoId must be 16 lowercase hex digits");
  if (item.split !== "teach" && item.split !== "exam") return fail("split must be teach or exam");
  if (item.split !== splitFor(item.photoId)) return fail("split does not match the photoId rule");
  if (!validDay(item.day)) return fail("day must be a real date as YYYY-MM-DD");
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
export function validateBatch(body) {
  if (!isObject(body)) return fail("body must be an object");
  const extra = unknownKey(body, ["v", "contributions"]);
  if (extra) return fail(`unknown field ${extra}`);
  if (body.v !== 1) return fail("v must be 1");
  const list = body.contributions;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) return fail(`contributions must hold 1..${MAX_ITEMS} entries`);
  for (let i = 0; i < list.length; i++) {
    const r = validateContribution(list[i]);
    if (!r.ok) return fail(`contributions[${i}]: ${r.error}`);
  }
  return { ok: true };
}
