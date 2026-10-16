// The community pack: reference embeddings the pipeline built from everyone's contributions, used only
// when it was signed by the owner, was made for this build's models, and scored better on held-out exam photos.
//
// Nothing about the user is sent to fetch it: two GETs of public files.
//
// FILES (all under one https origin; the pack URL must share the manifest's origin)
//   manifest.json   JSON, the exact bytes that are signed
//   manifest.sig    base64 of a detached ECDSA P-256 / SHA-256 signature of the manifest.json bytes,
//                   raw r||s (64 bytes, the WebCrypto / IEEE P1363 form), in the same directory as manifest.json
//   <manifest.url>  the pack, resolved against the manifest's address
//
// MANIFEST
//   { "v": 1,
//     "model": "<first 16 hex of the CLIP model sha256>",  "catalog": "<first 16 hex of the catalog sha256>",
//     "crop": <EMBEDDING_VERSION int>,  "entries": <int>,  "dim": 512,
//     "sha256": "<64 hex of the pack file>",  "url": "<pack file address>",
//     "exam": { "before": <score>, "after": <score>, "n": <exam cards> },
//     "improved": <true only when exam.after beat exam.before> }
//
// PACK FILE (all integers little-endian)
//   offset 0      uint32  H, the byte length of the header JSON
//   offset 4      H bytes UTF-8 JSON  { "v": 1, "dim": 512, "entries": N, "cardIds": [N catalog ids] }
//   offset 4+H    N * dim int8, row-major. Row i belongs to cardIds[i]: round(127 * x) for each component x of the
//                 L2-normalised float embedding, clamped to -127..127. The file is exactly 4 + H + N * dim bytes.

import { EMBEDDING_DIM } from "./references.js";
import { sha256Hex } from "./setup.js";

const DAY_MS = 24 * 3600 * 1000;
const INT8_SCALE = 1 / 127;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

/** The rows of a pack file, as references referenceHit can read: int8 views scaled by 1/127. */
export function parsePack(bytes, manifest) {
  const file = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (file.length < 4) throw new Error("pack is too short");
  const headerLength = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(0, true);
  if (4 + headerLength > file.length) throw new Error("pack header runs past the end of the file");
  const header = JSON.parse(new TextDecoder().decode(file.subarray(4, 4 + headerLength)));
  const { dim, entries, cardIds } = header;
  if (header.v !== 1 || dim !== EMBEDDING_DIM || dim !== manifest.dim) throw new Error("pack header does not match this build");
  if (!Number.isInteger(entries) || entries !== manifest.entries || !Array.isArray(cardIds) || cardIds.length !== entries) {
    throw new Error("pack entries do not match the manifest");
  }
  if (cardIds.some((id) => typeof id !== "string" || !id)) throw new Error("pack card ids must be non-empty strings");
  if (file.length !== 4 + headerLength + entries * dim) throw new Error("pack size does not match its header");
  const base = file.byteOffset + 4 + headerLength;
  return cardIds.map((cardId, i) => ({
    cardId,
    embedding: new Int8Array(file.buffer, base + i * dim, dim),
    scale: INT8_SCALE,
    v: manifest.crop,
  }));
}

const manifestShapeError = (m) => {
  if (!m || typeof m !== "object" || m.v !== 1) return "manifest v must be 1";
  if (typeof m.model !== "string" || typeof m.catalog !== "string" || !Number.isInteger(m.crop)) return "manifest model, catalog or crop is missing";
  if (!Number.isInteger(m.entries) || m.entries < 1 || m.dim !== EMBEDDING_DIM) return "manifest entries or dim is wrong";
  if (typeof m.sha256 !== "string" || !SHA256_HEX.test(m.sha256) || typeof m.url !== "string") return "manifest sha256 or url is missing";
  return null;
};

const sameBuild = (m, expected) => m.model === expected.model && m.catalog === expected.catalog && m.crop === expected.crop;

const read = async (fetchFn, url) => {
  const response = await fetchFn(url, { credentials: "omit", cache: "no-store", redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * Fetches and checks the pack. status is "ok" (then `manifest` and `bytes`), or why it must not be used:
 * inert, network, signature, format, mismatch, not-improved, sha.
 * @param expected { model, catalog, crop } of this build
 */
export async function fetchCommunityPack({ manifestUrl, publicKey, expected, fetchFn = (...args) => fetch(...args) }) {
  if (!manifestUrl || !publicKey) return fail("inert");
  let manifestBytes;
  let signature;
  try {
    manifestBytes = await read(fetchFn, manifestUrl);
    signature = new TextDecoder().decode(await read(fetchFn, signatureUrl(manifestUrl)));
  } catch (err) {
    return fail("network", err.message);
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
  if (manifest.improved !== true) return fail("not-improved");
  let packUrl;
  try {
    packUrl = new URL(manifest.url, manifestUrl);
  } catch {
    return fail("format", "manifest url is not an address");
  }
  if (packUrl.protocol !== "https:" || packUrl.origin !== new URL(manifestUrl).origin) return fail("format", "pack must be on the manifest's https origin");
  let bytes;
  try {
    bytes = await read(fetchFn, packUrl.href);
  } catch (err) {
    return fail("network", err.message);
  }
  if ((await sha256Hex(bytes)) !== manifest.sha256) return fail("sha");
  try {
    parsePack(bytes, manifest);
  } catch (err) {
    return fail("format", err.message);
  }
  return { status: "ok", manifest, bytes };
}

/**
 * At most one check a day. A good pack replaces the stored one; a pack that no longer fits this build or no longer
 * improved the exam score removes it. A failed check (network, signature, hash) keeps what is stored.
 * @param store the share store; state { get(), set(value) } remembers when the last check was made
 */
export async function checkCommunityPack({ store, state, now = Date.now, ...fetching }) {
  if (!fetching.manifestUrl || !fetching.publicKey) return fail("inert");
  const last = await state.get();
  if (last && now() - last.at < DAY_MS) return fail("skipped");
  await state.set({ at: now() });
  const result = await fetchCommunityPack(fetching);
  if (result.status === "ok") {
    const stored = await store.getPack();
    if (stored?.sha256 !== result.manifest.sha256) {
      await store.savePack({ sha256: result.manifest.sha256, manifest: result.manifest, bytes: result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) });
    }
  } else if (result.status === "mismatch" || result.status === "not-improved") {
    await store.clearPack();
  }
  return result.status === "ok" ? { status: "ok", manifest: result.manifest } : result;
}

/** The stored pack's rows, or [] when there is none or it was made for other models. */
export async function loadStoredPack(store, expected) {
  const pack = await store.getPack();
  if (!pack) return [];
  if (!sameBuild(pack.manifest ?? {}, expected) || pack.manifest.improved !== true) {
    await store.clearPack();
    return [];
  }
  return parsePack(pack.bytes, pack.manifest);
}
