// The few GitHub Git Data API calls the relay needs. The token goes only in the Authorization header;
// error messages carry the status and GitHub's message, never the request headers.

const API = "https://api.github.com";

export function createGitHub({ token, repo, fetch: fetchImpl = fetch }) {
  async function call(method, path, body, step) {
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
    if (!res.ok) {
      throw Object.assign(new Error(`GitHub ${method} ${path} failed: ${res.status} ${data?.message || ""}`.trim()), { status: res.status, step });
    }
    return data;
  }

  return {
    /** The commit sha a branch points at, or null when the branch does not exist. */
    async getRef(branch) {
      try {
        return (await call("GET", `/ref/heads/${branch}`, undefined, "getRef")).object.sha;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    async createRef(branch, sha) {
      await call("POST", "/refs", { ref: `refs/heads/${branch}`, sha }, "createRef");
    },
    async commitTree(commitSha) {
      return (await call("GET", `/commits/${commitSha}`, undefined, "getCommit")).tree.sha;
    },
    /** Entries of one tree (not recursive), or null when the tree does not exist. */
    async listTree(sha) {
      try {
        return (await call("GET", `/trees/${sha}`, undefined, "listTree")).tree;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    // Entries with `content` make GitHub create the blobs itself, so a batch of N files costs one call, not N.
    async createTree(baseTree, entries) {
      return (await call("POST", "/trees", { base_tree: baseTree, tree: entries }, "createTree")).sha;
    },
    async createCommit(message, tree, parent) {
      return (await call("POST", "/commits", { message, tree, parents: [parent] }, "createCommit")).sha;
    },
    // force:false makes a concurrent push fail the run; the items stay pending and go in the next hour's commit.
    async updateRef(branch, sha) {
      await call("PATCH", `/refs/heads/${branch}`, { sha, force: false }, "updateRef");
    },
  };
}
