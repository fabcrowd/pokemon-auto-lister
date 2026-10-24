import { readConfig } from "./config.js";
import { hashInstall, ipBucket } from "./ids.js";
import { validateBatch } from "./validate.js";

export const MAX_BODY_BYTES = 1_048_576;
const PATH = "/v1/contributions";
// A running count of items waiting in R2, kept in KV; the hourly cron decrements it and corrects any drift.
export const PENDING_COUNT_KEY = "pending:count";

const DAY_TTL = 60 * 60 * 26;
const HOUR_TTL = 60 * 70;

function cors(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function reply(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", ...(body === null ? {} : { "content-type": "application/json" }), ...headers },
  });
}

/** The request's origin when it is an allowed chrome-extension, else null. */
function allowedOrigin(request, config) {
  const origin = request.headers.get("origin");
  const match = origin && /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return match && config.allowedExtensionIds.includes(match[1]) ? origin : null;
}

/** Reads the body but gives up as soon as it passes the cap. Returns null when it is too big. */
async function readCapped(request, cap) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function count(kv, key) {
  const v = Number(await kv.get(key));
  return Number.isFinite(v) ? v : 0;
}

// KV has no atomic increment, so these limits are approximate under concurrent requests. They exist to
// stop floods and runaway clients, not to be exact.
const secondsUntilNextHour = (now) => 3600 - (Math.floor(now.getTime() / 1000) % 3600);
const secondsUntilNextDay = (now) => 86400 - (Math.floor(now.getTime() / 1000) % 86400);

/**
 * @param {Request} request
 * @param {object} env  Worker bindings and vars (see wrangler.toml)
 * @param {{now?: () => Date, randomUUID?: () => string}} [deps]
 */
export async function handleRequest(request, env, deps = {}) {
  const now = (deps.now || (() => new Date()))();
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());

  let config;
  try {
    config = readConfig(env);
  } catch (err) {
    console.error(err.message);
    return reply(500, { error: "server error" });
  }

  const url = new URL(request.url);
  if (url.pathname !== PATH) return reply(404, { error: "not found" });

  const origin = allowedOrigin(request, config);
  if (!origin) return reply(403, { error: "origin not allowed" });
  const headers = cors(origin);

  if (request.method === "OPTIONS") return reply(204, null, headers);
  if (request.method !== "POST") return reply(405, { error: "method not allowed" }, { ...headers, allow: "POST, OPTIONS" });

  const ip = ipBucket(request.headers.get("cf-connecting-ip") || "unknown");
  const ipKey = `ip:${ip}:${now.toISOString().slice(0, 13)}`;
  const ipCount = await count(config.rate, ipKey);
  if (ipCount + 1 > config.requestsPerIpHour) {
    return reply(429, { error: "too many requests" }, { ...headers, "retry-after": String(secondsUntilNextHour(now)) });
  }
  await config.rate.put(ipKey, String(ipCount + 1), { expirationTtl: HOUR_TTL });

  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, { error: "body too large" }, headers);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: "body is not valid JSON" }, headers);
  }
  const valid = validateBatch(body, { now });
  if (!valid.ok) return reply(400, { error: valid.error }, headers);

  const day = now.toISOString().slice(0, 10);
  const stamp = now.toISOString();
  const items = [];
  for (const item of body.contributions) items.push({ ...item, install: await hashInstall(config.idSecret, item.install), received: day });

  const retry = (seconds) => ({ ...headers, "retry-after": String(seconds) });
  const totalCards = items.reduce((n, item) => n + item.cards.length, 0);
  const ipCardsKey = `ipc:${ip}:${day}`;
  const ipCards = await count(config.rate, ipCardsKey);
  if (ipCards + totalCards > config.ipCardsPerDay) return reply(429, { error: "daily card limit reached" }, retry(secondsUntilNextDay(now)));

  const perInstall = new Map();
  for (const item of items) perInstall.set(item.install, (perInstall.get(item.install) || 0) + item.cards.length);
  const used = new Map();
  for (const [install, cards] of perInstall) {
    const key = `inst:${install}:${day}`;
    const before = await count(config.rate, key);
    if (before + cards > config.cardsPerInstallDay) return reply(429, { error: "daily card limit reached" }, retry(secondsUntilNextDay(now)));
    used.set(key, before + cards);
  }

  const waiting = await count(config.rate, PENDING_COUNT_KEY);
  if (waiting + items.length > config.maxPending) return reply(503, { error: "busy, try later" }, retry(3600));

  for (const item of items) await config.pending.put(`pending/${stamp}-${randomUUID()}.json`, JSON.stringify(item));
  for (const [key, total] of used) await config.rate.put(key, String(total), { expirationTtl: DAY_TTL });
  await config.rate.put(ipCardsKey, String(ipCards + totalCards), { expirationTtl: DAY_TTL });
  await config.rate.put(PENDING_COUNT_KEY, String(waiting + items.length));

  return reply(200, { accepted: items.length }, headers);
}
