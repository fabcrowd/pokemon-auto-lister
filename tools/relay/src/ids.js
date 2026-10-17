/** HMAC-SHA256(secret, install) as 16 hex digits: what the data repo stores in place of the raw install id. */
export async function hashInstall(secret, install) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(install)));
  return Array.from(mac.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The key an address is counted under. IPv6 users often hold a whole /64, so every address in it shares
 * one counter; an IPv4-mapped IPv6 address counts as its IPv4 address.
 */
export function ipBucket(ip) {
  if (!ip.includes(":")) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "") || "0").join(":")}::/64`;
}
