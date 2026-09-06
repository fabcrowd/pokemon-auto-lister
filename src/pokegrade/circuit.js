import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Persist PokeGrade free-tier / quota circuit state so we stop calling PG.
 */

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

/**
 * @param {string} dataDir
 * @param {number} [ttlHours]
 */
export function createPokegradeCircuit({
  dataDir = 'data',
  ttlHours = Number(process.env.POKEGRADE_CIRCUIT_TTL_HOURS || 24),
} = {}) {
  const circuitPath = path.join(dataDir, 'pokegrade-circuit.json');

  function readState() {
    if (!existsSync(circuitPath)) {
      return { open: false };
    }
    try {
      return JSON.parse(readFileSync(circuitPath, 'utf8'));
    } catch {
      return { open: false };
    }
  }

  function writeState(state) {
    mkdirSync(dataDir, { recursive: true });
    atomicWriteJson(circuitPath, state);
  }

  /**
   * @returns {{ open: boolean, reason?: string, openedAt?: string, resetAt?: string }}
   */
  function status() {
    const state = readState();
    if (!state.open) {
      return { open: false };
    }
    if (state.resetAt && Date.parse(state.resetAt) <= Date.now()) {
      writeState({ open: false, closedAt: new Date().toISOString(), reason: 'ttl-expired' });
      return { open: false };
    }
    return {
      open: true,
      reason: state.reason ?? null,
      openedAt: state.openedAt ?? null,
      resetAt: state.resetAt ?? null,
    };
  }

  function isOpen() {
    return status().open;
  }

  /**
   * @param {string} reason
   */
  function open(reason = 'quota') {
    const openedAt = new Date();
    const resetAt = new Date(openedAt.getTime() + Math.max(1, ttlHours) * 60 * 60 * 1000);
    writeState({
      open: true,
      reason: String(reason),
      openedAt: openedAt.toISOString(),
      resetAt: resetAt.toISOString(),
    });
  }

  function reset() {
    writeState({ open: false, closedAt: new Date().toISOString(), reason: 'manual-reset' });
  }

  return { status, isOpen, open, reset, path: circuitPath };
}

/**
 * True when status/body looks like free-tier burnout / rate limit.
 * @param {number} statusCode
 * @param {string} [bodyText]
 */
export function isQuotaExhaustedStatus(statusCode, bodyText = '') {
  if (statusCode === 402 || statusCode === 403 || statusCode === 429) {
    return true;
  }
  const text = String(bodyText).toLowerCase();
  return /quota|rate.?limit|credit|free.?tier|usage.?limit|insufficient/.test(text);
}
