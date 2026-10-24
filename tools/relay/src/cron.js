import { readConfig } from "./config.js";
import { PENDING_COUNT_KEY } from "./handler.js";
import { createGitHub } from "./github.js";
import { validateContribution } from "./validate.js";

const PREFIX = "pending/";
const QUARANTINE_AFTER_FAILURES = 2;

async function listKeys(bucket, limit) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && keys.length < limit);
  return { keys, complete: !cursor };
}

/** Names already under contributions/<day>/ at the base tree, so a new file never overwrites an old one. */
async function existingNames(github, rootTree, day) {
  const root = await github.listTree(rootTree);
  const contributions = root?.find((e) => e.path === "contributions" && e.type === "tree");
  if (!contributions) return [];
  const days = await github.listTree(contributions.sha);
  const dayEntry = days?.find((e) => e.path === day && e.type === "tree");
  if (!dayEntry) return [];
  return ((await github.listTree(dayEntry.sha)) || []).map((e) => e.path);
}

// A 4xx on the tree or commit call means GitHub disliked the content. Anything else (5xx, auth, a moved ref)
// says nothing about one item, so it is never counted against an item.
const isContentError = (err) => (err.step === "createTree" || err.step === "createCommit") && [400, 413, 422].includes(err.status);

/**
 * Moves pending items into the data repo's inbox branch, then deletes them from pending.
 * Items are committed in chunks of at most MAX_FLUSH_BYTES, one commit and one ref update per chunk, and a
 * chunk's items are deleted only after its ref update succeeded. Any other failure throws and leaves them pending.
 * An item GitHub rejects in two separate runs is moved to quarantine/ instead of being retried forever.
 * @returns {Promise<{committed: number, commit: string|null, quarantined: number}>}
 */
export async function flushPending(env, deps = {}) {
  const config = readConfig(env);
  const github = createGitHub({ token: config.token, repo: config.repo, fetch: deps.fetch });
  const { keys, complete } = await listKeys(config.pending, config.maxItemsPerFlush * 2);

  let head = null;
  const existing = new Map();
  const next = new Map();
  let committed = 0;
  let quarantined = 0;
  let lastCommit = null;
  let removed = 0;
  let taken = 0;
  let index = 0;

  async function ensureHead() {
    if (head) return;
    let commitSha = await github.getRef(config.branch);
    if (!commitSha) {
      const base = await github.getRef(config.baseBranch);
      if (!base) throw new Error(`data repo has no ${config.baseBranch} branch yet; make an initial commit there first`);
      await github.createRef(config.branch, base);
      commitSha = base;
    }
    head = { commitSha, treeSha: await github.commitTree(commitSha) };
  }

  async function fileNames(day) {
    if (!existing.has(day)) existing.set(day, await existingNames(github, head.treeSha, day));
    return existing.get(day);
  }

  async function commitOnce(chunk) {
    const entries = [];
    const groups = [];
    for (const { item } of chunk) {
      const day = item.received.slice(0, 10);
      const stem = `${item.photoId}-${item.install.slice(0, 8)}-`;
      const group = `${day}/${stem}`;
      if (!next.has(group)) {
        const used = (await fileNames(day))
          .map((name) => (name.startsWith(stem) ? /^(\d+)\.json$/.exec(name.slice(stem.length)) : null))
          .filter(Boolean)
          .map((m) => Number(m[1]));
        next.set(group, Math.max(0, ...used) + 1);
      }
      // Numbers are reserved only once the commit lands, so a retry reuses them.
      const taken = groups.filter((g) => g === group).length;
      groups.push(group);
      entries.push({ path: `contributions/${day}/${stem}${next.get(group) + taken}.json`, mode: "100644", type: "blob", content: JSON.stringify({ ...item, received: day }) });
    }
    const tree = await github.createTree(head.treeSha, entries);
    const days = [...new Set(chunk.map(({ item }) => item.received.slice(0, 10)))].sort();
    const message = `contributions: ${chunk.length} item${chunk.length === 1 ? "" : "s"} (${days[0]}${days.length > 1 ? ` to ${days[days.length - 1]}` : ""})`;
    const commit = await github.createCommit(message, tree, head.commitSha);
    await github.updateRef(config.branch, commit);
    for (const group of groups) next.set(group, next.get(group) + 1);
    head = { commitSha: commit, treeSha: tree };
    lastCommit = commit;
    await config.pending.delete(chunk.map(({ key }) => key));
    committed += chunk.length;
    removed += chunk.length;
  }

  async function recordFailure({ key, text }) {
    const tries = (Number(await config.rate.get(`tries:${key}`)) || 0) + 1;
    await config.rate.put(`tries:${key}`, String(tries));
    if (tries < QUARANTINE_AFTER_FAILURES) return;
    await config.pending.put(`quarantine/${key.slice(PREFIX.length)}`, text);
    await config.pending.delete([key]);
    quarantined += 1;
    removed += 1;
  }

  async function commitChunk(chunk) {
    try {
      await commitOnce(chunk);
    } catch (err) {
      if (!isContentError(err)) throw err;
      // Find the offender: items that go in alone are fine, the one that is rejected alone is the problem.
      if (chunk.length > 1) for (const one of chunk) await commitChunk([one]);
      else await recordFailure(chunk[0]);
    }
  }

  while (index < keys.length && taken < config.maxItemsPerFlush) {
    const chunk = [];
    const corrupt = [];
    let bytes = 0;
    while (index < keys.length && taken < config.maxItemsPerFlush) {
      const key = keys[index];
      const obj = await config.pending.get(key);
      if (!obj) {
        index += 1;
        continue;
      }
      const text = await obj.text();
      let item = null;
      try {
        item = JSON.parse(text);
      } catch {
        item = null;
      }
      if (!item || !validateContribution(item, { stored: true }).ok) {
        corrupt.push(key);
        index += 1;
        continue;
      }
      if (chunk.length && bytes + text.length > config.maxFlushBytes) break;
      chunk.push({ key, item, text });
      bytes += text.length;
      taken += 1;
      index += 1;
    }
    if (chunk.length) {
      await ensureHead();
      await commitChunk(chunk);
    }
    if (corrupt.length) {
      await config.pending.delete(corrupt);
      removed += corrupt.length;
    }
  }

  if (removed || complete) {
    // An exhaustive listing is the truth; otherwise subtract what left.
    const left = complete && index >= keys.length ? keys.length - removed : (Number(await config.rate.get(PENDING_COUNT_KEY)) || 0) - removed;
    await config.rate.put(PENDING_COUNT_KEY, String(Math.max(0, left)));
  }
  return { committed, commit: lastCommit, quarantined };
}
