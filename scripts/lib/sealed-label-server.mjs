import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCards } from '../../tools/extension-wasm/lib/card-picker.js';
import { localHostAllowed } from './sealed-paths.mjs';
import { currentLabels, drawnFor, isPhotoDone, isSha, progressOf, validPhotoRow, validateLabel } from './sealed-labels.mjs';

const LIB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/extension-wasm/lib');
const MAX_BODY = 8 * 1024;
const MAX_DRAIN = 1024 * 1024;
const MAX_QUERY = 120;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/labeler.js': ['labeler.js', 'text/javascript; charset=utf-8'],
  '/labeler.css': ['labeler.css', 'text/css; charset=utf-8'],
};
// Catalog thumbnails come from TCGdex and pokemontcg.io, so images may load from any https host; nothing else may.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const THUMB_FIELDS = ['id', 'name', 'set', 'setCode', 'number', 'imageUrl'];

const sendJson = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_DRAIN) req.destroy();
      else if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return resolve({ status: 413 });
      try {
        resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ status: 400 });
      }
    });
    req.on('error', () => resolve({ status: 400 }));
  });
}

/**
 * Local labeling page for the sealed set. It never shows a listing title, URL or scanner output.
 * @param dir the sealed-test folder (photos.jsonl, photos/, labels.jsonl)
 * @param catalog card rows from data/card-catalog/meta.json
 * @param staticDir folder holding index.html, labeler.js and labeler.css
 * @param libDir the extension's lib folder, served so the page can reuse card-picker.js
 */
export function createLabelerServer({ dir, catalog, staticDir, libDir = LIB_DIR }) {
  const root = path.resolve(dir);
  const labelsFile = path.join(root, 'labels.jsonl');
  const byId = new Map(catalog.map((card) => [card.id, card]));
  const photos = fs.readFileSync(path.join(root, 'photos.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter(validPhotoRow);
  const bySha = new Map(photos.map((row) => [row.sha, row]));

  const readLabels = () => {
    try {
      return currentLabels(fs.readFileSync(labelsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    } catch (err) {
      if (err?.code === 'ENOENT') return currentLabels([]);
      throw err;
    }
  };

  const itemOf = (photo, boxIndex, current) => ({
    review: boxIndex === null,
    drawn: drawnFor(photo.sha, current).map(({ drawnId, box, kind }) => ({ drawnId, box, kind })),
    sha: photo.sha,
    photoUrl: `/photos/${photo.sha}.jpg`,
    width: photo.width,
    height: photo.height,
    boxes: photo.boxes,
    boxIndex,
    missed: current.photos.get(photo.sha)?.missed ?? 0,
  });

  function nextItem(current) {
    for (const photo of photos) {
      if (isPhotoDone(photo, current)) continue;
      const open = photo.boxes.findIndex((_, index) => !current.boxes.has(`${photo.sha}:${index}`));
      return itemOf(photo, open >= 0 ? open : null, current);
    }
    return null;
  }

  function route(req, res, url) {
    const { pathname } = url;
    if (pathname === '/api/next' && req.method === 'GET') {
      const current = readLabels();
      const item = nextItem(current);
      return sendJson(res, 200, { done: !item, item, progress: progressOf(photos, current) });
    }
    if (pathname === '/api/item' && req.method === 'GET') {
      const sha = url.searchParams.get('sha');
      const photo = isSha(sha) ? bySha.get(sha) : null;
      const raw = url.searchParams.get('boxIndex');
      const boxIndex = raw === null || raw === '' ? null : Number(raw);
      if (!isSha(sha) || (boxIndex !== null && (!Number.isInteger(boxIndex) || boxIndex < 0))) {
        return sendJson(res, 400, { error: 'sha or boxIndex is not valid' });
      }
      if (!photo) return sendJson(res, 404, { error: 'No such photo' });
      if (boxIndex !== null && boxIndex >= photo.boxes.length) return sendJson(res, 400, { error: 'boxIndex is out of range' });
      const current = readLabels();
      return sendJson(res, 200, { item: itemOf(photo, boxIndex, current), progress: progressOf(photos, current) });
    }
    if (pathname === '/api/find' && req.method === 'GET') {
      const query = (url.searchParams.get('q') || '').slice(0, MAX_QUERY + 1);
      const cards = query.length > MAX_QUERY ? [] : findCards(catalog, query, { limit: 20 });
      return sendJson(res, 200, { cards: cards.map((card) => Object.fromEntries(THUMB_FIELDS.map((key) => [key, card[key] ?? null]))) });
    }
    if (pathname === '/api/label') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Send application/json' });
      }
      return readJsonBody(req).then(({ body, status }) => {
        if (status) return sendJson(res, status, { error: status === 413 ? 'Body too large' : 'Body is not JSON' });
        let row;
        try {
          row = validateLabel(body, { photo: bySha.get(body?.sha), catalogHas: (id) => byId.has(id) });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        fs.appendFileSync(labelsFile, JSON.stringify(row) + '\n');
        const current = readLabels();
        return sendJson(res, 200, { ok: true, progress: progressOf(photos, current), missed: current.photos.get(row.sha)?.missed ?? 0 });
      }).catch((err) => failed(res, err));
    }
    const photoMatch = pathname.match(/^\/photos\/([0-9a-f]{64})\.jpg$/);
    if (photoMatch && req.method === 'GET') {
      const photo = bySha.get(photoMatch[1]);
      const file = photo ? path.join(root, photo.file) : null;
      if (!file || !fs.existsSync(file)) {
        return sendJson(res, 404, { error: 'No such photo' });
      }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }
    const lib = req.method === 'GET' ? pathname.match(/^\/lib\/([a-z][a-z-]*\.js)$/)?.[1] : null;
    if (lib && fs.existsSync(path.join(libDir, lib))) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(libDir, lib)).pipe(res);
    }
    const asset = req.method === 'GET' ? STATIC[pathname] : null;
    if (asset) {
      res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(staticDir, asset[0])).pipe(res);
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  const failed = (res, err) => {
    console.error('labeler:', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong' });
  };

  return http.createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    // A web page open elsewhere could reach this port through a hostname it controls.
    if (!localHostAllowed(req.headers.host, req.socket.localPort)) return sendJson(res, 403, { error: 'Local access only' });
    try {
      return route(req, res, new URL(req.url, 'http://local'));
    } catch (err) {
      return failed(res, err);
    }
  });
}
