import fs from 'node:fs';
import path from 'node:path';

import { isInside } from './sealed-paths.mjs';

/**
 * Chrome keeps running the service worker script it cached on an earlier launch of the same profile, so a
 * rebuilt extension would run as its old self. Models live in CacheStorage, which stays.
 * Deletes inside the profile, so it must be a scratch folder of this repo, never a real browser profile.
 */
export function clearStaleServiceWorker(root, profile) {
  if (!isInside(path.join(root, 'data'), profile) && !isInside(path.join(root, '.tmp'), profile)) {
    throw new Error('The browser profile must be a folder inside this repo\'s data/ or .tmp/ folder.');
  }
  for (const stale of ['ScriptCache', 'Database']) {
    fs.rmSync(path.join(profile, 'Default', 'Service Worker', stale), { recursive: true, force: true });
  }
}
