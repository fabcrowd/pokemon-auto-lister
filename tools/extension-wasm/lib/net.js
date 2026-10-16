/** True for loopback, link-local, private, and local-only names. */
export function isPrivateHost(host) {
  const raw = String(host || "").toLowerCase().replace(/\.$/, "");
  const value = raw.replace(/^\[|\]$/g, "");
  if (!value || value === "localhost" || value.endsWith(".localhost")) return true;
  if (value.endsWith(".local") || value.endsWith(".lan") || value.endsWith(".internal")) return true;
  if (value === "::" || value === "::1" || value === "0.0.0.0") return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(value) || value.startsWith("fe80:") || value.startsWith("fec0:")) return true;
  const mapped = value.match(/^::ffff:(.+)$/);
  if (mapped) return isMappedIPv4(mapped[1]);
  const ipv4 = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  return isPrivateIPv4((((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0);
}

function isMappedIPv4(mapped) {
  if (mapped.includes(".")) return isPrivateHost(mapped);
  if (!/^[0-9a-f]{1,8}$/.test(mapped)) return true;
  return isPrivateIPv4(Number.parseInt(mapped, 16) >>> 0);
}

function isPrivateIPv4(n) {
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  const c = (n >>> 8) & 255;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 is multicast; 240.0.0.0/4 is reserved and holds the broadcast address.
  return a >= 224;
}

/** An https URL with no credentials and a public host, or null. */
export function publicHttpsUrl(raw, base) {
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHost(url.hostname)) return null;
  return url;
}
