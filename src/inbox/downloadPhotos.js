/**
 * Pull JPGs from the iCloud Photos library (or any source folder) into INBOX_DIR.
 * Shared Albums on Windows often never download; the main Photos library does.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
  readFileSync,
  renameSync,
  utimesSync,
} from 'node:fs';
import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const STATE_FILE = 'inbox-download-state.json';

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function atomicWriteJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

function readState(dataDir) {
  const filePath = path.join(dataDir, STATE_FILE);
  if (!existsSync(filePath)) {
    return { lastDownloadAt: null, lastCopied: 0 };
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { lastDownloadAt: null, lastCopied: 0 };
  }
}

function listImageFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => {
      const full = path.join(dir, name);
      try {
        return statSync(full).isFile() && isImageFile(name);
      } catch {
        return false;
      }
    })
    .map((name) => path.join(dir, name));
}

/**
 * @param {{ photosDir: string, inboxDir: string, dataDir?: string, sinceHours?: number|null }} opts
 * @returns {{ copied: number, skipped: number, photosDir: string, inboxDir: string, files: string[], error?: string }}
 */
export function downloadPhotosToInbox({
  photosDir,
  inboxDir,
  dataDir = 'data',
  sinceHours = 72,
} = {}) {
  if (!photosDir) {
    return {
      copied: 0,
      skipped: 0,
      photosDir: photosDir || '',
      inboxDir: inboxDir || '',
      files: [],
      error: 'photosDir is not configured (set ICLOUD_PHOTOS_DIR)',
    };
  }
  if (!existsSync(photosDir)) {
    return {
      copied: 0,
      skipped: 0,
      photosDir,
      inboxDir,
      files: [],
      error: `Photos source missing: ${photosDir}`,
    };
  }
  if (!inboxDir) {
    return {
      copied: 0,
      skipped: 0,
      photosDir,
      inboxDir: '',
      files: [],
      error: 'inboxDir is not configured',
    };
  }

  mkdirSync(inboxDir, { recursive: true });

  const existing = new Set(
    listImageFiles(inboxDir).map((p) => path.basename(p).toLowerCase()),
  );

  const cutoffMs =
    sinceHours == null || sinceHours <= 0
      ? 0
      : Date.now() - sinceHours * 60 * 60 * 1000;

  let copied = 0;
  let skipped = 0;
  const files = [];

  for (const src of listImageFiles(photosDir)) {
    const base = path.basename(src);
    const key = base.toLowerCase();
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    try {
      const mtime = statSync(src).mtimeMs;
      if (cutoffMs > 0 && mtime < cutoffMs) {
        skipped += 1;
        continue;
      }
    } catch {
      skipped += 1;
      continue;
    }

    const dest = path.join(inboxDir, base);
    try {
      const srcStat = statSync(src);
      copyFileSync(src, dest);
      // Preserve camera mtime so flat inbox sort/grouping can follow shoot order.
      try {
        utimesSync(dest, srcStat.atime, srcStat.mtime);
      } catch {
        // Non-fatal on platforms that reject utimes for some filesystems.
      }
      existing.add(key);
      copied += 1;
      files.push(base);
    } catch (err) {
      skipped += 1;
      console.error(`downloadPhotos: failed ${base}:`, err.message);
    }
  }

  const at = new Date().toISOString();
  atomicWriteJson(path.join(dataDir, STATE_FILE), {
    lastDownloadAt: at,
    lastCopied: copied,
    photosDir,
    inboxDir,
  });

  return {
    copied,
    skipped,
    photosDir,
    inboxDir,
    files,
    lastDownloadAt: at,
  };
}

export function getDownloadPhotosStatus({ photosDir, inboxDir, dataDir = 'data' }) {
  const state = readState(dataDir);
  return {
    photosDir: photosDir || null,
    inboxDir: inboxDir || null,
    photosExists: Boolean(photosDir && existsSync(photosDir)),
    lastDownloadAt: state.lastDownloadAt || null,
    lastCopied: state.lastCopied ?? 0,
  };
}
