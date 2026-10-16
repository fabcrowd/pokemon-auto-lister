// Replaces lib/net.js in the sealed-test build only (scripts/build-wasm-extension.ps1 -Sealed).
// The scorer serves photos from 127.0.0.1, which the shipped check refuses on purpose, so the
// test build also accepts that one origin. Everything else goes through the shipped check.
import { publicHttpsUrl as shippedCheck } from "./net-shipped.js";

export { isPrivateHost } from "./net-shipped.js";

export function publicHttpsUrl(raw, base) {
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password) return url;
  return shippedCheck(raw, base);
}
