// The few GitHub Git Data API calls the relay needs. The token goes only in the Authorization header;
// error messages carry the status and GitHub's message, never the request headers.

const API = "https://api.github.com";

export function createGitHub({ token, repo, fetch: fetchImpl = fetch }) {
  async function call(method, path, body) {
    const res = await fetchImpl(`${API}/repos/${repo}/git${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "card-scanner-relay",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${data?.message || ""}`.trim());
    return data;
  }

  return {
    async headCommit(branch) {
      const ref = await call("GET", `/ref/heads/${branch}`);
      const commit = await call("GET", `/commits/${ref.object.sha}`);
      return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
    },
    /** Entries of one tree (not recursive), or null when the tree does not exist. */
    async listTree(sha) {
      try {
        return (await call("GET", `/trees/${sha}`)).tree;
      } catch (err) {
        if (/ 404/.test(err.message)) return null;
        throw err;
      }
    },
    // Entries with `content` make GitHub create the blobs itself, so a batch of N files costs one call, not N.
    async createTree(baseTree, entries) {
      return (await call("POST", "/trees", { base_tree: baseTree, tree: entries })).sha;
    },
    async createCommit(message, tree, parent) {
      return (await call("POST", "/commits", { message, tree, parents: [parent] })).sha;
    },
    // force:false makes a concurrent push fail the run; the items stay pending and go in the next hour's commit.
    async updateRef(branch, sha) {
      await call("PATCH", `/refs/heads/${branch}`, { sha, force: false });
    },
  };
}
