import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { VALID_STATUSES } from './queue/queue.js';

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

function parseBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) {
    return null;
  }
  return match[1] || match[2];
}

function parseMultipart(buffer, boundary) {
  const raw = buffer.toString('binary');
  const rawParts = raw.split(`--${boundary}`).slice(1, -1);
  const fields = {};
  const files = [];

  for (let part of rawParts) {
    if (part.startsWith('\r\n')) {
      part = part.slice(2);
    }
    if (part.endsWith('\r\n')) {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      continue;
    }
    const headerBlock = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4);

    const dispositionMatch =
      /Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerBlock);
    if (!dispositionMatch) {
      continue;
    }
    const [, name, filename] = dispositionMatch;

    if (filename !== undefined) {
      const contentTypeMatch = /Content-Type:\s*(.+)/i.exec(headerBlock);
      files.push({
        fieldName: name,
        filename,
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
        buffer: Buffer.from(body, 'binary'),
      });
    } else {
      fields[name] = body;
    }
  }

  return { fields, files };
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

export function createServer({ queue, dataDir = 'data', publicDir = path.join(process.cwd(), 'public'), onEnqueue } = {}) {
  if (!queue) {
    throw new Error('createServer requires a queue');
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    Promise.resolve()
      .then(() => {
        if (req.method === 'POST' && url.pathname === '/api/cards') {
          return handleCreateCard(req, res, { queue, dataDir, onEnqueue });
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
