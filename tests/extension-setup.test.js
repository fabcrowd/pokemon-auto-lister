import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { ASSETS, CACHE_NAME, assetUrl, checkModelsReady, downloadModels, downloadSizeText, missingAssets } from '../tools/extension-wasm/lib/setup.js';

const V20 = 'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/v2.0/';
const V30 = 'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/v3.0/';
const originOf = (name) => (name === 'clip_visual_int8.onnx' ? V30 : V20);
const V21 = 'https://github.com/fabcrowd/pokemon-auto-lister/releases/download/v2.1/';

let stores;
let stored;

// Honours cache names, like the real Cache API, so a download into the wrong cache is visible.
beforeEach(() => {
  stores = new Map();
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return {
      match: async (url) => (map.has(url) ? new Response(map.get(url)) : undefined),
      put: async (url, response) => { map.set(url, new Uint8Array(await response.arrayBuffer())); },
      delete: async (url) => map.delete(url),
    };
  };
  globalThis.caches = {
    open: async (name) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
  open(CACHE_NAME);
  stored = stores.get(CACHE_NAME);
});

function serve(bodies) {
  globalThis.fetch = async (url) => {
    const body = bodies[url];
    if (!body) return new Response('missing', { status: 404 });
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  };
}

test('the card finder comes from v2.1, the recognizer from v3.0 and the rest from v2.0', () => {
  assert.equal(assetUrl('card_detect.onnx'), V21 + 'card_detect.onnx');
  assert.equal(assetUrl('clip_visual_int8.onnx'), V30 + 'clip_visual_int8.onnx');
  assert.equal(assetUrl('meta.json'), V20 + 'meta.json');
});

test('the recognizer (clip v3) is pinned to its published hash and exact size', () => {
  const clip = ASSETS.find((a) => a.name === 'clip_visual_int8.onnx');
  assert.equal(clip.release, 'v3.0');
  assert.equal(clip.sha256, '0dba1302580da2a629936be835b765d6dba9019e677284257470d30070d9d52b');
  assert.equal(clip.bytes, 88_999_043);
});

test('an install that cached the old v2.0 recognizer is not ready and downloads only the v3.0 file', async () => {
  for (const name of ['clip_visual_int8.onnx', 'catalog.bin.gz', 'meta.json', 'id_map.json']) stored.set(V20 + name, new Uint8Array([1]));
  stored.set(V21 + 'card_detect.onnx', new Uint8Array([1]));
  assert.equal(await checkModelsReady(), false);
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    return new Response('x', { status: 500 });
  };
  await assert.rejects(downloadModels(), /clip_visual_int8/);
  assert.deepEqual(requested, [V30 + 'clip_visual_int8.onnx']);
});

test('a cache holding only the v2.0 finder is not ready', async () => {
  for (const name of ['clip_visual_int8.onnx', 'card_detect.onnx', 'catalog.bin.gz', 'meta.json', 'id_map.json']) {
    stored.set(originOf(name) + name, new Uint8Array([1]));
  }
  assert.equal(await checkModelsReady(), false);
});

test('a finder that does not match the published hash is not stored', async () => {
  const others = ['clip_visual_int8.onnx', 'catalog.bin.gz', 'meta.json', 'id_map.json'];
  for (const name of others) stored.set(originOf(name) + name, new Uint8Array([1]));
  serve({ [V21 + 'card_detect.onnx']: new Uint8Array([9, 9, 9]) });

  await assert.rejects(downloadModels(), /card_detect/);
  assert.equal(stored.has(V21 + 'card_detect.onnx'), false);
});

test('only the missing finder is downloaded when the other files are cached', async () => {
  const others = ['clip_visual_int8.onnx', 'catalog.bin.gz', 'meta.json', 'id_map.json'];
  for (const name of others) stored.set(originOf(name) + name, new Uint8Array([1]));
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    return new Response('x', { status: 500 });
  };

  await assert.rejects(downloadModels());
  assert.deepEqual(requested, [V21 + 'card_detect.onnx']);
});

const REQUIRED = { 'clip_visual_int8.onnx': V30, 'catalog.bin.gz': V20, 'meta.json': V20, 'id_map.json': V20, 'card_detect.onnx': V21 };
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

const V20_CLIP = V20 + 'clip_visual_int8.onnx';
const OTHER_FOUR = ['card_detect.onnx', 'catalog.bin.gz', 'meta.json', 'id_map.json'];

function seedV21Install() {
  stored.set(V20_CLIP, new Uint8Array([1]));
  for (const name of OTHER_FOUR) stored.set(REQUIRED[name] + name, new Uint8Array([1]));
}

function snapshot() {
  return [...stored.entries()].map(([url, bytes]) => [url, [...bytes]]).sort();
}

test('a v2.1p install holding the v2.0 recognizer is not ready, fetches only the v3.0 file and keeps the other four', async () => {
  seedV21Install();
  assert.equal(await checkModelsReady(), false);
  const clip = ASSETS.find((a) => a.name === 'clip_visual_int8.onnx');
  const body = new Uint8Array([3, 1, 4]);
  const requested = [];
  const original = clip.sha256;
  clip.sha256 = createHash('sha256').update(body).digest('hex');
  try {
    globalThis.fetch = async (url) => { requested.push(url); return new Response(body); };
    await downloadModels();
  } finally {
    clip.sha256 = original;
  }
  assert.deepEqual(requested, [V30 + 'clip_visual_int8.onnx']);
  for (const name of OTHER_FOUR) assert.equal(stored.has(REQUIRED[name] + name), true, name);
});

test('a failed v3.0 download leaves every cached file untouched', async () => {
  seedV21Install();
  const before = snapshot();
  serve({});
  await assert.rejects(downloadModels(), /HTTP 404/);
  assert.deepEqual(snapshot(), before);
});

test('a v3.0 download that fails its hash check leaves every cached file untouched', async () => {
  seedV21Install();
  const before = snapshot();
  serve({ [V30 + 'clip_visual_int8.onnx']: new Uint8Array([9, 9, 9]) });
  await assert.rejects(downloadModels(), /clip_visual_int8\.onnx is damaged/);
  assert.deepEqual(snapshot(), before);
});

test('after a verified v3.0 download only the stale v2.0 recognizer entry is removed', async () => {
  seedV21Install();
  const clip = ASSETS.find((a) => a.name === 'clip_visual_int8.onnx');
  const body = new Uint8Array([2, 7, 1]);
  const original = clip.sha256;
  clip.sha256 = createHash('sha256').update(body).digest('hex');
  try {
    serve({ [V30 + 'clip_visual_int8.onnx']: body });
    await downloadModels();
  } finally {
    clip.sha256 = original;
  }
  assert.equal(stored.has(V20_CLIP), false);
  assert.equal(stored.has(V30 + 'clip_visual_int8.onnx'), true);
  assert.deepEqual([...stored.keys()].sort(), [...OTHER_FOUR.map((n) => REQUIRED[n] + n), V30 + 'clip_visual_int8.onnx'].sort());
});

test('pruneOldCaches never removes the current cache, and the current cache is the v2.1p one upgrades keep', async () => {
  const { pruneOldCaches } = await import('../tools/extension-wasm/lib/setup.js');
  seedV21Install();
  await globalThis.caches.open('cardscanner-models-v2.1');
  await globalThis.caches.open('someone-elses-cache');
  await pruneOldCaches();
  assert.deepEqual([...stores.keys()].sort(), [CACHE_NAME, 'someone-elses-cache'].sort());
  assert.equal(CACHE_NAME, 'cardscanner-models-v2.1p');
  assert.equal(stored.has(V20_CLIP), true);
});

test('a real existing v2.1p user keeps their cache through startup and only gets the v3.0 recognizer', async () => {
  const { pruneOldCaches } = await import('../tools/extension-wasm/lib/setup.js');
  const LITERAL = 'cardscanner-models-v2.1p'; // deliberately not CACHE_NAME: a rename must fail here
  const userCache = await globalThis.caches.open(LITERAL);
  const userUrls = [V20_CLIP, ...OTHER_FOUR.map((n) => REQUIRED[n] + n)];
  for (const url of userUrls) await userCache.put(url, new Response(new Uint8Array([1])));

  await pruneOldCaches();
  assert.equal((await globalThis.caches.keys()).includes(LITERAL), true);
  const survivors = stores.get(LITERAL);
  for (const url of userUrls) assert.equal(survivors?.has(url), true, url);

  assert.equal(await checkModelsReady(), false);
  for (const name of OTHER_FOUR) assert.equal(survivors.has(REQUIRED[name] + name), true, name);
  assert.equal(survivors.has(V30 + 'clip_visual_int8.onnx'), false);

  const clip = ASSETS.find((a) => a.name === 'clip_visual_int8.onnx');
  const body = new Uint8Array([5, 5, 5]);
  const original = clip.sha256;
  const requested = [];
  clip.sha256 = createHash('sha256').update(body).digest('hex');
  try {
    globalThis.fetch = async (url) => { requested.push(url); return new Response(body); };
    await downloadModels();
  } finally {
    clip.sha256 = original;
  }
  assert.deepEqual(requested, [V30 + 'clip_visual_int8.onnx']);
  assert.equal(survivors.has(V20_CLIP), false);
  assert.deepEqual([...survivors.keys()].sort(), [...OTHER_FOUR.map((n) => REQUIRED[n] + n), V30 + 'clip_visual_int8.onnx'].sort());
  assert.equal(await checkModelsReady(), true);
});

test('the wizard quotes the size of what is actually missing', async () => {
  assert.deepEqual((await missingAssets()).map((a) => a.name), ASSETS.map((a) => a.name));
  for (const a of ASSETS) if (a.name !== 'clip_visual_int8.onnx') stored.set(assetUrl(a.name), new Uint8Array([1]));
  assert.deepEqual((await missingAssets()).map((a) => a.name), ['clip_visual_int8.onnx']);
  assert.equal(downloadSizeText(await missingAssets()), 'about 89 MB');
  assert.equal(downloadSizeText(), `about ${Math.round(ASSETS.reduce((n, a) => n + a.bytes, 0) / 1e6)} MB`);
  assert.equal(downloadSizeText([]), 'under 1 MB');
});
