import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSniperState } from './state.js';
import { runSniperCycle } from './cycle.js';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../config/sniper-strategies.json', import.meta.url));

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isSniperEnabled(env = process.env) {
  const value = String(env.SNIPER_ENABLED ?? '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * Load sniper config with optional interval override from env.
 *
 * @param {{ configPath?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function loadSniperConfig({ configPath = DEFAULT_CONFIG_PATH, env = process.env } = {}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const intervalOverride = Number.parseInt(env.SNIPER_INTERVAL_MS, 10);
  if (Number.isInteger(intervalOverride) && intervalOverride > 0) {
    config.intervalMs = intervalOverride;
  }
  return config;
}

/**
 * Start the Mercari sniper interval loop. Returns a handle with stop() and getStatus().
 *
 * @param {object} options
 */
export function startSniper({
  mercariSession,
  pokegradeClient,
  dataDir = 'data',
  configPath = DEFAULT_CONFIG_PATH,
  env = process.env,
  runCycle = runSniperCycle,
  sniperState = createSniperState(dataDir),
} = {}) {
  if (!mercariSession?.withMercariPage) {
    throw new Error('startSniper requires mercariSession.withMercariPage');
  }
  if (!pokegradeClient?.evaluateImageUrl) {
    throw new Error('startSniper requires pokegradeClient.evaluateImageUrl');
  }

  const config = loadSniperConfig({ configPath, env });
  const intervalMs = config.intervalMs ?? 600_000;
  let timer = null;
  let running = false;
  let stopped = false;

  async function tick() {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      console.log('Sniper: starting Mercari scan cycle…');
      const summary = await runCycle({
        config,
        mercariSession,
        pokegradeClient,
        sniperState,
      });
      console.log(
        `Sniper cycle done: hearted=${summary.hearted} worklist=${summary.worklist} suspects=${summary.suspects} deferred=${summary.deferred}`,
      );
    } catch (err) {
      console.error('Sniper cycle failed:', err.message);
      sniperState.setLastCycle({
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: err.message,
        hearted: 0,
        worklist: 0,
        suspects: 0,
        skipped: 0,
        deferred: 0,
        errors: 1,
        strategies: [],
      });
    } finally {
      running = false;
    }
  }

  console.log(`Sniper enabled — interval ${intervalMs}ms; strategies=${(config.strategies ?? []).length}`);
  // Kick off soon after boot (give sell Mercari login a moment), then on interval
  const initialDelay = Math.min(15_000, intervalMs);
  timer = globalThis.setTimeout(() => {
    tick();
    timer = globalThis.setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }, initialDelay);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer) {
      globalThis.clearTimeout(timer);
      globalThis.clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return {
      enabled: true,
      running,
      intervalMs,
      thresholds: config.thresholds ?? { heartRatio: 1.25, worklistMin: 1.15, suspectRatio: 5 },
      strategies: (config.strategies ?? []).map((s) => ({
        id: s.id,
        mode: s.mode,
        query: s.query,
        grade: s.grade ?? null,
      })),
      ...sniperState.getStatus(),
    };
  }

  return { stop, getStatus, tick, sniperState };
}

/**
 * Disabled-sniper status stub for the dashboard when SNIPER_ENABLED is off.
 */
export function disabledSniperStatus() {
  return {
    enabled: false,
    running: false,
    intervalMs: null,
    strategies: [],
    thresholds: { heartRatio: 1.25, worklistMin: 1.15, suspectRatio: 5 },
    seenCount: 0,
    heartedCount: 0,
    worklistCount: 0,
    suspectCount: 0,
    recentHearts: [],
    worklist: [],
    suspects: [],
    lastCycle: null,
  };
}

export { DEFAULT_CONFIG_PATH };
