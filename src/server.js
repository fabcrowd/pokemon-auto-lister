import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { VALID_STATUSES } from './queue/queue.js';
import { parseBoundary, parseMultipart } from './server/multipart.js';

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
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

const MARKETPLACES = ['mercari', 'ebay'];

async function handleConfirmCard(id, req, res, { queue, createDraft }) {
  let record;
  try {
    record = queue.get(id);
  } catch {
    return sendJson(res, 404, { error: 'Card not found' });
  }

  if (record.status !== 'needs_review') {
    return sendJson(res, 400, { error: 'Card is not awaiting review' });
  }

  const { price } = await readJsonBody(req);
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return sendJson(res, 400, { error: 'price must be a positive number' });
  }

  queue.setPriced(id, {
    ...record.pricedCache,
    suggested: { mercari: price, ebay: price },
  });
  const updated = queue.setStatus(id, 'drafting');

  if (createDraft) {
    const selected = MARKETPLACES.filter((marketplace) => updated[marketplace]);
    for (const marketplace of selected) {
      await createDraft(marketplace, updated);
    }
  }

  return sendJson(res, 200, { id, status: updated.status });
}

function handleSkipCard(id, res, { queue }) {
  let record;
  try {
    record = queue.get(id);
  } catch {
    return sendJson(res, 404, { error: 'Card not found' });
  }

  if (record.status !== 'needs_review') {
    return sendJson(res, 400, { error: 'Card is not awaiting review' });
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

  const id = queue.enqueue({
    title: fields.title || null,
    photos: photoPaths,
    frontImagePath: photoPaths[frontIndex],
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
} = {}) {
  if (!queue) {
    throw new Error('createServer requires a queue');
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cardActionMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/(confirm|skip)$/);

    Promise.resolve()
      .then(() => {
        if (req.method === 'POST' && url.pathname === '/api/cards') {
          return handleCreateCard(req, res, { queue, dataDir, onEnqueue });
        }
        if (req.method === 'POST' && cardActionMatch && cardActionMatch[2] === 'confirm') {
          return handleConfirmCard(cardActionMatch[1], req, res, { queue, createDraft });
        }
        if (req.method === 'POST' && cardActionMatch && cardActionMatch[2] === 'skip') {
          return handleSkipCard(cardActionMatch[1], res, { queue });
        }
        if (req.method === 'GET' && url.pathname === '/api/stats') {
          return sendJson(res, 200, computeStats(queue));
        }
        if (req.method === 'GET' && url.pathname === '/api/cards') {
          return sendJson(res, 200, listCards(queue, url.searchParams.get('status')));
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
