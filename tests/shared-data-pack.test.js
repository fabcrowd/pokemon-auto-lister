import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePack } from "../tools/extension-wasm/lib/bundle.js";

// pack-v1.bin is written by tools/shared-data/pipeline/pack.py (tests/test_pack.py keeps it byte-identical).
const bytes = readFileSync(new URL("../tools/shared-data/tests/fixtures/pack-v1.bin", import.meta.url));

test("the extension's parsePack reads a pack the Python pipeline wrote", () => {
  const manifest = { dim: 512, entries: 3, crop: 2 };
  const rows = parsePack(new Uint8Array(bytes), manifest);
  assert.deepEqual(rows.map((r) => r.cardId), ["base1-4", "sv1-100", "xy1-7"]);
  for (const row of rows) {
    assert.equal(row.embedding.length, 512);
    let norm = 0;
    for (const x of row.embedding) norm += (x * row.scale) ** 2;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 0.02, `row norm ${Math.sqrt(norm)}`);
  }
});

test("parsePack rejects the pack when the manifest entry count differs", () => {
  assert.throws(() => parsePack(new Uint8Array(bytes), { dim: 512, entries: 2, crop: 2 }), /entries/);
});
