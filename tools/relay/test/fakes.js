// In-memory stand-ins for KV, R2 and the GitHub Git Data API, used by tests/relay-*.test.js.

export function fakeKV() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
  };
}

export function fakeR2() {
  const map = new Map();
  const log = [];
  return {
    map,
    log,
    async put(key, body) {
      log.push(["put", key]);
      map.set(key, String(body));
    },
    async get(key) {
      log.push(["get", key]);
      return map.has(key) ? { text: async () => map.get(key) } : null;
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      log.push(["delete", list]);
      for (const k of list) map.delete(k);
    },
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fetch fake for https://api.github.com/repos/<repo>/git/*.
 * existing: { "2026-10-15": ["name.json", ...] } files already under contributions/<day>/.
 * failOn: "refUpdate" | "createTree" | "createCommit" makes that call fail with failStatus
 *   (default 500; refUpdate answers 422).
 * poison: createTree answers 422 when any entry's content contains this text.
 * missingBranch: the working branch does not exist until a POST /git/refs creates it.
 */
export function fakeGitHub({ repo = "owner/data", branch = "inbox", baseBranch = "main", existing = {}, failOn = null, failStatus = 500, poison = null, missingBranch = false, emptyRepo = false } = {}) {
  const calls = [];
  const state = { treeBody: null, commitBody: null, refBody: null, trees: [], commits: [], refUpdates: [], createdRefs: [] };
  const days = Object.keys(existing);
  const refs = emptyRepo ? {} : { [baseBranch]: "commit-base", ...(missingBranch ? {} : { [branch]: "commit-base" }) };
  async function fetchFake(url, init = {}) {
    const method = init.method || "GET";
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body, headers: init.headers });
    const base = `/repos/${repo}/git`;
    const refMatch = method === "GET" && path.startsWith(`${base}/ref/heads/`) ? path.slice(`${base}/ref/heads/`.length) : null;
    if (refMatch !== null) return refs[refMatch] ? json(200, { object: { sha: refs[refMatch] } }) : json(404, { message: "Not Found" });
    if (method === "POST" && path === `${base}/refs`) {
      state.createdRefs.push(body);
      refs[body.ref.replace("refs/heads/", "")] = body.sha;
      return json(201, { ref: body.ref });
    }
    if (method === "GET" && path.startsWith(`${base}/commits/commit-`)) return json(200, { tree: { sha: "tree-root" } });
    if (method === "GET" && path.startsWith(`${base}/trees/`)) {
      const sha = path.slice(`${base}/trees/`.length);
      if (sha === "tree-root") {
        return json(200, { tree: days.length ? [{ path: "contributions", type: "tree", sha: "tree-contrib" }] : [] });
      }
      if (sha === "tree-contrib") return json(200, { tree: days.map((d) => ({ path: d, type: "tree", sha: `tree-day-${d}` })) });
      if (sha.startsWith("tree-day-")) {
        const day = sha.slice("tree-day-".length);
        return json(200, { tree: (existing[day] || []).map((p) => ({ path: p, type: "blob", sha: `blob-${p}` })) });
      }
      return json(404, { message: "Not Found" });
    }
    if (method === "POST" && path === `${base}/trees`) {
      if (failOn === "createTree") return json(failStatus, { message: "boom" });
      if (poison && body.tree.some((e) => e.content.includes(poison))) return json(422, { message: "invalid" });
      state.treeBody = body;
      state.trees.push(body);
      return json(201, { sha: `tree-new-${state.trees.length}` });
    }
    if (method === "POST" && path === `${base}/commits`) {
      if (failOn === "createCommit") return json(failStatus, { message: "boom" });
      state.commitBody = body;
      state.commits.push(body);
      return json(201, { sha: `commit-new-${state.commits.length}` });
    }
    if (method === "PATCH" && path === `${base}/refs/heads/${branch}`) {
      if (failOn === "refUpdate") return json(422, { message: "Update is not a fast forward" });
      state.refBody = body;
      state.refUpdates.push(body);
      return json(200, { object: { sha: body.sha } });
    }
    return json(404, { message: `unhandled ${method} ${path}` });
  }
  return { fetch: fetchFake, calls, state };
}
