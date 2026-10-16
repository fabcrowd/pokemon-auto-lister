// Filled in by the owner at deploy. Each empty string keeps its feature switched off:
//   RELAY_URL          the relay that receives contributions (POST), https only. Empty: sharing is "Not available in this build".
//   PACK_MANIFEST_URL  the signed community pack's manifest.json (https). Empty: no pack is fetched.
//   PACK_PUBLIC_KEY    the pack signing key, ECDSA P-256 public key as base64 SPKI. Empty: no pack is trusted.
// The store build adds the origin of each non-empty URL to host_permissions (scripts/lib/store-package.mjs).

export const RELAY_URL = "";
export const PACK_MANIFEST_URL = "";
export const PACK_PUBLIC_KEY = "";
