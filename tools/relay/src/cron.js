import { readConfig } from "./config.js";
import { createGitHub } from "./github.js";
import { validateContribution } from "./validate.js";

const PREFIX = "pending/";

async function listKeys(bucket, max) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && keys.length < max * 2);
  return keys;
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

/**
 * Moves pending items into the data repo as ONE commit, then deletes them from pending.
 * Deleting happens only after the branch ref moved; any earlier failure throws and leaves everything pending.
 * @returns {Promise<{committed: number, commit: string|null}>}
 */
export async function flushPending(env, deps = {}) {
  const config = readConfig(env);
  const github = createGitHub({ token: config.token, repo: config.repo, fetch: deps.fetch });

  const keys = await listKeys(config.pending, config.maxItemsPerFlush);
  const items = [];
  const corrupt = [];
  for (const key of keys) {
    if (items.length >= config.maxItemsPerFlush) break;
    const obj = await config.pending.get(key);
    if (!obj) continue;
    let item = null;
    try {
      item = JSON.parse(await obj.text());
    } catch {
      item = null;
    }
    if (item && validateContribution(item).ok) items.push({ key, item });
    else corrupt.push(key);
  }
  if (items.length === 0) {
    if (corrupt.length) await config.pending.delete(corrupt);
    return { committed: 0, commit: null };
  }

  const head = await github.headCommit(config.branch);
  const existing = new Map();
  for (const day of new Set(items.map(({ item }) => item.day))) {
    existing.set(day, await existingNames(github, head.treeSha, day));
  }

  const next = new Map();
  const entries = items.map(({ item }) => {
    const prefix = item.install.slice(0, 8);
    const stem = `${item.photoId}-${prefix}-`;
    const group = `${item.day}/${stem}`;
    if (!next.has(group)) {
      const used = existing
        .get(item.day)
        .map((name) => (name.startsWith(stem) ? /^(\d+)\.json$/.exec(name.slice(stem.length)) : null))
        .filter(Boolean)
        .map((m) => Number(m[1]));
      next.set(group, Math.max(0, ...used) + 1);
    }
    const n = next.get(group);
    next.set(group, n + 1);
    return { path: `contributions/${item.day}/${stem}${n}.json`, mode: "100644", type: "blob", content: JSON.stringify(item) };
  });

  const tree = await github.createTree(head.treeSha, entries);
  const days = [...new Set(items.map(({ item }) => item.day))].sort();
  const message = `contributions: ${items.length} item${items.length === 1 ? "" : "s"} (${days[0]}${days.length > 1 ? ` to ${days[days.length - 1]}` : ""})`;
  const commit = await github.createCommit(message, tree, head.commitSha);
  await github.updateRef(config.branch, commit);

  await config.pending.delete([...items.map(({ key }) => key), ...corrupt]);
  return { committed: items.length, commit };
}
