import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createQueue } from './queue/queue.js';
import { createServer, resolveListenOptions } from './server.js';
import { createPokegradeClient } from './pokegrade/client.js';
import { createPokegradeCircuit } from './pokegrade/circuit.js';
import { createTcgplayerClient } from './tcgplayer/client.js';
import { createEbaySoldsClient } from './ebay/solds.js';
import { createEbayDraftClient } from './ebay/draft.js';
import { createMercariSession } from './mercari/draft.js';
import { processCard } from './pipeline/processCard.js';
import { createDraftDispatcher } from './dispatch/draftDispatch.js';
import { createCollectrClient, startCollectrPortfolioSync } from './collectr/client.js';
import { startCollectrExportWatcher } from './collectr/exportWatcher.js';
import { scanInbox, countPendingInbox } from './inbox/watcher.js';
import { downloadPhotosToInbox, getDownloadPhotosStatus } from './inbox/downloadPhotos.js';
import { isSniperEnabled, startSniper, disabledSniperStatus } from './sniper/start.js';
import { createVellumAiClient } from './identify/vellumAi.js';
import { createIdentityResolver } from './identify/resolver.js';
import { seedPostedLedgerFromQueue } from './photos/postedLedger.js';
import { rescanListedPrices } from './pricing/monitor.js';
import { createRapidPokemonTcgClient } from './pricing/rapidPokemonTcg.js';
import { createJustTcgClient } from './pricing/justTcg.js';
import { createPokeWalletClient } from './pricing/pokeWallet.js';

const DATA_DIR = process.env.DATA_DIR || 'data';
const INBOX_DIR = process.env.INBOX_DIR || 'autolist-inbox';
const ICLOUD_PHOTOS_DIR =
  process.env.ICLOUD_PHOTOS_DIR ||
  path.join(process.env.USERPROFILE || '', 'iCloudPhotos', 'Photos');
const COLLECTR_CSV = process.env.COLLECTR_CSV || path.join(DATA_DIR, 'collectr-export.csv');
const COLLECTR_TOKEN = process.env.COLLECTR_TOKEN || '';
const VELLUM_AI_ENABLED = String(process.env.VELLUM_AI_ENABLED || 'false').toLowerCase() === 'true';
const IDENTITY_MODE = process.env.IDENTITY_MODE || 'dual';
const listingDefaults = JSON.parse(readFileSync(new URL('../config/listing-defaults.json', import.meta.url)));

const queue = createQueue(DATA_DIR);
const seededPosted = seedPostedLedgerFromQueue(DATA_DIR, queue);
if (seededPosted > 0) {
  console.log(`Posted-photo ledger seeded from ${seededPosted} drafted/listed card(s)`);
}
const pokegradeCircuit = createPokegradeCircuit({ dataDir: DATA_DIR });
const pokegradeClient = createPokegradeClient({ dataDir: DATA_DIR });
const vellumClient = createVellumAiClient({ dataDir: DATA_DIR, enabled: VELLUM_AI_ENABLED });
const identityResolver = createIdentityResolver({
  pokegradeClient,
  vellumClient,
  circuit: pokegradeCircuit,
  mode: IDENTITY_MODE,
  vellumEnabled: VELLUM_AI_ENABLED,
});
const tcgplayerClient = createTcgplayerClient();
const rapidPokemonTcgClient = createRapidPokemonTcgClient();
const justTcgClient = createJustTcgClient();
const pokeWalletClient = createPokeWalletClient();
const ebaySoldsClient = createEbaySoldsClient();
const ebayDraftClient = createEbayDraftClient();
const collectrClient = createCollectrClient({ csvPath: COLLECTR_CSV, dataDir: DATA_DIR });
const collectrStats = collectrClient.stats();
if (collectrClient.mode === 'api-v2') {
  console.log(
    `Collectr api-v2: user=${collectrStats.userId} collection=${collectrStats.collectionId || '(auto)'} configured=${collectrStats.configured}`,
  );
} else {
  console.log(
    `Collectr CSV: ${COLLECTR_CSV} (${collectrStats.rowCount} pokemon rows, stale=${collectrStats.stale}, asOf=${collectrStats.asOfDate || 'mtime'})`,
  );
}

const MERCARI_PROFILE = process.env.MERCARI_PROFILE || path.join(DATA_DIR, 'mercari-chrome-profile');
const mercariSession = createMercariSession({ userDataDir: MERCARI_PROFILE });

const createDraft = createDraftDispatcher({
  queue,
  dataDir: DATA_DIR,
  drivers: {
    mercari: (record) => mercariSession.createDraft(record, { config: listingDefaults }),
    ebay: (record) => ebayDraftClient.createEbayDraft(record, { config: listingDefaults }),
  },
});
console.log(`Mercari Chrome profile: ${MERCARI_PROFILE}`);
console.log('Mercari: first Confirm opens Chrome — log in once there; later drafts reuse that session');

console.log(
  `Identity: mode=${IDENTITY_MODE} vellumAi=${VELLUM_AI_ENABLED} circuitOpen=${pokegradeCircuit.isOpen()}`,
);

async function onEnqueue(cardId) {
  await processCard(cardId, {
    queue,
    pokegradeClient,
    identityResolver,
    tcgplayerClient,
    ebaySoldsClient,
    collectrClient,
    rapidPokemonTcgClient,
    justTcgClient,
    pokeWalletClient,
    config: listingDefaults,
    createDraft,
  });
}

const sniperHandle = isSniperEnabled(process.env)
  ? startSniper({
      mercariSession,
      pokegradeClient,
      dataDir: DATA_DIR,
    })
  : null;
if (!sniperHandle) {
  console.log('Sniper disabled (set SNIPER_ENABLED=true to auto-heart Mercari deals)');
}

const { host, port } = resolveListenOptions(process.env);
const server = createServer({
  queue,
  dataDir: DATA_DIR,
  onEnqueue,
  createDraft,
  collectrClient,
  pokegradeCircuit,
  vellumClient,
  getSniperStatus: () => (sniperHandle ? sniperHandle.getStatus() : disabledSniperStatus()),
  inboxDir: INBOX_DIR,
  countPendingInbox: () => countPendingInbox({ inboxDir: INBOX_DIR, dataDir: DATA_DIR }),
  scanInbox: (opts = {}) =>
    scanInbox({
      inboxDir: INBOX_DIR,
      queue,
      onEnqueue,
      dataDir: DATA_DIR,
      marketplaceDefaults: opts.marketplaceDefaults,
      forceRescan: Boolean(opts.forceRescan),
    }),
  downloadPhotos: (opts = {}) =>
    downloadPhotosToInbox({
      photosDir: ICLOUD_PHOTOS_DIR,
      inboxDir: INBOX_DIR,
      dataDir: DATA_DIR,
      sinceHours: opts.sinceHours,
    }),
  getDownloadPhotosStatus: () =>
    getDownloadPhotosStatus({
      photosDir: ICLOUD_PHOTOS_DIR,
      inboxDir: INBOX_DIR,
      dataDir: DATA_DIR,
    }),
  rescanListedPrices: () =>
    rescanListedPrices({
      queue,
      tcgplayerClient,
      ebaySoldsClient,
      collectrClient,
      rapidPokemonTcgClient,
      justTcgClient,
      pokeWalletClient,
      config: listingDefaults,
    }),
  mercariSession,
  ebayDraftClient,
});
server.listen(port, host, () => {
  console.log(`Pokemon Auto-Lister dashboard listening on http://${host}:${port}`);
});

console.log(`Inbox ready (click Add new cards): ${INBOX_DIR}`);
console.log(`iCloud Photos source (Download photos): ${ICLOUD_PHOTOS_DIR}`);
console.log(
  `RapidAPI Pokemon TCG comps: ${process.env.RAPIDAPI_KEY || process.env.RAPIDAPI_POKEMON_TCG_KEY ? 'enabled' : 'disabled (set RAPIDAPI_KEY)'}`,
);
console.log(`JustTCG comps: ${process.env.JUSTTCG_API_KEY ? 'enabled' : 'disabled (set JUSTTCG_API_KEY)'}`);
console.log(
  `PokéWallet comps: ${process.env.POKEWALLET_API_KEY ? 'enabled' : 'disabled (set POKEWALLET_API_KEY)'}`,
);
console.log('Connect Mercari / eBay from the dashboard before Add new cards');

if (COLLECTR_TOKEN) {
  startCollectrPortfolioSync({ collectrClient });
  console.log('Collectr api-v2 portfolio sync enabled (CSV export watcher skipped)');
} else {
  startCollectrExportWatcher({ collectrClient, destCsvPath: COLLECTR_CSV });
  console.log('Watching Downloads/export.csv for newer Collectr exports');
}
