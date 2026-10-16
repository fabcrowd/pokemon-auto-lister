import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { assetUrl, checkModelsReady, downloadModels } from '../tools/extension-wasm/lib/setup.js';

const V20 = 'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/v2.0/';
const V21 = 'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/v2.1/';

let stored;

beforeEach(() => {
  stored = new Map();
  globalThis.caches = {
    open: async () => ({
      match: async (url) => (stored.has(url) ? new Response(stored.get(url)) : undefined),
      put: async (url, response) => { stored.set(url, new Uint8Array(await response.arrayBuffer())); },
    }),
  };
});

function serve(bodies) {
  globalThis.fetch = async (url) => {
    const body = bodies[url];
    if (!body) return new Response('missing', { status: 404 });
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  };
}

test('the card finder comes from v2.1 and the rest from v2.0', () => {
  assert.equal(assetUrl('card_detect.onnx'), V21 + 'card_detect.onnx');
  assert.equal(assetUrl('clip_visual_int8.onnx'), V20 + 'clip_visual_int8.onnx');
  assert.equal(assetUrl('meta.json'), V20 + 'meta.json');
});

test('a cache holding only the v2.0 finder is not ready', async () => {
  for (const name of ['clip_visual_int8.onnx', 'card_detect.onnx', 'catalog.bin.gz', 'meta.json', 'id_map.json']) {
    stored.set(V20 + name, new Uint8Array([1]));
  }
  assert.equal(await checkModelsReady(), false);
});

test('a finder that does not match the published hash is not stored', async () => {
  const others = ['clip_visual_int8.onnx', 'catalog.bin.gz', 'meta.json', 'id_map.json'];
  for (const name of others) stored.set(V20 + name, new Uint8Array([1]));
  serve({ [V21 + 'card_detect.onnx']: new Uint8Array([9, 9, 9]) });

  await assert.rejects(downloadModels(), /card finder/);
  assert.equal(stored.has(V21 + 'card_detect.onnx'), false);
});

test('only the missing finder is downloaded when the other files are cached', async () => {
  const others = ['clip_visual_int8.onnx', 'catalog.bin.gz', 'meta.json', 'id_map.json'];
  for (const name of others) stored.set(V20 + name, new Uint8Array([1]));
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    return new Response('x', { status: 500 });
  };

  await assert.rejects(downloadModels());
  assert.deepEqual(requested, [V21 + 'card_detect.onnx']);
});

const REQUIRED = { 'clip_visual_int8.onnx': V20, 'catalog.bin.gz': V20, 'meta.json': V20, 'id_map.json': V20, 'card_detect.onnx': V21 };
const V22 = 'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/v2.2/';

test('the number reader is optional: setup is ready and complete without it', async () => {
  for (const [name, base] of Object.entries(REQUIRED)) stored.set(base + name, new Uint8Array([1]));
  const requested = [];
  globalThis.fetch = async (url) => { requested.push(url); return new Response('x', { status: 404 }); };

  assert.equal(await checkModelsReady(), true);
  await downloadModels();
  assert.deepEqual(requested, []);
});

test('a missing or damaged optional file gives nothing and is not stored', async () => {
  const { getOptionalAsset } = await import('../tools/extension-wasm/lib/setup.js');
  serve({});
  assert.equal(await getOptionalAsset('ocr_det.onnx'), null);
  serve({ [V22 + 'ocr_det.onnx']: new Uint8Array([9, 9]) });
  assert.equal(await getOptionalAsset('ocr_det.onnx'), null);
  assert.equal(stored.has(V22 + 'ocr_det.onnx'), false);
});

test('a cached optional file is used without downloading', async () => {
  const { getOptionalAsset } = await import('../tools/extension-wasm/lib/setup.js');
  stored.set(V22 + 'ocr_rec.onnx', new Uint8Array([4, 5]));
  globalThis.fetch = async () => { throw new Error('should not download'); };
  const buffer = await getOptionalAsset('ocr_rec.onnx');
  assert.deepEqual(new Uint8Array(buffer), new Uint8Array([4, 5]));
});

test('sha256 of a downloaded file is compared in lowercase hex', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const expected = createHash('sha256').update(body).digest('hex');
  const { sha256Hex } = await import('../tools/extension-wasm/lib/setup.js');
  assert.equal(await sha256Hex(body), expected);
});

test('every downloaded file is pinned to a sha256', async () => {
  const { ASSETS, OPTIONAL_ASSETS } = await import('../tools/extension-wasm/lib/setup.js');
  for (const asset of [...ASSETS, ...OPTIONAL_ASSETS]) {
    assert.match(asset.sha256 ?? '', /^[0-9a-f]{64}$/, asset.name);
  }
});

test('a required file whose bytes do not match its pin is rejected and not stored', async () => {
  const { ASSETS } = await import('../tools/extension-wasm/lib/setup.js');
  for (const asset of ASSETS) {
    stored.clear();
    const url = assetUrl(asset.name);
    for (const other of ASSETS.filter((a) => a !== asset)) stored.set(assetUrl(other.name), new Uint8Array([1]));
    serve({ [url]: new Uint8Array([6, 6, 6]) });
    await assert.rejects(downloadModels(), /damaged/, asset.name);
    assert.equal(stored.has(url), false, asset.name);
  }
});

test('an optional file whose bytes match its pin is stored', async () => {
  const { getOptionalAsset, OPTIONAL_ASSETS } = await import('../tools/extension-wasm/lib/setup.js');
  // The real files are tens of MB; this checks the accept path with the pin swapped for a known body.
  const body = new Uint8Array([7, 7, 7]);
  const asset = OPTIONAL_ASSETS[0];
  const original = asset.sha256;
  asset.sha256 = createHash('sha256').update(body).digest('hex');
  try {
    serve({ [assetUrl(asset.name)]: body });
    assert.deepEqual(new Uint8Array(await getOptionalAsset(asset.name)), body);
    assert.equal(stored.has(assetUrl(asset.name)), true);
  } finally {
    asset.sha256 = original;
  }
});
