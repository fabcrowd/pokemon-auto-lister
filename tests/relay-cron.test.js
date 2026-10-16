import { test } from "node:test";
import assert from "node:assert/strict";
import { flushPending } from "../tools/relay/src/cron.js";
import { fakeGitHub, fakeKV, fakeR2 } from "../tools/relay/test/fakes.js";
import { contribution } from "../tools/relay/test/builders.js";

const EXT = "abcdefghijklmnopabcdefghijklmnop";

function setup(over = {}, ghOpts = {}) {
  const gh = fakeGitHub(ghOpts);
  const env = { GITHUB_TOKEN: "secret-token", DATA_REPO: "owner/data", DATA_BRANCH: "main", ALLOWED_EXTENSION_IDS: EXT, PENDING: fakeR2(), RATE: fakeKV(), ...over };
  return { env, gh, deps: { fetch: gh.fetch } };
}

const store = (env, key, item) => env.PENDING.put(key, JSON.stringify(item));

test("pending items become one commit with a tree of contributions/<day>/<photoId>-<install-prefix>-<n>.json", async () => {
  const { env, gh, deps } = setup();
  const a = contribution();
  const b = contribution({ photoId: "00000000000000a2", day: "2026-10-14" });
  const c = contribution({ install: "223e4567-e89b-42d3-a456-426614174000" });
  await store(env, "pending/2026-10-15/u1.json", a);
  await store(env, "pending/2026-10-14/u2.json", b);
  await store(env, "pending/2026-10-15/u3.json", c);

  const result = await flushPending(env, deps);

  assert.deepEqual(result, { committed: 3, commit: "commit-new" });
  const paths = gh.state.treeBody.tree.map((e) => e.path).sort();
  assert.deepEqual(paths, [
    "contributions/2026-10-14/00000000000000a2-123e4567-1.json",
    "contributions/2026-10-15/00000000000000a1-123e4567-1.json",
    "contributions/2026-10-15/00000000000000a1-223e4567-1.json",
  ]);
  assert.equal(gh.state.treeBody.base_tree, "tree-root");
  for (const e of gh.state.treeBody.tree) {
    assert.equal(e.mode, "100644");
    assert.equal(e.type, "blob");
    assert.equal(JSON.parse(e.content).v, 1);
  }
  assert.deepEqual(JSON.parse(gh.state.treeBody.tree.find((e) => e.path.includes("2026-10-14")).content), b);
  assert.equal(gh.state.commitBody.tree, "tree-new");
  assert.deepEqual(gh.state.commitBody.parents, ["commit-base"]);
  assert.match(gh.state.commitBody.message, /3/);
  assert.deepEqual(gh.state.refBody, { sha: "commit-new", force: false });
  assert.equal(env.PENDING.map.size, 0);
});

test("the same photo and install twice in one batch get n = 1, 2", async () => {
  const { env, gh, deps } = setup();
  await store(env, "pending/2026-10-15/u1.json", contribution());
  await store(env, "pending/2026-10-15/u2.json", contribution());
  await flushPending(env, deps);
  const paths = gh.state.treeBody.tree.map((e) => e.path).sort();
  assert.deepEqual(paths, ["contributions/2026-10-15/00000000000000a1-123e4567-1.json", "contributions/2026-10-15/00000000000000a1-123e4567-2.json"]);
});

test("n continues after files already in the data repo, so nothing is overwritten", async () => {
  const { env, gh, deps } = setup({}, { existing: { "2026-10-15": ["00000000000000a1-123e4567-1.json", "00000000000000a1-123e4567-2.json", "other.json"] } });
  await store(env, "pending/2026-10-15/u1.json", contribution());
  await flushPending(env, deps);
  assert.deepEqual(gh.state.treeBody.tree.map((e) => e.path), ["contributions/2026-10-15/00000000000000a1-123e4567-3.json"]);
});

test("pending is deleted only after the ref update succeeds", async () => {
  for (const failOn of ["createTree", "createCommit", "refUpdate"]) {
    const { env, deps } = setup({}, { failOn });
    await store(env, "pending/2026-10-15/u1.json", contribution());
    await assert.rejects(flushPending(env, deps), /GitHub/);
    assert.equal(env.PENDING.map.size, 1, failOn);
    assert.equal(env.PENDING.log.filter(([op]) => op === "delete").length, 0, failOn);
  }
});

test("the delete happens after the ref update call", async () => {
  const { env, gh } = setup();
  await store(env, "pending/2026-10-15/u1.json", contribution());
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
  assert.deepEqual(await flushPending(env, deps), { committed: 0, commit: null });
  assert.equal(gh.calls.length, 0);
});

test("a corrupt pending file is removed and does not block the rest", async () => {
  const { env, gh, deps } = setup();
  await env.PENDING.put("pending/2026-10-15/bad.json", "{oops");
  await store(env, "pending/2026-10-15/u1.json", contribution());
  const result = await flushPending(env, deps);
  assert.equal(result.committed, 1);
  assert.equal(gh.state.treeBody.tree.length, 1);
  assert.equal(env.PENDING.map.size, 0);
});

test("only MAX_ITEMS_PER_FLUSH items go in one run; the rest stay pending", async () => {
  const { env, deps } = setup({ MAX_ITEMS_PER_FLUSH: "2" });
  for (let i = 1; i <= 3; i++) await store(env, `pending/2026-10-15/u${i}.json`, contribution({ photoId: `00000000000000a${i}` }));
  const result = await flushPending(env, deps);
  assert.equal(result.committed, 2);
  assert.deepEqual([...env.PENDING.map.keys()], ["pending/2026-10-15/u3.json"]);
});

test("the token is sent as a bearer header and never appears in errors", async () => {
  const { env, gh, deps } = setup({}, { failOn: "refUpdate" });
  await store(env, "pending/2026-10-15/u1.json", contribution());
  await assert.rejects(flushPending(env, deps), (err) => !String(err.message).includes("secret-token"));
  assert.equal(gh.calls[0].headers.authorization, "Bearer secret-token");
});

test("a missing secret fails fast before any work", async () => {
  const { env, gh, deps } = setup({ GITHUB_TOKEN: undefined });
  await store(env, "pending/2026-10-15/u1.json", contribution());
  await assert.rejects(flushPending(env, deps), /GITHUB_TOKEN/);
  assert.equal(gh.calls.length, 0);
  assert.equal(env.PENDING.map.size, 1);
});
