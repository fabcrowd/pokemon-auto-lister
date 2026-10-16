const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const EXTENSION_ID = /^[a-p]{32}$/;

function positiveInt(value, fallback, name, problems) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) problems.push(`${name} must be a positive integer`);
  return n;
}

/**
 * Reads and checks every setting the relay needs. Throws one Error naming everything that is missing or
 * malformed, so a bad deploy fails on its first request instead of at the first commit.
 */
export function readConfig(env) {
  const problems = [];
  const need = (name) => {
    const v = env[name];
    if (typeof v !== "string" || v.trim() === "") {
      problems.push(`${name} is not set`);
      return "";
    }
    return v.trim();
  };

  const token = need("GITHUB_TOKEN");
  const repo = need("DATA_REPO");
  const branch = (env.DATA_BRANCH ?? "").trim() || "inbox";
  const baseBranch = (env.DATA_BASE_BRANCH ?? "").trim() || "main";
  const idSecret = need("RELAY_ID_SECRET");
  const idsRaw = need("ALLOWED_EXTENSION_IDS");
  if (repo && !REPO.test(repo)) problems.push("DATA_REPO must look like owner/name");
  if (!BRANCH.test(branch)) problems.push("DATA_BRANCH has characters a branch name cannot have");
  // The nightly job runs code from the base branch, so the relay's token must never move it.
  if (branch === baseBranch || branch === "main" || branch === "master") problems.push("DATA_BRANCH must not be the branch that holds the pipeline code");
  if (idSecret && idSecret.length < 16) problems.push("RELAY_ID_SECRET must be at least 16 characters");
  const ids = idsRaw ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (idsRaw && (ids.length === 0 || !ids.every((id) => EXTENSION_ID.test(id)))) {
    problems.push("ALLOWED_EXTENSION_IDS must be comma-separated 32-letter (a-p) extension ids");
  }
  if (!env.PENDING || typeof env.PENDING.put !== "function") problems.push("R2 binding PENDING is missing");
  if (!env.RATE || typeof env.RATE.get !== "function") problems.push("KV binding RATE is missing");

  const cardsPerInstallDay = positiveInt(env.CARDS_PER_INSTALL_DAY, 200, "CARDS_PER_INSTALL_DAY", problems);
  const requestsPerIpHour = positiveInt(env.REQUESTS_PER_IP_HOUR, 50, "REQUESTS_PER_IP_HOUR", problems);
  const maxPending = positiveInt(env.MAX_PENDING, 5000, "MAX_PENDING", problems);
  const ipCardsPerDay = positiveInt(env.IP_CARDS_PER_DAY, 500, "IP_CARDS_PER_DAY", problems);
  const maxFlushBytes = positiveInt(env.MAX_FLUSH_BYTES, 20_000_000, "MAX_FLUSH_BYTES", problems);
  const maxItemsPerFlush = positiveInt(env.MAX_ITEMS_PER_FLUSH, 100, "MAX_ITEMS_PER_FLUSH", problems);

  if (problems.length) throw new Error(`relay misconfigured: ${problems.join("; ")}`);
  return {
    token,
    repo,
    branch,
    baseBranch,
    idSecret,
    allowedExtensionIds: ids,
    pending: env.PENDING,
    rate: env.RATE,
    cardsPerInstallDay,
    requestsPerIpHour,
    maxItemsPerFlush,
    maxPending,
    ipCardsPerDay,
    maxFlushBytes,
  };
}
