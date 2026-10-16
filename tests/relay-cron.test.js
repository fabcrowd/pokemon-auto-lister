import { test } from "node:test";
import assert from "node:assert/strict";
import { flushPending } from "../tools/relay/src/cron.js";
import { fakeGitHub, fakeKV, fakeR2 } from "../tools/relay/test/fakes.js";
import { card, contribution } from "../tools/relay/test/builders.js";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const A = "0123456789abcdef";
const B = "fedcba9876543210";
const RECEIVED = "2026-10-15T12:00:00.000Z";

function setup(over = {}, ghOpts = {}) {
  const gh = fakeGitHub(ghOpts);
  const env = {
    GITHUB_TOKEN: "secret-token",
    DATA_REPO: "owner/data",
    RELAY_ID_SECRET: "a-long-random-relay-secret",
    ALLOWED_EXTENSION_IDS: EXT,
    PENDING: fakeR2(),
    RATE: fakeKV(),
    ...over,
  };
  return { env, gh, deps: { fetch: gh.fetch } };
}

// The relay's stored form: hashed install, server receipt time.
const stored = (over = {}) => contribution({ install: A, received: RECEIVED, ...over });
const put = (env, key, item) => env.PENDING.put(key, JSON.stringify(item));
const key = (n, received = RECEIVED) => `pending/${received}-u${n}.json`;

test("pending items become one commit on the inbox branch, filed under the server day", async () => {
  const { env, gh, deps } = setup();
  const a = stored({ day: "2026-10-14" }); // the client's day is only a label
  const b = stored({ photoId: "00000000000000a2", received: "2026-10-16T01:00:00.000Z" });
  const c = stored({ install: B });
  await put(env, key(1), a);
  await put(env, key(2, b.received), b);
  await put(env, key(3), c);

  const result = await flushPending(env, deps);

  assert.deepEqual(result, { committed: 3, commit: "commit-new-1", quarantined: 0 });
  assert.deepEqual(gh.state.treeBody.tree.map((e) => e.path).sort(), [
    "contributions/2026-10-15/00000000000000a1-01234567-1.json",
    "contributions/2026-10-15/00000000000000a1-fedcba98-1.json",
    "contributions/2026-10-16/00000000000000a2-01234567-1.json",
  ]);
  assert.equal(gh.state.treeBody.base_tree, "tree-root");
  for (const e of gh.state.treeBody.tree) {
    assert.equal(e.mode, "100644");
    assert.equal(e.type, "blob");
    assert.equal(JSON.parse(e.content).v, 1);
  }
  assert.deepEqual(JSON.parse(gh.state.treeBody.tree.find((e) => e.path.includes("2026-10-16")).content), b);
  assert.equal(gh.state.commitBody.tree, "tree-new-1");
  assert.deepEqual(gh.state.commitBody.parents, ["commit-base"]);
  assert.match(gh.state.commitBody.message, /3/);
  assert.deepEqual(gh.state.refBody, { sha: "commit-new-1", force: false });
  assert.equal(env.PENDING.map.size, 0);
});

test("only the inbox branch is ever written; main is never touched", async () => {
  const { env, gh, deps } = setup();
  await put(env, key(1), stored());
  await flushPending(env, deps);
  const writes = gh.calls.filter((c) => c.method !== "GET");
  assert.ok(writes.length > 0);
  for (const w of writes.filter((c) => /refs/.test(c.path))) assert.match(w.path, /\/refs\/heads\/inbox$/);
  assert.equal(gh.calls.some((c) => c.method === "PATCH" && /heads\/main/.test(c.path)), false);
});

test("a missing inbox branch is created from the base branch head first", async () => {
  const { env, gh, deps } = setup({}, { missingBranch: true });
  await put(env, key(1), stored());
  await flushPending(env, deps);
  assert.deepEqual(gh.state.createdRefs, [{ ref: "refs/heads/inbox", sha: "commit-base" }]);
  const createdAt = gh.calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/git/refs"));
  const treeAt = gh.calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/git/trees"));
  assert.ok(createdAt >= 0 && createdAt < treeAt);
  assert.deepEqual(gh.state.commitBody.parents, ["commit-base"]);
  assert.equal(env.PENDING.map.size, 0);
});

test("an empty data repo fails clearly and keeps everything pending", async () => {
  const { env, deps } = setup({}, { emptyRepo: true });
  await put(env, key(1), stored());
  await assert.rejects(flushPending(env, deps), /initial commit/);
  assert.equal(env.PENDING.map.size, 1);
});

test("the same photo and install twice in one batch get n = 1, 2", async () => {
  const { env, gh, deps } = setup();
  await put(env, key(1), stored());
  await put(env, key(2), stored());
  await flushPending(env, deps);
  assert.deepEqual(gh.state.treeBody.tree.map((e) => e.path).sort(), [
    "contributions/2026-10-15/00000000000000a1-01234567-1.json",
    "contributions/2026-10-15/00000000000000a1-01234567-2.json",
  ]);
});

test("n continues after files already in the data repo, so nothing is overwritten", async () => {
  const { env, gh, deps } = setup({}, { existing: { "2026-10-15": ["00000000000000a1-01234567-1.json", "00000000000000a1-01234567-2.json", "other.json"] } });
  await put(env, key(1), stored());
  await flushPending(env, deps);
  assert.deepEqual(gh.state.treeBody.tree.map((e) => e.path), ["contributions/2026-10-15/00000000000000a1-01234567-3.json"]);
});

test("pending is deleted only after the ref update succeeds", async () => {
  for (const failOn of ["createTree", "createCommit", "refUpdate"]) {
    const { env, deps } = setup({}, { failOn });
    await put(env, key(1), stored());
    const result = await flushPending(env, deps).catch((err) => err);
    assert.ok(result instanceof Error && /GitHub/.test(result.message), failOn);
    assert.equal(env.PENDING.map.size, 1, failOn);
    assert.equal(env.PENDING.log.filter(([op]) => op === "delete").length, 0, failOn);
  }
});

test("the delete happens after the ref update call", async () => {
  const { env, gh } = setup();
  await put(env, key(1), stored());
  const order = [];
  const realDelete = env.PENDING.delete.bind(env.PENDING);
  env.PENDING.delete = async (keys) => {
    order.push("delete");
    return realDelete(keys);
  };
  const fetchSpy = async (url, init) => {
    if ((init?.method || "GET") === "PATCH") order.push("patch");
    return gh.fetch(url, init);
  };
  await flushPending(env, { fetch: fetchSpy });
  assert.deepEqual(order, ["patch", "delete"]);
});

test("nothing pending means no GitHub calls", async () => {
  const { env, gh, deps } = setup();
  assert.deepEqual(await flushPending(env, deps), { committed: 0, commit: null, quarantined: 0 });
  assert.equal(gh.calls.length, 0);
});

test("a corrupt or wrong-form pending file is removed and does not block the rest", async () => {
  const { env, gh, deps } = setup();
  await env.PENDING.put("pending/2026-10-15T00:00:00.000Z-bad.json", "{oops");
  await put(env, "pending/2026-10-15T00:00:00.000Z-raw.json", contribution()); // raw install id never belongs here
  await put(env, key(1), stored());
  const result = await flushPending(env, deps);
  assert.equal(result.committed, 1);
  assert.equal(gh.state.treeBody.tree.length, 1);
  assert.equal(env.PENDING.map.size, 0);
});

test("only MAX_ITEMS_PER_FLUSH items go in one run; the rest stay pending", async () => {
  const { env, deps } = setup({ MAX_ITEMS_PER_FLUSH: "2" });
  for (let i = 1; i <= 3; i++) await put(env, key(i), stored({ photoId: `00000000000000a${i}` }));
  const result = await flushPending(env, deps);
  assert.equal(result.committed, 2);
  assert.deepEqual([...env.PENDING.map.keys()], [key(3)]);
});

test("a run larger than the byte cap becomes several chained commits, each deleted after its own ref update", async () => {
  const { env, gh, deps } = setup({ MAX_FLUSH_BYTES: "700" });
  for (let i = 1; i <= 3; i++) await put(env, key(i), stored());
  const result = await flushPending(env, deps);
  assert.equal(result.committed, 3);
  assert.equal(gh.state.commits.length, 3);
  assert.deepEqual(gh.state.commits.map((c) => c.parents[0]), ["commit-base", "commit-new-1", "commit-new-2"]);
  assert.deepEqual(gh.state.trees.map((t) => t.base_tree), ["tree-root", "tree-new-1", "tree-new-2"]);
  assert.deepEqual(gh.state.trees.map((t) => t.tree[0].path.slice(-6, -5)), ["1", "2", "3"]);
  assert.equal(gh.state.refUpdates.length, 3);
  assert.equal(env.PENDING.map.size, 0);
});

test("an item that GitHub rejects twice is quarantined instead of retried forever, and good items still land", async () => {
  const { env, gh, deps } = setup({}, { poison: "poison-card" });
  await put(env, key(1), stored({ photoId: "00000000000000a1" }));
  await put(env, key(2), stored({ photoId: "00000000000000a2", cards: [card({ answer: { cardId: "poison-card" } })] }));
  await put(env, key(3), stored({ photoId: "00000000000000a3" }));

  const first = await flushPending(env, deps);
  assert.equal(first.committed, 2);
  assert.equal(first.quarantined, 0);
  assert.deepEqual([...env.PENDING.map.keys()], [key(2)]); // kept for one more try

  const second = await flushPending(env, deps);
  assert.equal(second.quarantined, 1);
  assert.deepEqual([...env.PENDING.map.keys()], [`quarantine/${key(2).slice("pending/".length)}`]);
  assert.equal(gh.calls.filter((c) => c.method === "PATCH").length, 2);

  const third = await flushPending(env, deps);
  assert.deepEqual(third, { committed: 0, commit: null, quarantined: 0 });
});

test("server errors are not blamed on items: they stay pending however often they fail", async () => {
  const { env, deps } = setup({}, { failOn: "createTree", failStatus: 500 });
  await put(env, key(1), stored());
  for (let i = 0; i < 3; i++) await flushPending(env, deps).catch(() => {});
  assert.deepEqual([...env.PENDING.map.keys()], [key(1)]);
});

test("the pending counter follows the flush and is corrected to the real count", async () => {
  const { env, deps } = setup();
  await env.RATE.put("pending:count", "40"); // drifted far above the truth
  for (let i = 1; i <= 3; i++) await put(env, key(i), stored({ photoId: `00000000000000a${i}` }));
  await flushPending(env, deps);
  assert.equal(await env.RATE.get("pending:count"), "0");
});

test("the token is sent as a bearer header and never appears in errors", async () => {
  const { env, gh, deps } = setup({}, { failOn: "refUpdate" });
  await put(env, key(1), stored());
  await assert.rejects(flushPending(env, deps), (err) => !String(err.message).includes("secret-token"));
  assert.equal(gh.calls[0].headers.authorization, "Bearer secret-token");
});

test("a missing secret fails fast before any work", async () => {
  const { env, gh, deps } = setup({ GITHUB_TOKEN: undefined });
  await put(env, key(1), stored());
  await assert.rejects(flushPending(env, deps), /GITHUB_TOKEN/);
  assert.equal(gh.calls.length, 0);
  assert.equal(env.PENDING.map.size, 1);
});
