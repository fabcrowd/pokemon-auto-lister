import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMultiCardSplitter } from '../src/photos/splitMultiCard.js';

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAeJAgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/9k=',
  'base64',
);
const CROP_B64 = TINY_JPEG.toString('base64');

async function withTempDir(fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'split-multi-'));
  const photoPath = path.join(dataDir, 'table.jpg');
  writeFileSync(photoPath, TINY_JPEG);
  try {
    return await fn({ dataDir, photoPath });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function jsonResponse(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

test('splitPhoto returns the original path when splitting is disabled', async () => {
  await withTempDir(async ({ dataDir, photoPath }) => {
    const splitter = createMultiCardSplitter({
      dataDir,
      enabled: false,
      fetchImpl: async () => {
        throw new Error('should not fetch when disabled');
      },
    });
    const result = await splitter.splitPhoto(photoPath);
    assert.deepEqual(result, [photoPath]);
  });
});

test('splitPhoto returns the original path when the sidecar reports 0 or 1 card', async () => {
  await withTempDir(async ({ dataDir, photoPath }) => {
    const splitter = createMultiCardSplitter({
      dataDir,
      enabled: true,
      fetchImpl: async () => jsonResponse({ cards: [{ index: 0, crop_b64: CROP_B64 }] }),
    });
    const result = await splitter.splitPhoto(photoPath);
    assert.deepEqual(result, [photoPath]);
  });
});

test('splitPhoto returns the original path when the sidecar request fails', async () => {
  await withTempDir(async ({ dataDir, photoPath }) => {
    const splitter = createMultiCardSplitter({
      dataDir,
      enabled: true,
      fetchImpl: async () => jsonResponse({ cards: [] }, false),
    });
    const result = await splitter.splitPhoto(photoPath);
    assert.deepEqual(result, [photoPath]);
  });
});

test('splitPhoto writes crop files and returns those paths when 2+ cards are found', async () => {
  await withTempDir(async ({ dataDir, photoPath }) => {
    const splitter = createMultiCardSplitter({
      dataDir,
      enabled: true,
      fetchImpl: async () =>
        jsonResponse({
          cards: [
            { index: 0, crop_b64: CROP_B64 },
            { index: 1, crop_b64: CROP_B64 },
          ],
        }),
    });
    const result = await splitter.splitPhoto(photoPath);
    assert.equal(result.length, 2);
    assert.notEqual(result[0], photoPath);
    for (const cropPath of result) {
      assert.ok(existsSync(cropPath));
      assert.ok(cropPath.includes('split-crops'));
      assert.deepEqual(readFileSync(cropPath), TINY_JPEG);
    }
  });
});

test('splitRemoteUrl downloads and returns crop paths when 2+ cards are found', async () => {
  await withTempDir(async ({ dataDir }) => {
    const splitter = createMultiCardSplitter({
      dataDir,
      enabled: true,
      fetchImpl: async (url) => {
        if (String(url).includes('/detect-multi')) {
          return jsonResponse({
            cards: [
              { index: 0, crop_b64: CROP_B64 },
              { index: 1, crop_b64: CROP_B64 },
              { index: 2, crop_b64: CROP_B64 },
            ],
          });
        }
        return {
          ok: true,
          arrayBuffer: async () => TINY_JPEG,
        };
      },
    });
    const result = await splitter.splitRemoteUrl('https://cdn.example/lot.jpg');
    assert.equal(result.length, 3);
    for (const cropPath of result) {
      assert.ok(existsSync(cropPath));
    }
  });
});
