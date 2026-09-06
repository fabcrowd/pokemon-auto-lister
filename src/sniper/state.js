import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

function emptyState() {
  return {
    seen: {},
    hearted: {},
    worklist: {},
    suspects: {},
    recentHearts: [],
    lastCycle: null,
  };
}

/**
 * Durable sniper ledgers. seen and hearted stay separate so a crash between
 * grade and heart never causes a double-click (which would un-heart).
 *
 * @param {string} [dataDir]
 */
export function createSniperState(dataDir = 'data') {
  const dir = path.join(dataDir, 'sniper');
  const statePath = path.join(dir, 'state.json');

  function ensureDir() {
    mkdirSync(dir, { recursive: true });
  }

  function read() {
    if (!existsSync(statePath)) {
      return emptyState();
    }
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      return {
        ...emptyState(),
        ...parsed,
        seen: parsed.seen ?? {},
        hearted: parsed.hearted ?? {},
        worklist: parsed.worklist ?? {},
        suspects: parsed.suspects ?? {},
        recentHearts: Array.isArray(parsed.recentHearts) ? parsed.recentHearts : [],
      };
    } catch {
      return emptyState();
    }
  }

  function write(state) {
    ensureDir();
    atomicWriteJson(statePath, state);
  }

  function isSeen(itemId) {
    return Boolean(read().seen[itemId]);
  }

  function isHearted(itemId) {
    return Boolean(read().hearted[itemId]);
  }

  function markSeen(itemId, meta = {}) {
    const state = read();
    state.seen[itemId] = { at: new Date().toISOString(), ...meta };
    write(state);
  }

  function markHearted(itemId, meta = {}) {
    const state = read();
    const entry = { at: new Date().toISOString(), ...meta };
    state.hearted[itemId] = entry;
    state.seen[itemId] = state.seen[itemId] ?? entry;
    state.recentHearts = [{ itemId, ...entry }, ...state.recentHearts].slice(0, 50);
    write(state);
  }

  function addWorklist(itemId, meta = {}) {
    const state = read();
    const entry = { at: new Date().toISOString(), ...meta };
    state.worklist[itemId] = entry;
    state.seen[itemId] = state.seen[itemId] ?? entry;
    write(state);
  }

  function addSuspect(itemId, meta = {}) {
    const state = read();
    const entry = { at: new Date().toISOString(), ...meta };
    state.suspects[itemId] = entry;
    state.seen[itemId] = state.seen[itemId] ?? entry;
    write(state);
  }

  function setLastCycle(cycle) {
    const state = read();
    state.lastCycle = cycle;
    write(state);
  }

  function entriesNewestFirst(map, limit = 20) {
    return Object.entries(map)
      .map(([itemId, meta]) => ({ itemId, ...meta }))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, limit);
  }

  function getStatus() {
    const state = read();
    return {
      seenCount: Object.keys(state.seen).length,
      heartedCount: Object.keys(state.hearted).length,
      worklistCount: Object.keys(state.worklist).length,
      suspectCount: Object.keys(state.suspects).length,
      recentHearts: state.recentHearts.slice(0, 20),
      worklist: entriesNewestFirst(state.worklist, 20),
      suspects: entriesNewestFirst(state.suspects, 20),
      lastCycle: state.lastCycle,
    };
  }

  return {
    isSeen,
    isHearted,
    markSeen,
    markHearted,
    addWorklist,
    addSuspect,
    setLastCycle,
    getStatus,
    read,
  };
}
