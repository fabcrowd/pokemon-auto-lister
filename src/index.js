import { readFileSync } from 'node:fs';

import { createQueue } from './queue/queue.js';
import { createServer, resolveListenOptions } from './server.js';
import { createPokegradeClient } from './pokegrade/client.js';
import { createTcgplayerClient } from './tcgplayer/client.js';
import { createEbaySoldsClient } from './ebay/solds.js';
import { createEbayDraftClient } from './ebay/draft.js';
import { createMercariDraft } from './mercari/draft.js';
import { processCard } from './pipeline/processCard.js';
import { createDraftDispatcher } from './dispatch/draftDispatch.js';
import { startInboxWatcher } from './inbox/watcher.js';

const DATA_DIR = process.env.DATA_DIR || 'data';
const INBOX_DIR = process.env.INBOX_DIR || 'autolist-inbox';
const listingDefaults = JSON.parse(readFileSync(new URL('../config/listing-defaults.json', import.meta.url)));

const queue = createQueue(DATA_DIR);
const pokegradeClient = createPokegradeClient({ dataDir: DATA_DIR });
const tcgplayerClient = createTcgplayerClient();
const ebaySoldsClient = createEbaySoldsClient();
const ebayDraftClient = createEbayDraftClient();

const createDraft = createDraftDispatcher({
  queue,
  drivers: {
    mercari: (record) => createMercariDraft(record, { config: listingDefaults }),
    ebay: (record) => ebayDraftClient.createEbayDraft(record, { config: listingDefaults }),
  },
});

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

startInboxWatcher({ inboxDir: INBOX_DIR, queue, onEnqueue });
