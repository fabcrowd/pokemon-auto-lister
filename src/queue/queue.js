import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const VALID_STATUSES = ['queued', 'pricing', 'needs_review', 'drafting', 'drafted', 'error'];

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

export function createQueue(dataDir) {
  const queueDir = path.join(dataDir, 'queue');
  mkdirSync(queueDir, { recursive: true });

  function recordPath(id) {
    return path.join(queueDir, `${id}.json`);
  }

  function readRecord(id) {
    const filePath = recordPath(id);
    if (!existsSync(filePath)) {
      throw new Error(`Card not found: ${id}`);
    }
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }

  function writeRecord(record) {
    record.updatedAt = new Date().toISOString();
    atomicWriteJson(recordPath(record.id), record);
    return record;
  }

  function enqueue(card) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record = {
      ...card,
      id,
      status: 'queued',
      drafts: {},
      pricedCache: null,
      createdAt: now,
      updatedAt: now,
    };
    atomicWriteJson(recordPath(id), record);
    return id;
  }

  function get(id) {
    return readRecord(id);
  }

  function setStatus(id, status) {
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }
    const record = readRecord(id);
    record.status = status;
    return writeRecord(record);
  }

  function setPriced(id, pricedCache) {
    const record = readRecord(id);
    record.pricedCache = pricedCache;
    record.status = 'pricing';
    return writeRecord(record);
  }

  function markDrafted(id, marketplace, draftInfo = {}) {
    const record = readRecord(id);
    if (record.drafts[marketplace]?.created) {
      return record;
    }
    record.drafts[marketplace] = {
      created: true,
      draftedAt: new Date().toISOString(),
      ...draftInfo,
    };
    record.status = 'drafted';
    return writeRecord(record);
  }

  function listByStatus(status) {
    const files = readdirSync(queueDir).filter((name) => name.endsWith('.json'));
    return files
      .map((name) => JSON.parse(readFileSync(path.join(queueDir, name), 'utf8')))
      .filter((record) => record.status === status);
  }

  return { enqueue, get, setStatus, setPriced, markDrafted, listByStatus };
}
