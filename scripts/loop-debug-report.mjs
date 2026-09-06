/**
 * One-shot health report for /loop debug ticks.
 * Prints JSON to stdout; exit 1 if tests fail or dashboard unreachable.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DASHBOARD = process.env.LOOP_DEBUG_URL || 'http://127.0.0.1:3000';

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`${url} → HTTP ${res.status}`);
  }
  return res.json();
}

function queueSnapshot(dataDir) {
  const queueDir = path.join(dataDir, 'queue');
  if (!existsSync(queueDir)) {
    return { total: 0, byStatus: {} };
  }
  const byStatus = {};
  for (const file of readdirSync(queueDir).filter((n) => n.endsWith('.json'))) {
    const record = JSON.parse(readFileSync(path.join(queueDir, file), 'utf8'));
    byStatus[record.status] = (byStatus[record.status] || 0) + 1;
  }
  return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
}

const report = {
  at: new Date().toISOString(),
  dashboard: { ok: false, stats: null, identity: null, inbox: null, errorsNoPricedCache: 0 },
  tests: { ok: false, pass: 0, fail: 0 },
  queue: queueSnapshot(path.join(ROOT, 'data')),
  findings: [],
};

try {
  report.dashboard.stats = await fetchJson(`${DASHBOARD}/api/stats`);
  report.dashboard.identity = await fetchJson(`${DASHBOARD}/api/identity-status`);
  report.dashboard.inbox = await fetchJson(`${DASHBOARD}/api/inbox/status`);
  const errors = await fetchJson(`${DASHBOARD}/api/cards?status=error`);
  report.dashboard.errorsNoPricedCache = errors.filter((c) => !c.pricedCache).length;
  report.dashboard.ok = true;
} catch (err) {
  report.findings.push(`dashboard: ${err.message}`);
}

const testRun = spawnSync(process.execPath, ['--test', 'tests/smoke.test.js'], {
  cwd: ROOT,
  encoding: 'utf8',
});
report.tests.ok = testRun.status === 0;
const passMatch = testRun.stdout?.match(/ℹ pass (\d+)/);
const failMatch = testRun.stdout?.match(/ℹ fail (\d+)/);
report.tests.pass = passMatch ? Number(passMatch[1]) : 0;
report.tests.fail = failMatch ? Number(failMatch[1]) : testRun.status ? 1 : 0;
if (!report.tests.ok) {
  report.findings.push('smoke tests failed');
}

if (report.dashboard.identity?.mode === 'dual' && !report.dashboard.identity?.vellumEnabled) {
  report.findings.push('identity dual mode but Vellum disabled — corner/front fixes need VELLUM_AI_ENABLED=true + sidecar');
}
if (report.dashboard.errorsNoPricedCache > 0) {
  report.findings.push(
    `${report.dashboard.errorsNoPricedCache} error cards lack pricedCache — likely PokeGrade hard failures; try Rescan all cards or reset PG circuit`,
  );
}
if (report.dashboard.stats?.errors > 0) {
  report.findings.push(`${report.dashboard.stats.errors} cards in error status`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.dashboard.ok && report.tests.ok ? 0 : 1);
