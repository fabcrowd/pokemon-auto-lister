import { copyFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Watch Downloads/export.csv (or COLLECTR_WATCH_PATH) and copy into the
 * project Collectr CSV when a newer file appears, then reload the catalog.
 */
export function startCollectrExportWatcher({
  collectrClient,
  destCsvPath,
  watchPath = process.env.COLLECTR_WATCH_PATH || path.join(os.homedir(), 'Downloads', 'export.csv'),
  intervalMs = 30_000,
  onRefresh,
} = {}) {
  let lastImportedMtime = null;

  async function tick() {
    if (!watchPath || !existsSync(watchPath) || !destCsvPath) {
      return;
    }

    const watchMtime = statSync(watchPath).mtimeMs;
    const destMtime = existsSync(destCsvPath) ? statSync(destCsvPath).mtimeMs : 0;
    if (watchMtime <= destMtime || watchMtime === lastImportedMtime) {
      return;
    }

    copyFileSync(watchPath, destCsvPath);
    lastImportedMtime = watchMtime;
    const stats = collectrClient.reload();
    console.log(
      `Collectr export refreshed from ${watchPath} (${stats.rowCount} pokemon rows, asOf=${stats.asOfDate || 'file mtime'})`,
    );
    if (onRefresh) {
      await onRefresh(stats);
    }
  }

  const timer = setInterval(() => {
    tick().catch((err) => {
      console.error('Collectr export watch failed:', err);
    });
  }, intervalMs);
  timer.unref?.();

  // First pass soon after boot.
  setTimeout(() => {
    tick().catch((err) => {
      console.error('Collectr export watch failed:', err);
    });
  }, 1500).unref?.();

  return () => clearInterval(timer);
}
