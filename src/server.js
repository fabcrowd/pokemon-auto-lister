import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { VALID_STATUSES } from './queue/queue.js';
import { parseBoundary, parseMultipart } from './server/multipart.js';
import { MARKETPLACES } from './pipeline/processCard.js';
import { inferBackImagePath, resolvePhotoRoles } from './photos/roles.js';
import { findPostedCollision } from './photos/postedLedger.js';
import {
  buildRolesWithInboxFront,
  findMatchingCloseupsForFront,
  listInboxPickerPhotos,
  resolveInboxImagePath,
} from './photos/inboxPick.js';

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function resolveListenOptions(env = process.env) {
  const port = Number.parseInt(env.PORT, 10);
  return {
    host: env.HOST || '0.0.0.0',
    port: Number.isInteger(port) ? port : 3000,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function computeStats(queue) {
  const byStatus = Object.fromEntries(VALID_STATUSES.map((status) => [status, queue.listByStatus(status)]));
  const allRecords = VALID_STATUSES.flatMap((status) => byStatus[status]);

  const totalListValue = allRecords.reduce((sum, record) => {
    const suggested = record.pricedCache?.suggested;
    const values = suggested ? Object.values(suggested).filter((value) => typeof value === 'number') : [];
    return values.length > 0 ? sum + Math.max(...values) : sum;
  }, 0);

  return {
    drafts: byStatus.drafted.length,
    listed: byStatus.listed.length,
    totalListValue,
    queue: byStatus.queued.length + byStatus.pricing.length + byStatus.drafting.length,
    needsReview: byStatus.needs_review.length,
    errors: byStatus.error.length,
    allTime: allRecords.length,
  };
}

function listCards(queue, status) {
  if (status) {
    return queue.listByStatus(status);
  }
  return VALID_STATUSES.flatMap((s) => queue.listByStatus(s));
}

function readJsonBody(req) {
  return readBody(req).then((buffer) => {
    if (buffer.length === 0) {
      return {};
    }
    return JSON.parse(buffer.toString('utf8'));
  });
}

function loadNeedsReviewCard(id, queue, res) {
  let record;
  try {
    record = queue.get(id);
  } catch {
    sendJson(res, 404, { error: 'Card not found' });
    return null;
  }

  if (record.status !== 'needs_review') {
    sendJson(res, 400, { error: 'Card is not awaiting review' });
    return null;
  }

  return record;
}

function listingTitle(record) {
  const identity = record.pricedCache?.identity;
  if (identity?.name) {
    return [identity.name, identity.number, identity.set].filter(Boolean).join(' ');
  }
  return record.title || 'Pokemon Card';
}

async function handleConfirmCard(id, req, res, { queue, createDraft }) {
  const record = loadNeedsReviewCard(id, queue, res);
  if (!record) {
    return undefined;
  }

  const { price } = await readJsonBody(req);
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return sendJson(res, 400, { error: 'price must be a positive number' });
  }

  queue.setPriced(id, {
    ...record.pricedCache,
    suggested: { mercari: price, ebay: price },
  });
  queue.patch(id, { listPrice: price });

  const selected = MARKETPLACES.filter((marketplace) => record[marketplace]);
  // Repost / retry: clear prior marketplace draft flags so the driver runs again.
  for (const marketplace of selected) {
    if (record.drafts?.[marketplace]?.created) {
      queue.clearMarketplaceDraft(id, marketplace);
    }
  }

  const updated = queue.setStatus(id, 'drafting');
  const forDraft = {
    ...updated,
    listPrice: price,
    title: listingTitle(updated),
  };

  if (createDraft) {
    for (const marketplace of selected) {
      await createDraft(marketplace, forDraft);
    }
  }

  const finalRecord = queue.get(id);
  return sendJson(res, 200, {
    id,
    status: finalRecord.status,
    drafts: finalRecord.drafts,
    listingUrl: finalRecord.drafts?.mercari?.listingUrl || null,
    published: finalRecord.status === 'listed' || Boolean(finalRecord.drafts?.mercari?.listingUrl),
  });
}

function handleSkipCard(id, res, { queue }) {
  if (!loadNeedsReviewCard(id, queue, res)) {
    return undefined;
  }

  const updated = queue.setStatus(id, 'error');
  return sendJson(res, 200, { id, status: updated.status });
}

function serveStatic(pathname, res, publicDir) {
  const relativePath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(path.join(publicDir, relativePath));
  const resolvedPublicDir = path.resolve(publicDir);

  if (!resolved.startsWith(resolvedPublicDir) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  const contentType = CONTENT_TYPES[path.extname(resolved)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(readFileSync(resolved));
}

function serveCardFront(id, res, queue) {
  let record;
  try {
    record = queue.get(id);
  } catch {
    return sendJson(res, 404, { error: 'Card not found' });
  }

  const imagePath = record.frontImagePath;
  if (!imagePath || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
    return sendJson(res, 404, { error: 'Front photo not found' });
  }

  const contentType = CONTENT_TYPES[path.extname(imagePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=60' });
  res.end(readFileSync(imagePath));
}

function serveCardPhotoByIndex(id, indexRaw, res, queue) {
  let record;
  try {
    record = queue.get(id);
  } catch {
    return sendJson(res, 404, { error: 'Card not found' });
  }

  const index = Number.parseInt(indexRaw, 10);
  const photos = Array.isArray(record.photos) ? record.photos : [];
  if (!Number.isInteger(index) || index < 0 || index >= photos.length) {
    return sendJson(res, 404, { error: 'Photo not found' });
  }

  const imagePath = photos[index];
  if (!imagePath || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
    return sendJson(res, 404, { error: 'Photo file missing' });
  }

  const contentType = CONTENT_TYPES[path.extname(imagePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=60' });
  res.end(readFileSync(imagePath));
}

async function handlePhotoRoles(id, req, res, { queue, onEnqueue }) {
  const record = loadNeedsReviewCard(id, queue, res);
  if (!record) {
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const photos = Array.isArray(record.photos) ? record.photos : [];
  if (photos.length === 0) {
    return sendJson(res, 400, { error: 'Card has no photos to reassign' });
  }

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'frontImagePath')) {
    patch.frontImagePath = body.frontImagePath;
  } else {
    patch.frontImagePath = record.frontImagePath;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'backImagePath')) {
    patch.backImagePath = body.backImagePath;
  } else if (record.backImagePath !== undefined) {
    patch.backImagePath = record.backImagePath;
  }

  let resolved;
  try {
    resolved = resolvePhotoRoles(photos, patch);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const frontChanged =
    Object.prototype.hasOwnProperty.call(body, 'frontImagePath') &&
    body.frontImagePath !== record.frontImagePath;

  const updated = queue.updatePhotoRoles(id, resolved);

  // Clearing a bad corner-as-front requires a fresh identity/comps run.
  if (frontChanged && typeof onEnqueue === 'function') {
    queue.patch(id, { intakeReason: null, pricedCache: null });
    queue.setStatus(id, 'queued');
    try {
      await onEnqueue(id);
    } catch (err) {
      console.error(`Reprocess after photo roles failed for ${id}:`, err);
    }
    return sendJson(res, 200, queue.get(id));
  }

  return sendJson(res, 200, updated);
}

function handleListInboxPhotos(res, { inboxDir, queue }) {
  const photos = listInboxPickerPhotos(inboxDir, { queue });
  return sendJson(res, 200, {
    inboxDir,
    count: photos.length,
    photos: photos.map((p) => ({
      name: p.name,
      usedByCardId: p.usedByCardId,
    })),
  });
}

function handleServeInboxPhoto(req, res, { inboxDir }) {
  const url = new URL(req.url, 'http://localhost');
  const name = url.searchParams.get('name');
  if (!name) {
    return sendJson(res, 400, { error: 'name query parameter is required' });
  }
  let imagePath;
  try {
    imagePath = resolveInboxImagePath(inboxDir, name);
  } catch (err) {
    return sendJson(res, 404, { error: err.message });
  }
  const contentType = CONTENT_TYPES[path.extname(imagePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=30' });
  res.end(readFileSync(imagePath));
}

async function handleFrontFromInbox(id, req, res, { queue, inboxDir, onEnqueue }) {
  const record = loadNeedsReviewCard(id, queue, res);
  if (!record) {
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const nameOrPath = body.name || body.path || body.frontImagePath;
  let frontPath;
  try {
    frontPath = resolveInboxImagePath(inboxDir, nameOrPath);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const rematch = body.rematchCloseups !== false;
  let extraPaths = [];
  if (rematch) {
    try {
      extraPaths = await findMatchingCloseupsForFront(frontPath, inboxDir, {
        existingPhotos: record.photos || [],
      });
    } catch (err) {
      console.warn(`Close-up rematch failed for ${id}:`, err.message);
    }
  }

  const resolved = buildRolesWithInboxFront(record, frontPath, { extraPaths });
  queue.updatePhotoRoles(id, resolved);
  queue.patch(id, { intakeReason: null, pricedCache: null });
  queue.setStatus(id, 'queued');

  if (typeof onEnqueue === 'function') {
    try {
      await onEnqueue(id);
    } catch (err) {
      console.error(`Reprocess after inbox front pick failed for ${id}:`, err);
    }
  }

  return sendJson(res, 200, {
    ...queue.get(id),
    rematchedCloseups: extraPaths.map((p) => path.basename(p)),
  });
}

async function handleCreateCard(req, res, { queue, dataDir, onEnqueue }) {
  const boundary = parseBoundary(req.headers['content-type']);
  if (!boundary) {
    return sendJson(res, 400, { error: 'Expected multipart/form-data with a boundary' });
  }

  const buffer = await readBody(req);
  const { fields, files } = parseMultipart(buffer, boundary);
  const photos = files.filter((file) => file.fieldName === 'photos' || file.fieldName === 'photos[]');

  if (photos.length === 0) {
    return sendJson(res, 400, { error: 'At least one photo is required' });
  }

  const frontIndex = Number.parseInt(fields.frontIndex, 10);
  if (!Number.isInteger(frontIndex) || frontIndex < 0 || frontIndex >= photos.length) {
    return sendJson(res, 400, { error: 'frontIndex is required and must reference an uploaded photo' });
  }

  const uploadDir = path.join(dataDir, 'uploads', randomUUID());
  mkdirSync(uploadDir, { recursive: true });
  const photoPaths = photos.map((photo, index) => {
    const safeName = path.basename(photo.filename || `photo-${index}`);
    const filePath = path.join(uploadDir, `${index}-${safeName}`);
    writeFileSync(filePath, photo.buffer);
    return filePath;
  });

  const frontImagePath = photoPaths[frontIndex];
  const backImagePath = inferBackImagePath(photoPaths, frontImagePath);
  const ordered = resolvePhotoRoles(photoPaths, { frontImagePath, backImagePath });

  const postedHit = findPostedCollision(dataDir, ordered.photos);
  if (postedHit) {
    return sendJson(res, 409, {
      error: `Photo already used on a drafted/listed card (${postedHit.via}): ${path.basename(postedHit.path)}`,
      cardId: postedHit.cardId,
    });
  }

  const id = queue.enqueue({
    title: fields.title || null,
    photos: ordered.photos,
    frontImagePath: ordered.frontImagePath,
    backImagePath: ordered.backImagePath,
    mercari: fields.mercari === 'true' || fields.mercari === 'on',
    ebay: fields.ebay === 'true' || fields.ebay === 'on',
  });

  if (onEnqueue) {
    Promise.resolve()
      .then(() => onEnqueue(id))
      .catch((err) => {
        try {
          queue.setStatus(id, 'error');
        } catch {
          // record already gone; nothing to mark
        }
        console.error(`onEnqueue failed for card ${id}:`, err);
      });
  }

  return sendJson(res, 201, { id });
}

export function createServer({
  queue,
  dataDir = 'data',
  publicDir = path.join(process.cwd(), 'public'),
  onEnqueue,
  createDraft,
  collectrClient,
  pokegradeCircuit,
  vellumClient,
  getSniperStatus,
  inboxDir = 'autolist-inbox',
  countPendingInbox,
  scanInbox,
  downloadPhotos,
  getDownloadPhotosStatus,
  rescanListedPrices,
  mercariSession,
  ebayDraftClient,
} = {}) {
  if (!queue) {
    throw new Error('createServer requires a queue');
  }

  let inboxScanning = false;
  let photosDownloading = false;
  let priceRescanning = false;
  let mercariConnectPromise = null;
  let mercariConnectError = null;

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cardActionMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/(confirm|skip)$/);
    const photoRolesMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/photos\/roles$/);
    const photoIndexMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/photo$/);

    Promise.resolve()
      .then(async () => {
        if (req.method === 'POST' && url.pathname === '/api/cards') {
          return handleCreateCard(req, res, { queue, dataDir, onEnqueue });
        }
        if (req.method === 'POST' && cardActionMatch && cardActionMatch[2] === 'confirm') {
          return handleConfirmCard(cardActionMatch[1], req, res, { queue, createDraft });
        }
        if (req.method === 'POST' && cardActionMatch && cardActionMatch[2] === 'skip') {
          return handleSkipCard(cardActionMatch[1], res, { queue });
        }
        if (req.method === 'POST' && photoRolesMatch) {
          return handlePhotoRoles(photoRolesMatch[1], req, res, { queue, onEnqueue });
        }
        const frontFromInboxMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/photos\/front-from-inbox$/);
        if (req.method === 'POST' && frontFromInboxMatch) {
          return handleFrontFromInbox(frontFromInboxMatch[1], req, res, { queue, inboxDir, onEnqueue });
        }
        if (req.method === 'GET' && url.pathname === '/api/inbox/photos') {
          return handleListInboxPhotos(res, { inboxDir, queue });
        }
        if (req.method === 'GET' && url.pathname === '/api/inbox/file') {
          return handleServeInboxPhoto(req, res, { inboxDir });
        }
        if (req.method === 'GET' && url.pathname === '/api/inbox/status') {
          const pending =
            typeof countPendingInbox === 'function'
              ? await countPendingInbox()
              : { pendingFolders: 0, pendingPairs: 0, pendingTotal: 0, inboxDir, exists: existsSync(inboxDir) };
          const download =
            typeof getDownloadPhotosStatus === 'function' ? getDownloadPhotosStatus() : {};
          return sendJson(res, 200, {
            inboxDir: pending.inboxDir || inboxDir,
            exists: pending.exists !== false,
            pendingFolders: pending.pendingFolders ?? 0,
            pendingPairs: pending.pendingPairs ?? 0,
            pendingTotal: pending.pendingTotal ?? 0,
            watching: false,
            photosDir: download.photosDir || null,
            photosExists: download.photosExists ?? false,
            lastDownloadAt: download.lastDownloadAt || null,
            lastCopied: download.lastCopied ?? 0,
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/inbox/download-photos') {
          if (typeof downloadPhotos !== 'function') {
            return sendJson(res, 503, { error: 'Photo download is not configured' });
          }
          if (photosDownloading) {
            return sendJson(res, 409, { error: 'Photo download already in progress' });
          }
          let body = {};
          try {
            body = await readJsonBody(req);
          } catch {
            body = {};
          }
          const sinceHours =
            body.sinceHours === null || body.sinceHours === 0
              ? 0
              : Number.isFinite(Number(body.sinceHours))
                ? Number(body.sinceHours)
                : undefined;
          photosDownloading = true;
          try {
            const result = downloadPhotos(
              sinceHours === undefined ? {} : { sinceHours },
            );
            if (result.error) {
              return sendJson(res, 400, result);
            }
            const pending =
              typeof countPendingInbox === 'function'
                ? await countPendingInbox()
                : { pendingTotal: 0 };
            return sendJson(res, 200, {
              ...result,
              pendingTotal: pending.pendingTotal ?? 0,
            });
          } finally {
            photosDownloading = false;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/inbox/scan') {
          if (typeof scanInbox !== 'function') {
            return sendJson(res, 503, { error: 'Inbox scan is not configured' });
          }
          if (inboxScanning) {
            return sendJson(res, 409, { error: 'Inbox scan already in progress' });
          }
          let body = {};
          try {
            body = await readJsonBody(req);
          } catch {
            body = {};
          }
          inboxScanning = true;
          try {
            const result = await scanInbox({
              marketplaceDefaults: {
                mercari: body.mercari !== false && body.mercari !== 'false',
                ebay: body.ebay === true || body.ebay === 'true',
              },
              forceRescan:
                body.forceRescan === true ||
                body.forceRescan === 'true' ||
                body.rescan === true ||
                body.rescan === 'true',
            });
            const enqueued = Array.isArray(result) ? result : result?.enqueued || [];
            const updated = Array.isArray(result) ? [] : result?.updated || [];
            const pending =
              typeof countPendingInbox === 'function'
                ? await countPendingInbox()
                : { pendingTotal: 0 };
            return sendJson(res, 200, {
              enqueued,
              updated,
              count: enqueued.length,
              updatedCount: updated.length,
              pendingTotal: pending.pendingTotal ?? 0,
            });
          } finally {
            inboxScanning = false;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/listings/rescan-prices') {
          if (typeof rescanListedPrices !== 'function') {
            return sendJson(res, 503, { error: 'Price rescan is not configured' });
          }
          if (priceRescanning) {
            return sendJson(res, 409, { error: 'Price rescan already in progress' });
          }
          priceRescanning = true;
          try {
            const summary = await rescanListedPrices();
            return sendJson(res, 200, summary);
          } finally {
            priceRescanning = false;
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/mercari/status') {
          const base = mercariSession?.getStatus?.() ?? { loggedIn: false, browserOpen: false };
          return sendJson(res, 200, {
            ...base,
            connecting: Boolean(mercariConnectPromise),
            error: mercariConnectError,
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/mercari/connect') {
          if (!mercariSession?.connect) {
            return sendJson(res, 503, { error: 'Mercari session is not configured' });
          }
          const current = mercariSession.getStatus();
          if (current.loggedIn) {
            return sendJson(res, 200, {
              ...current,
              connecting: false,
              message: 'Already connected to Mercari',
            });
          }
          if (!mercariConnectPromise) {
            mercariConnectError = null;
            mercariConnectPromise = mercariSession
              .connect()
              .then(() => {
                mercariConnectError = null;
              })
              .catch((err) => {
                mercariConnectError = err.message;
              })
              .finally(() => {
                mercariConnectPromise = null;
              });
          }
          return sendJson(res, 200, {
            ...mercariSession.getStatus(),
            connecting: true,
            message: 'Chrome opened — log into Mercari in that window (not your everyday Chrome)',
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/ebay/status') {
          const status = ebayDraftClient?.getStatus?.() ?? {
            configured: false,
            connected: false,
          };
          return sendJson(res, 200, status);
        }
        if (req.method === 'POST' && url.pathname === '/api/ebay/connect') {
          if (!ebayDraftClient?.connect) {
            return sendJson(res, 503, { error: 'eBay draft client is not configured' });
          }
          try {
            const status = await ebayDraftClient.connect();
            return sendJson(res, 200, {
              ...status,
              message: status.connected
                ? 'eBay OAuth token OK — drafts will use this account'
                : 'eBay not connected',
            });
          } catch (err) {
            return sendJson(res, 400, {
              configured: ebayDraftClient.getStatus?.().configured ?? false,
              connected: false,
              error: err.message,
              message:
                'eBay connect failed — check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_REFRESH_TOKEN in .env',
            });
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/stats') {
          return sendJson(res, 200, computeStats(queue));
        }
        if (req.method === 'GET' && url.pathname === '/api/collectr-status') {
          return sendJson(res, 200, collectrClient?.stats?.() ?? { exists: false, stale: true, rowCount: 0 });
        }
        if (req.method === 'GET' && url.pathname === '/api/identity-status') {
          const circuit = pokegradeCircuit?.status?.() ?? { open: false };
          return sendJson(res, 200, {
            mode: process.env.IDENTITY_MODE || 'dual',
            vellumEnabled: String(process.env.VELLUM_AI_ENABLED || 'false').toLowerCase() === 'true',
            vellumUrl: process.env.VELLUM_AI_URL || 'http://127.0.0.1:8787',
            circuit,
            solo:
              circuit.open ||
              (process.env.IDENTITY_MODE || 'dual') === 'local-only',
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/pokegrade-circuit/reset') {
          pokegradeCircuit?.reset?.();
          return sendJson(res, 200, { ok: true, circuit: pokegradeCircuit?.status?.() ?? { open: false } });
        }
        if (req.method === 'GET' && url.pathname === '/api/sniper') {
          const status =
            typeof getSniperStatus === 'function'
              ? getSniperStatus()
              : {
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
          return sendJson(res, 200, status);
        }
        if (req.method === 'GET' && url.pathname === '/api/cards') {
          return sendJson(res, 200, listCards(queue, url.searchParams.get('status')));
        }
        const frontPhotoMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/front$/);
        if (req.method === 'GET' && frontPhotoMatch) {
          return serveCardFront(frontPhotoMatch[1], res, queue);
        }
        if (req.method === 'GET' && photoIndexMatch) {
          return serveCardPhotoByIndex(photoIndexMatch[1], url.searchParams.get('index'), res, queue);
        }
        if (req.method === 'GET') {
          return serveStatic(url.pathname, res, publicDir);
        }
        return sendJson(res, 404, { error: 'Not found' });
      })
      .catch((err) => {
        sendJson(res, 500, { error: err.message });
      });
  });
}
