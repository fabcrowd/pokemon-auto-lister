// Contribution schema v1: what the opt-in "Help improve recognition for everyone" setting sends.
// The relay validates the same shape (docs/plans/shared-learning.md). Nothing else is ever sent:
// no page address, no full photo, no account.

import { ASSETS } from "./setup.js";
import { EMBEDDING_VERSION } from "./embed.js";
import { confTier } from "./card-display.js";
import { splitOf } from "./photo-id.js";

export const MAX_CARDS = 30;
export const MAX_CROP_CHARS = 40000;
export const CROP_LONG_SIDE = 320;
export const CROP_QUALITY = 0.8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const STRIPES = ["high", "medium", "low", "none"];
const SOURCES = ["pick", "wrong-card", "confirm"];
const TOP_KEYS = ["v", "install", "split", "photoId", "day", "model", "catalog", "cards"];
const CARD_KEYS = ["box", "crop", "answer", "scanner", "source"];

const pinPrefix = (name) => {
  const asset = ASSETS.find((a) => a.name === name);
  if (!asset) throw new Error(`${name} is not a pinned model file`);
  return asset.sha256.slice(0, 16);
};

/** The model and catalog this build reads with: first 16 hex of the pinned hashes, and the crop version. */
export function modelTags() {
  return { clip: pinPrefix("clip_visual_int8.onnx"), catalog: pinPrefix("catalog.bin.gz"), crop: EMBEDDING_VERSION };
}

/** Size of the picture that is sent: the long side is 320 pixels. */
export function cropSize(width, height) {
  const scale = CROP_LONG_SIDE / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const dayOf = (date = new Date()) => date.toISOString().slice(0, 10);

/** [x1, y1, x2, y2] in photo pixels → [x, y, w, h] as fractions of the photo, or null for an empty box. */
export function normalizeBox([x1, y1, x2, y2], width, height) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const x = clamp(x1 / width);
  const y = clamp(y1 / height);
  const w = clamp(x2 / width) - x;
  const h = clamp(y2 / height) - y;
  return w > 0 && h > 0 ? [x, y, w, h].map((v) => Math.round(v * 1e6) / 1e6) : null;
}

/** What the scanner said about a card row. */
export function scannerOf(card) {
  const cardId = card?.identity?.id ?? null;
  const confidence = Number.isFinite(card?.confidence) ? Math.min(1, Math.max(0, card.confidence)) : 0;
  return { cardId, confidence, stripe: cardId && !card?.abstain ? confTier(confidence) : "none" };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFraction = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function answerError(answer) {
  if (!isObject(answer)) return "answer must be an object";
  const keys = Object.keys(answer);
  if (keys.length !== 1) return "answer must have exactly one of cardId, notACard, unknown";
  const [key] = keys;
  if (key === "cardId") return typeof answer.cardId === "string" && answer.cardId ? null : "answer.cardId must be a non-empty string";
  if (key === "notACard" || key === "unknown") return answer[key] === true ? null : `answer.${key} must be true`;
  return "answer must have exactly one of cardId, notACard, unknown";
}

function cardErrors(card, at) {
  const errors = [];
  const fail = (message) => errors.push(`cards[${at}].${message}`);
  if (!isObject(card)) return [`cards[${at}] must be an object`];
  for (const key of Object.keys(card)) if (!CARD_KEYS.includes(key)) fail(`${key} is not allowed`);
  const { box } = card;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(isFraction) || !(box[2] > 0) || !(box[3] > 0) || box[0] + box[2] > 1 + 1e-6 || box[1] + box[3] > 1 + 1e-6) {
    fail("box must be [x,y,w,h] within 0..1 of the photo");
  }
  if (typeof card.crop !== "string" || !card.crop || card.crop.length > MAX_CROP_CHARS || !BASE64.test(card.crop)) {
    fail(`crop must be base64 of at most ${MAX_CROP_CHARS} characters`);
  }
  const answer = answerError(card.answer);
  if (answer) fail(answer);
  const scanner = card.scanner;
  if (!isObject(scanner)) fail("scanner must be an object");
  else {
    if (scanner.cardId !== null && (typeof scanner.cardId !== "string" || !scanner.cardId)) fail("scanner.cardId must be a card id or null");
    if (!isFraction(scanner.confidence)) fail("scanner.confidence must be within 0..1");
    if (!STRIPES.includes(scanner.stripe)) fail(`scanner.stripe must be one of ${STRIPES.join(", ")}`);
  }
  if (!SOURCES.includes(card.source)) fail(`source must be one of ${SOURCES.join(", ")}`);
  return errors;
}

/** Every way the object departs from schema v1; an empty list means it is valid. */
export function validateContribution(c) {
  if (!isObject(c)) return ["contribution must be an object"];
  const errors = [];
  for (const key of Object.keys(c)) if (!TOP_KEYS.includes(key)) errors.push(`${key} is not allowed`);
  if (c.v !== 1) errors.push("v must be 1");
  if (typeof c.install !== "string" || !UUID.test(c.install)) errors.push("install must be a UUID");
  if (c.split !== "teach" && c.split !== "exam") errors.push("split must be teach or exam");
  if (typeof c.photoId !== "string" || !HEX16.test(c.photoId)) errors.push("photoId must be 16 lowercase hex digits");
  else if ((c.split === "teach" || c.split === "exam") && splitOf(c.photoId) !== c.split) errors.push("split does not match photoId");
  if (typeof c.day !== "string" || !DAY.test(c.day) || Number.isNaN(Date.parse(c.day))) errors.push("day must be YYYY-MM-DD");
  if (!isObject(c.model)) errors.push("model must be an object");
  else {
    if (typeof c.model.clip !== "string" || !HEX16.test(c.model.clip)) errors.push("model.clip must be 16 lowercase hex digits");
    if (!Number.isInteger(c.model.crop) || c.model.crop < 1) errors.push("model.crop must be a positive integer");
  }
  if (typeof c.catalog !== "string" || !HEX16.test(c.catalog)) errors.push("catalog must be 16 lowercase hex digits");
  if (!Array.isArray(c.cards) || c.cards.length < 1 || c.cards.length > MAX_CARDS) errors.push(`cards must hold 1 to ${MAX_CARDS} rows`);
  else c.cards.forEach((card, at) => errors.push(...cardErrors(card, at)));
  return errors;
}

/** A validated contribution for one photo. Throws, listing every problem, rather than build a bad one. */
export function buildContribution({ install, photoId, cards, now = new Date() }) {
  const tags = modelTags();
  const contribution = {
    v: 1,
    install,
    split: splitOf(photoId),
    photoId,
    day: dayOf(now),
    model: { clip: tags.clip, crop: tags.crop },
    catalog: tags.catalog,
    cards,
  };
  const errors = validateContribution(contribution);
  if (errors.length) throw new Error(`invalid contribution: ${errors.join("; ")}`);
  return contribution;
}
