import fs from 'node:fs/promises';
import path from 'node:path';

import { dhashImage } from './dhash.mjs';

const IMAGE = /\.(jpe?g|png|webp)$/i;

// Every folder under data/ may hold pictures the scanner trained or tuned on, so all of them are
// roots. Left out: the sealed set itself; the catalog, whose renders are card scans from the
// publisher and not marketplace photos; and browser profiles, whose caches are not ours.
const NOT_TRAINING = /^(sealed-test|card-catalog.*|catalog-images|tcg-cache|.*profile.*)$/;
const LOOSE_FILES = /^extension-live-listing.*\.png$/i;

/** Training image folders (dir names for reporting) and the loose listing screenshots in data/. */
export async function trainingRoots(dataDir) {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  return {
    dirs: entries
      .filter((entry) => entry.isDirectory() && !NOT_TRAINING.test(entry.name))
      .map((entry) => ({ name: entry.name, path: path.join(dataDir, entry.name) })),
    files: entries.filter((entry) => entry.isFile() && LOOSE_FILES.test(entry.name)).map((entry) => path.join(dataDir, entry.name)),
  };
}

const subdirs = async (dir) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name);

/** Listing folder names per marketplace, for matching a photo's listing URL. */
export async function trainingFolders(dataDir) {
  const marketplace = path.join(dataDir, 'detect-marketplace');
  const folders = {};
  for (const market of await subdirs(marketplace)) folders[market] = await subdirs(path.join(marketplace, market));
  folders.hibid = [...(folders.hibid || []), ...await subdirs(path.join(dataDir, 'detect-hibid-real'))];
  return folders;
}

async function* imagesUnder(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* imagesUnder(full);
    else if (IMAGE.test(entry.name)) yield full;
  }
}

async function readCache(cachePath) {
  try {
    return JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * dHash of every training image. A file is rehashed only when its size or modified time
 * changed since the last run. `counts` is images per root, for the import summary.
 */
export async function loadTrainingHashes({ roots, files = [], cachePath, base }) {
  const cache = await readCache(cachePath);
  const next = {};
  const counts = {};
  let hashed = 0;

  async function take(file, group) {
    const key = path.relative(base, file).split(path.sep).join('/');
    const { size, mtimeMs } = await fs.stat(file);
    const known = cache[key];
    if (known?.size === size && known?.mtimeMs === mtimeMs) {
      next[key] = known;
    } else {
      try {
        next[key] = { size, mtimeMs, hash: await dhashImage(await fs.readFile(file)) };
        hashed += 1;
      } catch {
        // A file that will not decode cannot be a duplicate of anything.
        return;
      }
    }
    counts[group] = (counts[group] || 0) + 1;
  }

  for (const root of roots) {
    for await (const file of imagesUnder(root.path)) await take(file, root.name);
  }
  for (const file of files) await take(file, 'loose files');
  await fs.writeFile(cachePath, JSON.stringify(next));
  return { hashes: Object.values(next).map((entry) => entry.hash), hashed, counts };
}
