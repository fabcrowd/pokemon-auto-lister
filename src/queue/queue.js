import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { recordPostedPhotos } from '../photos/postedLedger.js';

export const VALID_STATUSES = ['queued', 'pricing', 'needs_review', 'drafting', 'drafted', 'listed', 'error'];

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
    // Prefer listed if another marketplace already listed; otherwise drafted.
    if (record.status !== 'listed') {
      record.status = 'drafted';
    }
    const saved = writeRecord(record);
    recordPostedPhotos(dataDir, saved);
    return saved;
  }

  function markListed(id, marketplace, listingInfo = {}) {
    const record = readRecord(id);
    if (record.drafts[marketplace]?.created && record.drafts[marketplace]?.listingUrl) {
      return record;
    }
    record.drafts[marketplace] = {
      created: true,
      listedAt: new Date().toISOString(),
      ...listingInfo,
    };
    record.status = 'listed';
    const saved = writeRecord(record);
    recordPostedPhotos(dataDir, saved);
    return saved;
  }

  function recordDraftError(id, marketplace, message) {
    const record = readRecord(id);
    record.drafts[marketplace] = {
      created: false,
      error: message,
      failedAt: new Date().toISOString(),
    };
    // Return to needs_review so the dashboard can show the error and retry Go.
    record.status = 'needs_review';
    return writeRecord(record);
  }

  function updatePhotoRoles(id, { frontImagePath, backImagePath, photos }) {
    const record = readRecord(id);
    if (frontImagePath !== undefined) {
      record.frontImagePath = frontImagePath;
    }
    if (backImagePath !== undefined) {
      record.backImagePath = backImagePath;
    }
    if (Array.isArray(photos)) {
      record.photos = photos;
    }
    return writeRecord(record);
  }

  /**
   * Shallow-merge top-level fields (and replace nested objects when provided).
   * Does not change status unless `status` is in fields.
   */
  function patch(id, fields = {}) {
    const record = readRecord(id);
    const { status, ...rest } = fields;
    Object.assign(record, rest);
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      record.status = status;
    }
    return writeRecord(record);
  }

  function clearMarketplaceDraft(id, marketplace) {
    const record = readRecord(id);
    if (record.drafts && record.drafts[marketplace]) {
      delete record.drafts[marketplace];
    }
    return writeRecord(record);
  }

  function listAll() {
    const files = readdirSync(queueDir).filter((name) => name.endsWith('.json'));
    return files.map((name) => JSON.parse(readFileSync(path.join(queueDir, name), 'utf8')));
  }

  function listByStatus(status) {
    return listAll().filter((record) => record.status === status);
  }

  return {
    enqueue,
    get,
    setStatus,
    setPriced,
    markDrafted,
    markListed,
    recordDraftError,
    updatePhotoRoles,
    patch,
    clearMarketplaceDraft,
    listAll,
    listByStatus,
  };
}
