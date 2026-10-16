import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFor, validateBatch, validateContribution } from "../tools/relay/src/validate.js";
import { contribution, card } from "../tools/relay/test/builders.js";

const bad = (item, pattern) => {
  const r = validateContribution(item);
  assert.equal(r.ok, false, "expected rejection");
  assert.match(r.error, pattern);
};

test("splitFor uses the low 32 bits of photoId mod 5", () => {
  assert.equal(splitFor("0000000000000005"), "exam");
  assert.equal(splitFor("0000000000000001"), "teach");
  assert.equal(splitFor("ffffffff00000005"), "exam"); // high 32 bits are ignored
  assert.equal(splitFor("00000000ffffffff"), "exam"); // 4294967295 % 5 === 0, no signed overflow
  assert.equal(splitFor("00000000fffffffe"), "teach");
});

test("a valid contribution passes", () => {
  assert.deepEqual(validateContribution(contribution()), { ok: true });
});

test("exam split with matching photoId passes", () => {
  assert.equal(validateContribution(contribution({ photoId: "0000000000000005", split: "exam" })).ok, true);
});

test("each answer shape passes", () => {
  for (const answer of [{ cardId: "x-1" }, { notACard: true }, { unknown: true }]) {
    assert.equal(validateContribution(contribution({ cards: [card({ answer })] })).ok, true);
  }
});

test("scanner.cardId may be null", () => {
  const c = card({ scanner: { cardId: null, confidence: 0, stripe: "none" } });
  assert.equal(validateContribution(contribution({ cards: [c] })).ok, true);
});

test("rejects wrong version, install, photoId, day, model, catalog", () => {
  bad(contribution({ v: 2 }), /v/);
  bad(contribution({ install: "not-a-uuid" }), /install/);
  bad(contribution({ photoId: "XYZ" }), /photoId/);
  bad(contribution({ photoId: "00000000000000A1" }), /photoId/);
  bad(contribution({ day: "2026-02-30" }), /day/);
  bad(contribution({ day: "10/15/2026" }), /day/);
  bad(contribution({ model: { clip: "short", crop: 2 } }), /model/);
  bad(contribution({ model: { clip: "0123456789abcdef", crop: 1.5 } }), /model/);
  bad(contribution({ catalog: "zz" }), /catalog/);
});

test("rejects a split that breaks the photoId rule", () => {
  bad(contribution({ photoId: "0000000000000005", split: "teach" }), /split/);
  bad(contribution({ photoId: "00000000000000a1", split: "exam" }), /split/);
  bad(contribution({ split: "train" }), /split/);
});

test("rejects unknown fields at every level", () => {
  bad(contribution({ extra: 1 }), /extra/);
  bad(contribution({ model: { clip: "0123456789abcdef", crop: 2, x: 1 } }), /x/);
  bad(contribution({ cards: [card({ url: "https://example.com" })] }), /url/);
  bad(contribution({ cards: [card({ answer: { cardId: "a", notACard: true } })] }), /answer/);
  bad(contribution({ cards: [card({ scanner: { cardId: null, confidence: 0, stripe: "none", z: 1 } })] }), /z/);
});

test("rejects card count outside 1..30", () => {
  bad(contribution({ cards: [] }), /cards/);
  bad(contribution({ cards: Array.from({ length: 31 }, () => card()) }), /cards/);
  assert.equal(validateContribution(contribution({ cards: Array.from({ length: 30 }, () => card()) })).ok, true);
});

test("rejects crops that are not base64 JPEG or are too long", () => {
  bad(contribution({ cards: [card({ crop: Buffer.from("GIF89a....").toString("base64") })] }), /crop/);
  bad(contribution({ cards: [card({ crop: "not base64!!" })] }), /crop/);
  bad(contribution({ cards: [card({ crop: "" })] }), /crop/);
  bad(contribution({ cards: [card({ crop: "/9j/" + "A".repeat(40000) })] }), /crop/);
});

test("rejects boxes outside 0..1 or malformed", () => {
  bad(contribution({ cards: [card({ box: [0, 0, 1.1, 1] })] }), /box/);
  bad(contribution({ cards: [card({ box: [-0.1, 0, 0.5, 0.5] })] }), /box/);
  bad(contribution({ cards: [card({ box: [0, 0, 0.5] })] }), /box/);
  bad(contribution({ cards: [card({ box: [0, 0, 0, 0.5] })] }), /box/);
  bad(contribution({ cards: [card({ box: [0, 0, "a", 0.5] })] }), /box/);
});

test("rejects bad enums, confidence and answers", () => {
  bad(contribution({ cards: [card({ source: "auto" })] }), /source/);
  bad(contribution({ cards: [card({ scanner: { cardId: null, confidence: 0.5, stripe: "huge" } })] }), /stripe/);
  bad(contribution({ cards: [card({ scanner: { cardId: null, confidence: 1.5, stripe: "low" } })] }), /confidence/);
  bad(contribution({ cards: [card({ answer: { notACard: false } })] }), /answer/);
  bad(contribution({ cards: [card({ answer: { cardId: "bad id with spaces" } })] }), /answer/);
  bad(contribution({ cards: [card({ answer: {} })] }), /answer/);
});

test("validateBatch enforces the shape and 1..20 items", () => {
  assert.equal(validateBatch({ v: 1, contributions: [contribution()] }).ok, true);
  assert.equal(validateBatch({ v: 1, contributions: [] }).ok, false);
  assert.equal(validateBatch({ v: 1, contributions: Array.from({ length: 21 }, () => contribution()) }).ok, false);
  assert.equal(validateBatch({ v: 1, contributions: [contribution()], other: 1 }).ok, false);
  assert.equal(validateBatch(null).ok, false);
  assert.equal(validateBatch({ items: [contribution()] }).ok, false); // old shape
  assert.equal(validateBatch({ v: 2, contributions: [contribution()] }).ok, false);
  assert.equal(validateBatch({ contributions: [contribution()] }).ok, false);
  const r = validateBatch({ v: 1, contributions: [contribution(), contribution({ v: 9 })] });
  assert.equal(r.ok, false);
  assert.match(r.error, /contributions\[1\]/);
});
