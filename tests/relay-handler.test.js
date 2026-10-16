/* global Request */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../tools/relay/src/handler.js";
import { readConfig } from "../tools/relay/src/config.js";
import { fakeKV, fakeR2 } from "../tools/relay/test/fakes.js";
import { contribution, card } from "../tools/relay/test/builders.js";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXT}`;

function setup(over = {}) {
  const env = {
    GITHUB_TOKEN: "t",
    DATA_REPO: "owner/data",
    DATA_BRANCH: "main",
    ALLOWED_EXTENSION_IDS: EXT,
    PENDING: fakeR2(),
    RATE: fakeKV(),
    ...over,
  };
  let n = 0;
  const deps = { now: () => new Date("2026-10-15T12:34:00Z"), randomUUID: () => `uuid-${++n}` };
  return { env, deps };
}

const post = (body, { origin = ORIGIN, ip = "1.2.3.4", headers = {} } = {}) =>
  new Request("https://relay.example/v1/contributions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), "cf-connecting-ip": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("a valid batch is accepted and stored under pending/<day>/<uuid>.json", async () => {
  const { env, deps } = setup();
  const items = [contribution(), contribution({ photoId: "00000000000000a2", day: "2026-10-14" })];
  const res = await handleRequest(post({ v: 1, contributions: items }), env, deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: 2 });
  assert.deepEqual([...env.PENDING.map.keys()].sort(), ["pending/2026-10-14/uuid-2.json", "pending/2026-10-15/uuid-1.json"]);
  assert.deepEqual(JSON.parse(env.PENDING.map.get("pending/2026-10-15/uuid-1.json")), items[0]);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
});

test("validation failures answer 400 and store nothing", async () => {
  const { env, deps } = setup();
  const cases = [
    { v: 1, contributions: [contribution({ v: 2 })] },
    { v: 1, contributions: [contribution({ split: "exam" })] },
    { v: 1, contributions: [contribution({ cards: [card({ crop: Buffer.from("not a jpeg").toString("base64") })] })] },
    { v: 1, contributions: [contribution({ cards: [card({ box: [0, 0, 2, 1] })] })] },
    { v: 1, contributions: [contribution({ extra: true })] },
    { v: 1, contributions: [] },
    { v: 1, contributions: Array.from({ length: 21 }, () => contribution()) },
    "{not json",
    "[]",
  ];
  for (const body of cases) {
    const res = await handleRequest(post(body), env, deps);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.ok((await res.json()).error);
  }
  assert.equal(env.PENDING.map.size, 0);
});

test("a body over 1 MB answers 413", async () => {
  const { env, deps } = setup();
  const big = JSON.stringify({ v: 1, contributions: [], pad: "x".repeat(1_048_577) });
  const res = await handleRequest(post(big), env, deps);
  assert.equal(res.status, 413);
});

test("a lying content-length over 1 MB answers 413 before reading", async () => {
  const { env, deps } = setup();
  const res = await handleRequest(post({ v: 1, contributions: [contribution()] }, { headers: { "content-length": "2000000" } }), env, deps);
  assert.equal(res.status, 413);
});

test("only the allowed chrome-extension origin gets in", async () => {
  const { env, deps } = setup();
  for (const origin of ["https://evil.example", "chrome-extension://ppppppppppppppppppppppppppppppp", "chrome-extension://" + "a".repeat(32), null]) {
    const res = await handleRequest(post({ v: 1, contributions: [contribution()] }, { origin }), env, deps);
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(env.PENDING.map.size, 0);
});

test("several allowed extension ids are accepted", async () => {
  const other = "p".repeat(32);
  const { env, deps } = setup({ ALLOWED_EXTENSION_IDS: `${EXT}, ${other}` });
  const res = await handleRequest(post({ v: 1, contributions: [contribution()] }, { origin: `chrome-extension://${other}` }), env, deps);
  assert.equal(res.status, 200);
});

test("preflight answers 204 with CORS headers for an allowed origin and 403 otherwise", async () => {
  const { env, deps } = setup();
  const pre = (origin) => new Request("https://relay.example/v1/contributions", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
  const ok = await handleRequest(pre(ORIGIN), env, deps);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(ok.headers.get("access-control-allow-methods"), /POST/);
  assert.match(ok.headers.get("access-control-allow-headers"), /content-type/i);
  const no = await handleRequest(pre("https://evil.example"), env, deps);
  assert.equal(no.status, 403);
  assert.equal(no.headers.get("access-control-allow-origin"), null);
});

test("unknown paths and methods", async () => {
  const { env, deps } = setup();
  const notFound = await handleRequest(new Request("https://relay.example/other", { method: "POST", headers: { origin: ORIGIN } }), env, deps);
  assert.equal(notFound.status, 404);
  const wrongMethod = await handleRequest(new Request("https://relay.example/v1/contributions", { method: "GET", headers: { origin: ORIGIN } }), env, deps);
  assert.equal(wrongMethod.status, 405);
});

test("an install over its daily card limit gets 429 with Retry-After", async () => {
  const { env, deps } = setup({ CARDS_PER_INSTALL_DAY: "5" });
  const five = contribution({ cards: Array.from({ length: 5 }, () => card()) });
  assert.equal((await handleRequest(post({ v: 1, contributions: [five] }), env, deps)).status, 200);
  const res = await handleRequest(post({ v: 1, contributions: [contribution()] }), env, deps);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.equal(env.PENDING.map.size, 1);
});

test("the install limit is per install and resets the next day", async () => {
  const { env, deps } = setup({ CARDS_PER_INSTALL_DAY: "1" });
  assert.equal((await handleRequest(post({ v: 1, contributions: [contribution()] }), env, deps)).status, 200);
  const other = contribution({ install: "223e4567-e89b-42d3-a456-426614174000" });
  assert.equal((await handleRequest(post({ v: 1, contributions: [other] }), env, deps)).status, 200);
  const tomorrow = { ...deps, now: () => new Date("2026-10-16T00:01:00Z") };
  assert.equal((await handleRequest(post({ v: 1, contributions: [contribution()] }), env, tomorrow)).status, 200);
});

test("the 51st request from one IP in an hour gets 429, and another IP is unaffected", async () => {
  const { env, deps } = setup();
  for (let i = 0; i < 50; i++) {
    const res = await handleRequest(post("{bad"), env, deps); // invalid requests still count against the IP
    assert.equal(res.status, 400);
  }
  const blocked = await handleRequest(post({ v: 1, contributions: [contribution()] }), env, deps);
  assert.equal(blocked.status, 429);
  const other = await handleRequest(post({ v: 1, contributions: [contribution()] }, { ip: "9.9.9.9" }), env, deps);
  assert.equal(other.status, 200);
  const nextHour = { ...deps, now: () => new Date("2026-10-15T13:00:00Z") };
  assert.equal((await handleRequest(post({ v: 1, contributions: [contribution()] }), env, nextHour)).status, 200);
});

test("missing configuration fails fast with 500 and no detail", async () => {
  for (const key of ["GITHUB_TOKEN", "DATA_REPO", "DATA_BRANCH", "ALLOWED_EXTENSION_IDS", "PENDING", "RATE"]) {
    const { env, deps } = setup({ [key]: undefined });
    const res = await handleRequest(post({ v: 1, contributions: [contribution()] }), env, deps);
    assert.equal(res.status, 500, key);
    assert.doesNotMatch(await res.text(), new RegExp(key));
  }
});

test("readConfig names every missing or malformed setting", () => {
  assert.throws(() => readConfig({}), /GITHUB_TOKEN.*DATA_REPO.*DATA_BRANCH.*ALLOWED_EXTENSION_IDS/s);
  const { env } = setup({ DATA_REPO: "not a repo" });
  assert.throws(() => readConfig(env), /DATA_REPO/);
  const { env: env2 } = setup({ ALLOWED_EXTENSION_IDS: "short" });
  assert.throws(() => readConfig(env2), /ALLOWED_EXTENSION_IDS/);
  const { env: env3 } = setup();
  assert.deepEqual(readConfig(env3).allowedExtensionIds, [EXT]);
});
