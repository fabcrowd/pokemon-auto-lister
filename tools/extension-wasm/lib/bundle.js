// The signed bundle: what the pipeline learned from everyone's contributions, used only when it was signed by the
// owner, was made for this build's CLIP model and crop, and the pipeline's gate said it improved.
//
// Nothing about the user is sent to fetch it: GETs of public files.
//
// FILES (all under one https origin; every asset url must share the manifest's origin)
//   manifest.json   JSON, the exact bytes that are signed
//   manifest.sig    base64 of a detached ECDSA P-256 / SHA-256 signature of the manifest.json bytes,
//                   raw r||s (64 bytes, the WebCrypto / IEEE P1363 form), in the same directory as manifest.json
//   <asset urls>    resolved against the manifest's address
//
// MANIFEST
//   { "v": 2, "model": "<first 16 hex of the CLIP model sha256>", "crop": <EMBEDDING_VERSION int>,
//     "seq": <int, the pipeline run number; only goes up>, "issuedAt": "<UTC YYYY-MM-DDTHH:MM:SSZ>",
//     "assets": { "memory"?: A, "adapter"?: A, "check"?: A, "catalogExtra"?: A },
//     "exam": {...}, "regression": {...}, "improved": <true only when the pipeline's gate passed> }
//   A = { "url": <https asset address>, "sha256": "<64 hex>", "bytes": <int> }
//   The bundle is keyed to the model and the crop only, never to the catalog. Each asset is optional on its own.
//   "exam" and "regression" are covered by the signature and not read here. A manifest with a lower seq than the
//   highest this device has accepted, or issued more than 30 days ago (or more than a day in the future), is stale
//   and refused, so an old signed manifest cannot be replayed. Each download is cut off at the size the manifest
//   declares (and at that asset's cap), while reading; manifest and signature at MAX_SMALL_BYTES.
//
// ASSETS (all integers little-endian; every file starts: uint32 H, then H bytes of UTF-8 header JSON)
//   memory        header { v:1, dim:512, entries:N, cardIds:[N ids] }, then N * dim int8, row-major, round(127 * x)
//                 of the L2-normalised embedding. Reference rows for the user-corrections path (references.js).
//   adapter       header { v:1, dim:512, rank:r, scale:s }, then U (dim*r int8) then V (dim*r int8), row-major;
//                 float = int8 * s. e' = normalize(e + U (Vt e)) for queries and catalog rows (adapter.js).
//   check         header { v:1, dim:512, bias:b, threshold:t }, then dim float32 weights. p = sigmoid(w.e + b) on the
//                 raw embedding of a detected box; the box is dropped when p < t.
//   catalogExtra  the memory layout plus header "cards": [{ id, name, set, setName, number, image }] parallel to
//                 cardIds. Rows are appended to the catalog, and the cards to the metadata.

import { adaptRows } from "./adapter.js";
import { EMBEDDING_DIM } from "./references.js";
import { sha256Hex } from "./setup.js";

const DAY_MS = 24 * 3600 * 1000;
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
export const MAX_SMALL_BYTES = 64 * 1024;
export const MAX_ADAPTER_RANK = 64;
const MAX_ENTRIES = 50000;
const MAX_HEADER = 32 * 1024 * 1024;
const MAX_MANIFEST_AGE_MS = 30 * DAY_MS;
const MAX_FUTURE_MS = DAY_MS;
const ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const INT8_SCALE = 1 / 127;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;

// The most each asset may be, whatever the manifest declares.
export const ASSET_CAPS = {
  memory: MAX_PACK_BYTES,
  catalogExtra: MAX_PACK_BYTES,
  adapter: 4 + 1024 + 2 * EMBEDDING_DIM * MAX_ADAPTER_RANK + 4096,
  check: 4 + 4096 + EMBEDDING_DIM * 4,
};
const ASSET_NAMES = Object.keys(ASSET_CAPS);

const fail = (status, detail) => ({ status, detail });

/** manifest.sig sits beside manifest.json. */
export const signatureUrl = (manifestUrl) => new URL("manifest.sig", manifestUrl).href;

function fromBase64(text) {
  const binary = atob(String(text).trim());
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** True when `signatureB64` (raw r||s) is the key's signature of `data`. Any malformed input is false. */
export async function verifySignature(data, signatureB64, publicKeyB64) {
  try {
    const key = await crypto.subtle.importKey("spki", fromBase64(publicKeyB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64(signatureB64), data);
  } catch {
    return false;
  }
}

// ─── asset parsers ───────────────────────────────────────────────────────────

/** The header JSON and where the body starts. */
function splitFile(bytes, what) {
  const file = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (file.length < 4) throw new Error(`${what} is too short`);
  const headerLength = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(0, true);
  if (headerLength > MAX_HEADER || 4 + headerLength > file.length) throw new Error(`${what} header runs past the end of the file`);
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(file.subarray(4, 4 + headerLength)));
  } catch {
    throw new Error(`${what} header is not JSON`);
  }
  if (!header || typeof header !== "object" || header.v !== 1 || header.dim !== EMBEDDING_DIM) throw new Error(`${what} header does not match this build`);
  return { file, header, bodyAt: 4 + headerLength };
}

function rowFile(bytes, what) {
  const { file, header, bodyAt } = splitFile(bytes, what);
  const { entries, cardIds } = header;
  if (!Number.isInteger(entries) || entries > MAX_ENTRIES || !Array.isArray(cardIds) || cardIds.length !== entries) throw new Error(`${what} entries do not match its card ids`);
  if (cardIds.some((id) => typeof id !== "string" || !id)) throw new Error(`${what} card ids must be non-empty strings`);
  if (file.length !== bodyAt + entries * EMBEDDING_DIM) throw new Error(`${what} size does not match its header`);
  return { file, header, bodyAt };
}

/** The rows of a memory file, as references referenceHit can read: int8 views scaled by 1/127. */
export function parsePack(bytes, manifest) {
  const { file, header, bodyAt } = rowFile(bytes, "pack");
  if (manifest.entries !== undefined && header.entries !== manifest.entries) throw new Error("pack entries do not match the manifest");
  return header.cardIds.map((cardId, i) => ({
    cardId,
    embedding: new Int8Array(file.buffer, file.byteOffset + bodyAt + i * EMBEDDING_DIM, EMBEDDING_DIM),
    scale: INT8_SCALE,
    v: manifest.crop,
  }));
}

/** { rank, u, v }: both matrices as Float32Array(dim * rank), already multiplied by the header's scale. */
export function parseAdapter(bytes) {
  const { file, header, bodyAt } = splitFile(bytes, "adapter");
  const { rank, scale } = header;
  if (!Number.isInteger(rank) || rank < 1 || rank > MAX_ADAPTER_RANK) throw new Error("adapter rank is out of range");
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) throw new Error("adapter scale must be a positive number");
  const count = EMBEDDING_DIM * rank;
  if (file.length !== bodyAt + 2 * count) throw new Error("adapter size does not match its header");
  const widen = (at) => Float32Array.from(new Int8Array(file.buffer, file.byteOffset + at, count), (x) => x * scale);
  return { rank, u: widen(bodyAt), v: widen(bodyAt + count) };
}

/** { weights, bias, threshold } of the "is this a card" check. */
export function parseCheck(bytes) {
  const { file, header, bodyAt } = splitFile(bytes, "check");
  const { bias, threshold } = header;
  if (typeof bias !== "number" || !Number.isFinite(bias)) throw new Error("check bias must be a finite number");
  if (typeof threshold !== "number" || !(threshold > 0 && threshold < 1)) throw new Error("check threshold must be between 0 and 1");
  if (file.length !== bodyAt + EMBEDDING_DIM * 4) throw new Error("check size does not match its header");
  const weights = new Float32Array(file.slice(bodyAt).buffer);
  if (weights.some((w) => !Number.isFinite(w))) throw new Error("check weights must be finite");
  return { weights, bias, threshold };
}

/** p that the crop embedded as `embedding` (raw, unadapted) is a card. */
export function cardProbability(embedding, check) {
  let z = check.bias;
  for (let d = 0; d < EMBEDDING_DIM; d++) z += check.weights[d] * embedding[d];
  return 1 / (1 + Math.exp(-z));
}

const text = (x) => typeof x === "string" && x.length > 0 && x.length <= 200;

/** { rows: Float32Array(n * dim) unit rows, meta: [n catalog entries] } of a catalogExtra file. */
export function parseCatalogExtra(bytes) {
  const { file, header, bodyAt } = rowFile(bytes, "catalogExtra");
  const { cardIds, cards } = header;
  if (!Array.isArray(cards) || cards.length !== cardIds.length) throw new Error("catalogExtra cards do not match its card ids");
  const meta = cards.map((card, i) => {
    if (!card || card.id !== cardIds[i] || !text(card.name) || !text(card.set) || !text(card.setName) || !text(card.number) || typeof card.image !== "string") {
      throw new Error("catalogExtra cards are malformed");
    }
    return { id: card.id, name: card.name, set: card.setName, setCode: card.set, number: card.number, game: "pokemon", imageUrl: card.image };
  });
  const rows = new Float32Array(cardIds.length * EMBEDDING_DIM);
  const ints = new Int8Array(file.buffer, file.byteOffset + bodyAt, rows.length);
  for (let i = 0; i < cardIds.length; i++) {
    let norm = 0;
    for (let d = 0; d < EMBEDDING_DIM; d++) norm += (ints[i * EMBEDDING_DIM + d] * INT8_SCALE) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < EMBEDDING_DIM; d++) rows[i * EMBEDDING_DIM + d] = (ints[i * EMBEDDING_DIM + d] * INT8_SCALE) / norm;
  }
  return { rows, meta };
}

/** The extra rows and cards the shipped catalog does not already have (matched by id), or null when none are new. */
export function mergeExtra(baseMeta, extra) {
  const known = new Set(baseMeta.map((card) => card.id));
  const keep = extra.meta.map((card, i) => i).filter((i) => !known.has(extra.meta[i].id));
  if (!keep.length) return null;
  const rows = new Float32Array(keep.length * EMBEDDING_DIM);
  keep.forEach((from, to) => rows.set(extra.rows.subarray(from * EMBEDDING_DIM, (from + 1) * EMBEDDING_DIM), to * EMBEDDING_DIM));
  return { rows, meta: keep.map((i) => extra.meta[i]) };
}

const PARSERS = {
  memory: (bytes, manifest) => parsePack(bytes, manifest),
  adapter: (bytes) => parseAdapter(bytes),
  check: (bytes) => parseCheck(bytes),
  catalogExtra: (bytes) => parseCatalogExtra(bytes),
};

// ─── manifest ────────────────────────────────────────────────────────────────

function manifestShapeError(m) {
  if (!m || typeof m !== "object" || m.v !== 2) return "manifest v must be 2";
  if (typeof m.model !== "string" || !HEX16.test(m.model) || !Number.isInteger(m.crop)) return "manifest model or crop is missing";
  if (!Number.isInteger(m.seq) || m.seq < 0) return "manifest seq is missing";
  if (typeof m.issuedAt !== "string" || !ISSUED_AT.test(m.issuedAt) || Number.isNaN(Date.parse(m.issuedAt))) return "manifest issuedAt is missing";
  if (!m.assets || typeof m.assets !== "object" || Array.isArray(m.assets)) return "manifest assets is missing";
  const names = Object.keys(m.assets);
  if (!names.length) return "manifest has no assets";
  for (const name of names) {
    const a = m.assets[name];
    if (!ASSET_NAMES.includes(name)) return `manifest asset ${name} is not known`;
    if (!a || typeof a.url !== "string" || typeof a.sha256 !== "string" || !SHA256_HEX.test(a.sha256)) return `manifest asset ${name} has no url or sha256`;
    if (!Number.isInteger(a.bytes) || a.bytes < 1) return `manifest asset ${name} has no size`;
    if (a.bytes > ASSET_CAPS[name]) return `manifest asset ${name} is too large`;
  }
  return null;
}

const sameBuild = (m, expected) => m.model === expected.model && m.crop === expected.crop;

const tooLarge = () => Object.assign(new Error("download is too large"), { tooLarge: true });

// Reads at most maxBytes: a declared length over the cap is refused up front, and a stream is cancelled the
// moment it passes the cap, so a hostile or broken host cannot make the extension buffer gigabytes.
const read = async (fetchFn, url, maxBytes) => {
  const response = await fetchFn(url, { credentials: "omit", cache: "no-store", redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  if (Number(response.headers?.get?.("content-length")) > maxBytes) throw tooLarge();
  if (!response.body?.getReader) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.length > maxBytes) throw tooLarge();
    return whole;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

const readFailure = (err) => (err.tooLarge ? fail("format", err.message) : fail("network", err.message));

/**
 * Fetches and checks the bundle. status is "ok" (then `manifest` and `assets`: name -> bytes, or null for a file
 * `has` says is already stored), or why it must not be used: inert, network, signature, format, mismatch,
 * stale, not-improved, sha. Any asset that fails fails the whole bundle.
 * @param expected { model, crop } of this build
 * @param has async (sha256) -> true when that file is already stored, so it is not downloaded again
 */
export async function fetchBundle({ manifestUrl, publicKey, expected, minSeq = 0, now = Date.now, has = async () => false, fetchFn = (...args) => fetch(...args) }) {
  if (!manifestUrl || !publicKey) return fail("inert");
  let manifestBytes;
  let signature;
  try {
    manifestBytes = await read(fetchFn, manifestUrl, MAX_SMALL_BYTES);
    signature = new TextDecoder().decode(await read(fetchFn, signatureUrl(manifestUrl), MAX_SMALL_BYTES));
  } catch (err) {
    return readFailure(err);
  }
  if (!(await verifySignature(manifestBytes, signature, publicKey))) return fail("signature");
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    return fail("format", "manifest is not JSON");
  }
  const shape = manifestShapeError(manifest);
  if (shape) return fail("format", shape);
  if (!sameBuild(manifest, expected)) return fail("mismatch");
  const age = now() - Date.parse(manifest.issuedAt);
  if (manifest.seq < minSeq || age > MAX_MANIFEST_AGE_MS || age < -MAX_FUTURE_MS) return fail("stale");
  if (manifest.improved !== true) return fail("not-improved");

  const origin = new URL(manifestUrl).origin;
  const urls = {};
  for (const [name, asset] of Object.entries(manifest.assets)) {
    try {
      urls[name] = new URL(asset.url, manifestUrl);
    } catch {
      return fail("format", `${name} url is not an address`);
    }
    if (urls[name].protocol !== "https:" || urls[name].origin !== origin) return fail("format", `${name} must be on the manifest's https origin`);
  }

  const assets = {};
  for (const [name, asset] of Object.entries(manifest.assets)) {
    if (await has(asset.sha256)) {
      assets[name] = null;
      continue;
    }
    let bytes;
    try {
      bytes = await read(fetchFn, urls[name].href, asset.bytes);
    } catch (err) {
      return readFailure(err);
    }
    if (bytes.length !== asset.bytes) return fail("format", `${name} is not the size the manifest says`);
    if ((await sha256Hex(bytes)) !== asset.sha256) return fail("sha", name);
    try {
      PARSERS[name](bytes, manifest);
    } catch (err) {
      return fail("format", err.message);
    }
    assets[name] = bytes;
  }
  return { status: "ok", manifest, assets };
}

const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/**
 * At most one check a day. A good bundle becomes the live one; only files whose sha256 changed are downloaded.
 * Any failure (network, signature, hash, format, not improved, stale) keeps what is stored, and a failed bundle
 * does not move the seq floor.
 * @param store the share store; state { get(), set(value) } remembers when the last check was made
 */
export async function checkBundle({ store, state, now = Date.now, ...fetching }) {
  if (!fetching.manifestUrl || !fetching.publicKey) return fail("inert");
  const last = await state.get();
  if (last && now() - last.at < DAY_MS) return fail("skipped");
  await state.set({ ...last, at: now() });
  const result = await fetchBundle({ ...fetching, minSeq: last?.seq ?? 0, now, has: async (sha) => Boolean(await store.getAsset(sha)) });
  if (result.status !== "ok") return result;
  const { manifest, assets } = result;
  const shas = Object.fromEntries(Object.entries(manifest.assets).map(([name, asset]) => [name, asset.sha256]));
  // Files first and the record last: until the record is replaced the previous bundle is still complete.
  for (const [name, bytes] of Object.entries(assets)) if (bytes) await store.putAsset(shas[name], toBuffer(bytes));
  await store.savePack({ manifest, shas });
  await store.pruneAssets(Object.values(shas));
  // Remembered even if the same bundle is already stored: the floor only ever goes up.
  await state.set({ at: now(), seq: Math.max(last?.seq ?? 0, manifest.seq) });
  return { status: "ok", manifest };
}

/**
 * The stored bundle's parts: { manifest, memory (rows) | null, adapter | null, check | null, extra | null }, or null
 * when there is none or it was made for other models. A stored file that no longer parses is skipped, not fatal.
 */
export async function loadStoredBundle(store, expected) {
  const record = await store.getPack();
  if (!record) return null;
  if (!record.manifest || !sameBuild(record.manifest, expected) || record.manifest.improved !== true) {
    await store.clearPack();
    await store.clearAssets();
    return null;
  }
  const out = { manifest: record.manifest, memory: null, adapter: null, check: null, extra: null };
  for (const name of ASSET_NAMES) {
    const sha = record.shas?.[name];
    if (!sha) continue;
    try {
      const stored = await store.getAsset(sha);
      if (!stored) continue;
      out[name === "catalogExtra" ? "extra" : name] = PARSERS[name](new Uint8Array(stored.bytes), record.manifest);
    } catch (err) {
      console.error(`[bundle] stored ${name} is unusable:`, err?.message || err);
    }
  }
  return out;
}

/**
 * The adapter applied to every row. Computed once per `key` (name what the result depends on: adapter sha,
 * extra sha, row count, catalog tag) and kept in the share store, so a worker restart reads it back.
 */
export async function adaptedRows({ store, key, rows, adapter }) {
  try {
    const stored = await store.getDerived(key);
    if (stored?.bytes?.byteLength === rows.length * 4) return new Float32Array(stored.bytes);
  } catch (err) {
    console.error("[bundle] adapted catalog cache unreadable:", err?.message || err);
  }
  const adapted = await adaptRows(rows, adapter);
  try {
    await store.putDerived(key, adapted.buffer);
  } catch (err) {
    console.error("[bundle] adapted catalog not cached:", err?.message || err);
  }
  return adapted;
}
