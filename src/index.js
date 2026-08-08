import { readFileSync } from 'node:fs';

import { createQueue } from './queue/queue.js';
import { createServer, resolveListenOptions } from './server.js';
import { createPokegradeClient } from './pokegrade/client.js';
import { createTcgplayerClient } from './tcgplayer/client.js';
import { createEbaySoldsClient } from './ebay/solds.js';
import { processCard } from './pipeline/processCard.js';

const DATA_DIR = process.env.DATA_DIR || 'data';
const listingDefaults = JSON.parse(readFileSync(new URL('../config/listing-defaults.json', import.meta.url)));

const queue = createQueue(DATA_DIR);
const pokegradeClient = createPokegradeClient({ dataDir: DATA_DIR });
const tcgplayerClient = createTcgplayerClient();
const ebaySoldsClient = createEbaySoldsClient();

async function createDraft(marketplace, record) {
  // Marketplace drivers land in later requirements (11 Mercari, 12 eBay).
  console.log(`Draft requested for ${marketplace}: card ${record.id} (driver not yet implemented)`);
}

async function onEnqueue(cardId) {
  await processCard(cardId, {
    queue,
    pokegradeClient,
    tcgplayerClient,
    ebaySoldsClient,
    config: listingDefaults,
    createDraft,
  });
}

const { host, port } = resolveListenOptions(process.env);
const server = createServer({ queue, dataDir: DATA_DIR, onEnqueue, createDraft });
server.listen(port, host, () => {
  console.log(`Pokemon Auto-Lister dashboard listening on http://${host}:${port}`);
});
