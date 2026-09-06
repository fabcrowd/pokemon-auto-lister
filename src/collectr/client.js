import path from 'node:path';

import { createCollectrCatalog } from './catalog.js';
import { createCollectrApiV2Client, DEFAULT_SYNC_INTERVAL_MS } from './apiV2.js';

/**
 * Prefer Collectr api-v2 portfolio sync when COLLECTR_TOKEN is set; else CSV catalog.
 */
export function createCollectrClient({
  token = process.env.COLLECTR_TOKEN,
  userId = process.env.COLLECTR_USER_ID,
  collectionId = process.env.COLLECTR_COLLECTION_ID,
  csvPath,
  dataDir = process.env.DATA_DIR || 'data',
  fetchImpl = fetch,
  createCatalog = createCollectrCatalog,
  createApi = createCollectrApiV2Client,
} = {}) {
  if (token && userId) {
    return createApi({
      token,
      userId,
      collectionId,
      cachePath: path.join(dataDir, 'collectr-portfolio-cache.json'),
      fetchImpl,
    });
  }

  const catalog = createCatalog({ csvPath });
  return {
    mode: 'csv',
    async getMarketPrice(identity) {
      return catalog.getMarketPrice(identity);
    },
    stats: (nowMs) => catalog.stats(nowMs),
    reload: () => catalog.reload(),
    sync: async () => catalog.reload(),
  };
}

export function startCollectrPortfolioSync({
  collectrClient,
  intervalMs = Number.parseInt(process.env.COLLECTR_SYNC_INTERVAL_MS || '', 10) || DEFAULT_SYNC_INTERVAL_MS,
} = {}) {
  if (!collectrClient || collectrClient.mode !== 'api-v2' || typeof collectrClient.sync !== 'function') {
    return () => {};
  }

  const run = () => {
    collectrClient.sync().then((stats) => {
      console.log(
        `Collectr api-v2 sync: rows=${stats.rowCount} stale=${stats.stale}${stats.lastError ? ` error=${stats.lastError}` : ''}`,
      );
    }).catch((err) => {
      console.error('Collectr api-v2 sync failed:', err);
    });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
