import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

import sharp from 'sharp';
import { parseBoundary, parseMultipart } from './server/multipart.js';
import { RetryablePokegradeError } from './pokegrade/client.js';
import { inferBackImagePath } from './photos/roles.js';

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

function serveScanPhoto(dirRaw, indexRaw, res, dataDir) {
  if (!dirRaw || /[/\\]/.test(dirRaw)) {
    return sendJson(res, 400, { error: 'Invalid dir' });
  }
  const scanDir = path.join(dataDir, 'scans', dirRaw);
  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isInteger(index) || index < 0) {
    return sendJson(res, 400, { error: 'Invalid index' });
  }
  let files;
  try {
    files = readdirSync(scanDir).filter((f) => f.startsWith(`${index}-`));
  } catch {
    return sendJson(res, 404, { error: 'Scan dir not found' });
  }
  if (files.length === 0) {
    return sendJson(res, 404, { error: 'Photo not found' });
  }
  const imagePath = path.join(scanDir, files[0]);
  if (!existsSync(imagePath) || !statSync(imagePath).isFile()) {
    return sendJson(res, 404, { error: 'Photo file missing' });
  }
  const contentType = CONTENT_TYPES[path.extname(imagePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' });
  res.end(readFileSync(imagePath));
}

function confidenceFromVellum(vellumConfidence) {
  if (vellumConfidence === 'high') return 0.9;
  if (vellumConfidence === 'medium') return 0.65;
  if (vellumConfidence === 'low') return 0.3;
  return 0.7;
}

function mapPricedToCard(priced, box) {
  const confidence = confidenceFromVellum(priced?.vellumConfidence);
  let market_price = null;
  let price_variant = null;
  if (priced?.suggested && typeof priced.suggested === 'object') {
    for (const [key, val] of Object.entries(priced.suggested)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        market_price = val;
        price_variant = key;
        break;
      }
    }
  }
  return {
    box,
    identity: priced?.identity ?? null,
    confidence,
    market_price,
    price_variant: price_variant ?? null,
    abstain: !priced?.ok || !priced?.identity || priced?.identity?.name === 'Unknown' || priced?.identity?.name === 'unknown',
  };
}

async function imageMeanBrightness(buffer) {
  try {
    const stats = await sharp(buffer).greyscale().stats();
    return stats.channels[0].mean;
  } catch {
    return 128;
  }
}

// Card backs (dark blue Pokemon card backs) have mean ~74-88; legitimate fronts tend to be brighter.
const DARK_CARD_BACK_THRESHOLD = 100;

function hasUsableIdentity(result) {
  const name = result?.identity?.name;
  return result?.ok && name && name !== 'Unknown' && name !== 'unknown';
}

async function tryPreprocessFallbacks(imageBuffer, detectDir, scanAndPrice, box) {
  const transforms = [
    (buf) => sharp(buf).normalize().sharpen({ sigma: 2 }).toBuffer(),
    (buf) => sharp(buf).clahe({ width: 3, height: 3 }).sharpen({ sigma: 1 }).toBuffer(),
    (buf) => sharp(buf).rotate(180).toBuffer(),
  ];

  for (const transform of transforms) {
    try {
      const processed = await transform(imageBuffer);
      const imgPath = path.join(detectDir, `pp-${randomUUID().slice(0, 8)}.jpg`);
      writeFileSync(imgPath, processed);
      const result = await scanAndPrice({ frontImagePath: imgPath });
      if (hasUsableIdentity(result)) {
        return { cards: [mapPricedToCard(result, box)] };
      }
    } catch {
      // continue to next transform
    }
  }
  return null;
}

async function tryTileFallback(imageBuffer, detectDir, scanAndPrice, box) {
  const mean = await imageMeanBrightness(imageBuffer);
  if (mean < DARK_CARD_BACK_THRESHOLD) return null;

  let meta;
  try {
    meta = await sharp(imageBuffer).metadata();
  } catch {
    return null;
  }

  const tileCount = 3;
  const tileHeight = Math.floor(meta.height / tileCount);

  for (let i = 0; i < tileCount; i++) {
    const top = i * tileHeight;
    const height = i === tileCount - 1 ? meta.height - top : tileHeight;
    try {
      const tileBuffer = await sharp(imageBuffer)
        .extract({ left: 0, top, width: meta.width, height })
        .sharpen({ sigma: 2 })
        .toBuffer();
      const tilePath = path.join(detectDir, `tile-${i}-${randomUUID().slice(0, 8)}.jpg`);
      writeFileSync(tilePath, tileBuffer);
      const tilePriced = await scanAndPrice({ frontImagePath: tilePath });
      if (hasUsableIdentity(tilePriced)) {
        return { cards: [mapPricedToCard(tilePriced, box)] };
      }
    } catch {
      // continue to next tile
    }
  }
  return null;
}

async function handleDetect(req, res, { dataDir, scanAndPrice, multiCardSplitter }) {
  if (typeof scanAndPrice !== 'function') {
    return sendJson(res, 503, { error: 'Scanner not configured' });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  if (!body?.image_b64 || typeof body.image_b64 !== 'string') {
    return sendJson(res, 400, { error: 'image_b64 required' });
  }

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(body.image_b64, 'base64');
  } catch {
    return sendJson(res, 400, { error: 'Invalid base64' });
  }

  const detectDir = path.join(dataDir, 'detect-tmp', randomUUID());
  mkdirSync(detectDir, { recursive: true });

  let rawCards = null;
  if (multiCardSplitter?.detectRaw) {
    rawCards = await multiCardSplitter.detectRaw(imageBuffer);
  }

  // Filter out zero-confidence phantom detections that appear when a large crop
  // is recursively re-sent to the sidecar and spawns dozens of sub-detections.
  if (rawCards) {
    rawCards = rawCards.filter((c) => !Number.isFinite(c.conf) || c.conf >= 0.05);
    if (rawCards.length === 0) rawCards = null;
  }

  // Single-card path: covers both (a) no sidecar detection and (b) sidecar found
  // exactly 1 card.  In case (b) the sidecar re-crop often degrades quality
  // (especially for corner_closeup classifications), so we always use the
  // original buffer and only borrow the sidecar's tighter bounding box.
  if (!rawCards || rawCards.length <= 1) {
    const box =
      Array.isArray(rawCards?.[0]?.box) ? rawCards[0].box : [0, 0, 640, 480];
    // Sidecar found 1 card but couldn't classify it (conf/class undefined) — flag for tile fallback.
    const isUnclassifiedDetection = rawCards?.length === 1 && !Number.isFinite(rawCards[0]?.conf);

    let processedBuffer = imageBuffer;
    try {
      processedBuffer = await sharp(imageBuffer).sharpen({ sigma: 2 }).toBuffer();
    } catch {
      // fallback to original
    }

    const framePath = path.join(detectDir, `card-${randomUUID().slice(0, 8)}.jpg`);
    writeFileSync(framePath, processedBuffer);
    let priced;
    try {
      priced = await scanAndPrice({ frontImagePath: framePath });
      // VellumAI abstaining results are not cached — retry up to 2x for a better result.
      // Use hasUsableIdentity so we also retry on ok=true with Unknown identity (garbage result).
      if (!hasUsableIdentity(priced)) {
        for (let i = 0; i < 2 && !hasUsableIdentity(priced); i++) {
          const retryPath = path.join(detectDir, `retry-${i}-${randomUUID().slice(0, 8)}.jpg`);
          const retryBuf = await sharp(processedBuffer).jpeg({ quality: 90 + i * 5 }).toBuffer();
          writeFileSync(retryPath, retryBuf);
          priced = await scanAndPrice({ frontImagePath: retryPath });
        }
      }
    } catch (err) {
      return sendJson(res, 500, { error: err?.message || 'Scan failed' });
    }

    if (!hasUsableIdentity(priced)) {
      const ppResult = await tryPreprocessFallbacks(imageBuffer, detectDir, scanAndPrice, box);
      if (ppResult) return sendJson(res, 200, ppResult);
      const tileResult = await tryTileFallback(imageBuffer, detectDir, scanAndPrice, box);
      if (tileResult) return sendJson(res, 200, tileResult);
    }

    return sendJson(res, 200, { cards: [mapPricedToCard(priced, box)] });
  }

  // Multi-card path: 2+ cards detected by the sidecar — use each card's crop.
  const cardResults = await Promise.all(
    rawCards.map(async (rawCard, i) => {
      const cropBuffer = rawCard.crop_b64
        ? Buffer.from(rawCard.crop_b64, 'base64')
        : imageBuffer;
      const cropPath = path.join(detectDir, `card-${i}.jpg`);
      writeFileSync(cropPath, cropBuffer);
      let priced;
      try {
        priced = await scanAndPrice({ frontImagePath: cropPath });
      } catch {
        priced = { ok: false, identity: null, suggested: null };
      }
      const box = Array.isArray(rawCard.box) ? rawCard.box : [0, 0, 640, 480];
      return mapPricedToCard(priced, box);
    }),
  );

  return sendJson(res, 200, { cards: cardResults });
}

async function handleScan(req, res, { dataDir, scanAndPrice }) {
  if (typeof scanAndPrice !== 'function') {
    return sendJson(res, 503, { error: 'Scanner is not configured' });
  }

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

  let frontIndex = Number.parseInt(fields.frontIndex, 10);
  if (!Number.isInteger(frontIndex) || frontIndex < 0 || frontIndex >= photos.length) {
    frontIndex = 0;
  }

  const uploadDir = path.join(dataDir, 'scans', randomUUID());
  mkdirSync(uploadDir, { recursive: true });
  const photoPaths = photos.map((photo, index) => {
    const safeName = path.basename(photo.filename || `photo-${index}`);
    const filePath = path.join(uploadDir, `${index}-${safeName}`);
    writeFileSync(filePath, photo.buffer);
    return filePath;
  });

  const frontImagePath = photoPaths[frontIndex];
  const backImagePath = inferBackImagePath(photoPaths, frontImagePath);

  let priced;
  try {
    priced = await scanAndPrice({ frontImagePath, backImagePath });
  } catch (err) {
    if (err instanceof RetryablePokegradeError) {
      return sendJson(res, 503, { error: 'Identity service temporarily unavailable', retryable: true });
    }
    console.error('Scan failed:', err);
    return sendJson(res, 500, { error: err?.message || 'Scan failed' });
  }

  return sendJson(res, 200, {
    ...priced,
    frontIndex,
    photoCount: photoPaths.length,
    scanDir: path.basename(uploadDir),
  });
}

// CORS for the browser extension — restrict to the chrome-extension origin and
// the common dev origins so we never silently open the API to the world.
function _applyCors(req, res) {
  const origin = req.headers.origin || '';
  const allow =
    origin.startsWith('chrome-extension://') ||
    origin === 'http://127.0.0.1:3000' ||
    origin === 'http://localhost:3000' ||
    origin === 'null';
  if (!allow) return;
  res.setHeader('Access-Control-Allow-Origin',  origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

async function handlePriceGrid(params, res, priceGridClient) {
  if (!priceGridClient?.getPriceGrid) {
    return sendJson(res, 503, { error: 'price-grid client not configured (JUSTTCG_API_KEY missing?)' });
  }
  const identity = {
    name:   params.get('name')   || '',
    set:    params.get('set')    || '',
    number: params.get('number') || '',
    id:     params.get('id')     || '',
  };
  if (!identity.name) {
    return sendJson(res, 400, { error: 'name is required' });
  }
  try {
    const result = await priceGridClient.getPriceGrid(identity);
    if (!result) return sendJson(res, 404, { error: 'no price data' });
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 502, { error: err?.message || 'price grid lookup failed' });
  }
}

export function createServer({
  dataDir = 'data',
  publicDir = path.join(process.cwd(), 'public'),
  collectrClient,
  pokegradeCircuit,
  scanAndPrice,
  multiCardSplitter,
  priceGridClient,
} = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    _applyCors(req, res);

    // CORS preflight — respond before any other routing.
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    Promise.resolve()
      .then(async () => {
        if (req.method === 'GET' && url.pathname === '/health') {
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'GET' && url.pathname === '/api/health') {
          return sendJson(res, 200, {
            ok: true,
            service: 'pokemon-auto-lister',
            priceGrid: Boolean(priceGridClient?.getPriceGrid),
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/price-grid') {
          return handlePriceGrid(url.searchParams, res, priceGridClient);
        }
        if (req.method === 'POST' && url.pathname === '/detect') {
          return handleDetect(req, res, { dataDir, scanAndPrice, multiCardSplitter });
        }
        if (req.method === 'POST' && url.pathname === '/api/scan') {
          return handleScan(req, res, { dataDir, scanAndPrice });
        }
        if (req.method === 'GET' && url.pathname === '/api/collectr-status') {
          return sendJson(res, 200, collectrClient?.stats?.() ?? { exists: false, stale: true, rowCount: 0 });
        }
        if (req.method === 'GET' && url.pathname === '/api/identity-status') {
          const circuit = pokegradeCircuit?.status?.() ?? { open: false };
          const mode = process.env.IDENTITY_MODE || 'dual';
          const scannerMode =
            process.env.SCANNER_IDENTITY_MODE ||
            (String(process.env.VELLUM_AI_ENABLED || 'false').toLowerCase() === 'true'
              ? 'local-only'
              : mode);
          return sendJson(res, 200, {
            mode,
            scannerMode,
            vellumEnabled: String(process.env.VELLUM_AI_ENABLED || 'false').toLowerCase() === 'true',
            vellumUrl: process.env.VELLUM_AI_URL || 'http://127.0.0.1:8787',
            circuit,
            solo: circuit.open || mode === 'local-only',
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/pokegrade-circuit/reset') {
          pokegradeCircuit?.reset?.();
          return sendJson(res, 200, { ok: true, circuit: pokegradeCircuit?.status?.() ?? { open: false } });
        }
        if (req.method === 'GET' && url.pathname === '/api/scan-photo') {
          return serveScanPhoto(url.searchParams.get('dir'), url.searchParams.get('index'), res, dataDir);
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
