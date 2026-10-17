// Filled in by the owner at deploy. Each empty string keeps its feature switched off:
//   RELAY_URL          the relay that receives contributions (POST), https only. Empty: sharing is "Not available in this build".
//   PACK_MANIFEST_URL  the signed community pack's manifest.json (https). Empty: no pack is fetched.
//   PACK_PUBLIC_KEY    the pack signing key, ECDSA P-256 public key as base64 SPKI. Empty: no pack is trusted.
// The store build adds the origin of each non-empty URL to host_permissions (scripts/lib/store-package.mjs).

export const RELAY_URL = "https://card-scanner-relay.fabcrowd.workers.dev/v1/contributions";
export const PACK_MANIFEST_URL = "https://github.com/fabcrowd/card-scanner-data/releases/latest/download/manifest.json";
export const PACK_PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYB9mRPR+1EEbhhjN0J/jW7O1dC5u0zFAKJ8K/BldEQdexjtksgxQK+xIA/C4JDZgHxleMomi8BBgWHjHKvL7yw==";
