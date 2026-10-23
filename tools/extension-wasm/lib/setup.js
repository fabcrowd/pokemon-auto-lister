// Model download + cache management.
// All model files are fetched from GitHub Releases and stored in the Cache API.

const RELEASES =
  "https://github.com/fabcrowd/pokemon-auto-lister/releases/download/";

// The "p" marks a cache whose files were all checked against a pinned hash. Caches from builds that did not
// check (older names) are deleted by pruneOldCaches, so those files are downloaded and verified once.
// Do not rename this when one file moves to a new release: files are cached by URL, so only that file is
// downloaded, and renaming would make pruneOldCaches delete every working model before the new one is verified.
export const CACHE_NAME = "cardscanner-models-v2.1p";

// Superseded URLs, removed only after the file that replaces them is downloaded and hash-checked.
const STALE_URLS = {
  "clip_visual_int8.onnx": [RELEASES + "v2.0/clip_visual_int8.onnx"],
};

export async function pruneOldCaches() {
  for (const name of await caches.keys()) {
    if (name.startsWith("cardscanner-models-") && name !== CACHE_NAME) await caches.delete(name);
  }
}

// Files are cached by URL, so moving one file to a new release downloads only
// that file for people who already have the rest.
export const ASSETS = [
  {
    name: "clip_visual_int8.onnx",
    bytes: 88_999_043,
    release: "v3.0",
    sha256: "0dba1302580da2a629936be835b765d6dba9019e677284257470d30070d9d52b",
  },
  {
    name: "card_detect.onnx",
    bytes: 10_606_263,
    release: "v2.1",
    sha256: "5e17ae58b25843be1ee19f5dce4e0e5981a23411564a69eb633bb0694d582ac5",
  },
  {
    name: "catalog.bin.gz",
    bytes: 42_200_000,
    release: "v2.0",
    sha256: "2f3c50cec84937ff63ae5196da040e441599a5df6f28de829db79dd2b2dd7e13",
  },
  {
    name: "meta.json",
    bytes: 4_800_000,
    release: "v2.0",
    sha256: "5febdc04fa74a456b80f6f322bc58fd22f1c4bb5e685abda3c50a12edfd88866",
  },
  {
    name: "id_map.json",
    bytes: 234_000,
    release: "v2.0",
    sha256: "2d60e5a300369d36bd512d750819eb720c470f1a58bce3018cfef320aeee335f",
  },
];

// Fetched in the background after setup; scanning works without them.
export const OPTIONAL_ASSETS = [
  {
    name: "ocr_det.onnx",
    release: "v2.2",
    sha256: "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9",
  },
  {
    name: "ocr_rec.onnx",
    release: "v2.2",
    sha256: "48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b",
  },
];

export function assetUrl(name) {
  const asset = [...ASSETS, ...OPTIONAL_ASSETS].find((a) => a.name === name);
  if (!asset) throw new Error(`Unknown model file: ${name}`);
  return RELEASES + asset.release + "/" + name;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The assets not yet in the cache, so the wizard quotes what will really download. */
export async function missingAssets() {
  const cache = await caches.open(CACHE_NAME);
  const missing = [];
  for (const asset of ASSETS) {
    if (!(await cache.match(assetUrl(asset.name)))) missing.push(asset);
  }
  return missing;
}

/** "about 89 MB" for the given assets (all of ASSETS when none are given). */
export function downloadSizeText(assets = ASSETS) {
  const mb = Math.round(assets.reduce((sum, a) => sum + a.bytes, 0) / 1_000_000);
  return mb < 1 ? "under 1 MB" : `about ${mb} MB`;
}

export async function checkModelsReady() {
  const cache = await caches.open(CACHE_NAME);
  for (const asset of ASSETS) {
    const hit = await cache.match(assetUrl(asset.name));
    if (!hit) return false;
  }
  return true;
}

/**
 * Download all model assets into the Cache API.
 * onProgress is called with { file, fileIndex, fileDone, totalFiles, bytesLoaded, bytesTotal }
 * for each chunk received.
 */
export async function downloadModels(onProgress) {
  const cache = await caches.open(CACHE_NAME);
  const totalFiles = ASSETS.length;

  for (let i = 0; i < ASSETS.length; i++) {
    const asset = ASSETS[i];
    const url = assetUrl(asset.name);

    // Skip if already cached
    const existing = await cache.match(url);
    if (existing) {
      onProgress?.({
        file: asset.name,
        fileIndex: i,
        fileDone: true,
        totalFiles,
        bytesLoaded: asset.bytes,
        bytesTotal: asset.bytes,
      });
      continue;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${asset.name}: HTTP ${response.status}`);
    }

    // Stream the response so we can report progress
    const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
    const bytesTotal = contentLength || asset.bytes;
    let bytesLoaded = 0;

    const chunks = [];
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytesLoaded += value.byteLength;
      onProgress?.({
        file: asset.name,
        fileIndex: i,
        fileDone: false,
        totalFiles,
        bytesLoaded,
        bytesTotal,
      });
    }

    // Reassemble and store in cache
    const blob = new Blob(chunks);
    const actual = await sha256Hex(await blob.arrayBuffer());
    if (actual !== asset.sha256) {
      throw new Error(`The download of ${asset.name} is damaged. Try again.`);
    }
    const cachedResponse = new Response(blob, {
      headers: { "content-type": _contentType(asset.name) },
    });
    await cache.put(url, cachedResponse);
    for (const stale of STALE_URLS[asset.name] ?? []) await cache.delete(stale);

    onProgress?.({
      file: asset.name,
      fileIndex: i,
      fileDone: true,
      totalFiles,
      bytesLoaded,
      bytesTotal,
    });
  }
}

/** Return a cached asset as an ArrayBuffer. */
export async function getAssetBuffer(name) {
  const cache = await caches.open(CACHE_NAME);
  const response = await cache.match(assetUrl(name));
  if (!response) throw new Error(`Asset not in cache: ${name}`);
  return response.arrayBuffer();
}

/** An optional asset from the cache, downloading it if needed; null when unavailable. */
export async function getOptionalAsset(name) {
  const asset = OPTIONAL_ASSETS.find((a) => a.name === name);
  const url = assetUrl(name);
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    if ((await sha256Hex(bytes)) !== asset.sha256) return null;
    await cache.put(url, new Response(bytes, { headers: { "content-type": _contentType(name) } }));
    return bytes;
  } catch {
    return null;
  }
}

/** Return a cached asset as parsed JSON. */
export async function getAssetJson(name) {
  const cache = await caches.open(CACHE_NAME);
  const response = await cache.match(assetUrl(name));
  if (!response) throw new Error(`Asset not in cache: ${name}`);
  return response.json();
}

function _contentType(name) {
  if (name.endsWith(".onnx"))    return "application/octet-stream";
  if (name.endsWith(".bin.gz"))  return "application/gzip";
  if (name.endsWith(".json"))    return "application/json";
  return "application/octet-stream";
}
