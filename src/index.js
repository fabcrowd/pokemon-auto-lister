import path from 'node:path';

import { createServer, resolveListenOptions } from './server.js';
import { createPokegradeClient } from './pokegrade/client.js';
import { createPokegradeCircuit } from './pokegrade/circuit.js';
import { createTcgplayerClient } from './tcgplayer/client.js';
import { createEbaySoldsClient } from './ebay/solds.js';
import { scanAndPrice as scanAndPriceFn } from './scan/scanAndPrice.js';
import { createCollectrClient, startCollectrPortfolioSync } from './collectr/client.js';
import { startCollectrExportWatcher } from './collectr/exportWatcher.js';
import { createVellumAiClient } from './identify/vellumAi.js';
import { createMultiCardSplitter } from './photos/splitMultiCard.js';
import { createIdentityResolver } from './identify/resolver.js';
import { createRapidPokemonTcgClient } from './pricing/rapidPokemonTcg.js';
import { createJustTcgClient, attachPriceGrid } from './pricing/justTcg.js';
import { createPokeWalletClient } from './pricing/pokeWallet.js';
import { createPokemonTcgApiClient } from './pricing/pokemonTcgApi.js';

const DATA_DIR = process.env.DATA_DIR || 'data';
const COLLECTR_CSV = process.env.COLLECTR_CSV || path.join(DATA_DIR, 'collectr-export.csv');
const COLLECTR_TOKEN = process.env.COLLECTR_TOKEN || '';
const VELLUM_AI_ENABLED = String(process.env.VELLUM_AI_ENABLED || 'false').toLowerCase() === 'true';
const IDENTITY_MODE = process.env.IDENTITY_MODE || 'dual';
const SCANNER_IDENTITY_MODE =
  process.env.SCANNER_IDENTITY_MODE || (VELLUM_AI_ENABLED ? 'local-only' : IDENTITY_MODE);

const pokegradeCircuit = createPokegradeCircuit({ dataDir: DATA_DIR });
const pokegradeClient = createPokegradeClient({ dataDir: DATA_DIR });
const vellumClient = createVellumAiClient({ dataDir: DATA_DIR, enabled: VELLUM_AI_ENABLED });
const multiCardSplitter = createMultiCardSplitter({ dataDir: DATA_DIR, enabled: VELLUM_AI_ENABLED });
const identityResolver = createIdentityResolver({
  pokegradeClient,
  vellumClient,
  circuit: pokegradeCircuit,
  mode: IDENTITY_MODE,
  vellumEnabled: VELLUM_AI_ENABLED,
});
const scannerIdentityResolver =
  SCANNER_IDENTITY_MODE === IDENTITY_MODE
    ? identityResolver
    : createIdentityResolver({
        pokegradeClient,
        vellumClient,
        circuit: pokegradeCircuit,
        mode: SCANNER_IDENTITY_MODE,
        vellumEnabled: VELLUM_AI_ENABLED,
      });

const tcgplayerClient = createTcgplayerClient();
const rapidPokemonTcgClient = createRapidPokemonTcgClient();
const justTcgClient = attachPriceGrid(createJustTcgClient());
const pokeWalletClient = createPokeWalletClient();
const pokemonTcgApiClient = createPokemonTcgApiClient();
const ebaySoldsClient = createEbaySoldsClient();
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

console.log(
  `Identity: mode=${IDENTITY_MODE} scanner=${SCANNER_IDENTITY_MODE} vellumAi=${VELLUM_AI_ENABLED} circuitOpen=${pokegradeCircuit.isOpen()}`,
);

const { host, port } = resolveListenOptions(process.env);
const server = createServer({
  dataDir: DATA_DIR,
  collectrClient,
  pokegradeCircuit,
  vellumClient,
  multiCardSplitter,
  priceGridClient: justTcgClient,
  scanAndPrice: (opts) =>
    scanAndPriceFn({
      ...opts,
      pokegradeClient,
      identityResolver: scannerIdentityResolver,
      tcgplayerClient,
      ebaySoldsClient,
      collectrClient,
      rapidPokemonTcgClient,
      justTcgClient,
      pokeWalletClient,
      pokemonTcgApiClient,
    }),
});
server.listen(port, host, () => {
  console.log(`Card Scanner listening on http://${host}:${port}`);
});

console.log(
  `pokemontcg.io comps: enabled${process.env.POKEMON_TCG_API_KEY ? ' (authenticated)' : ' (unauthenticated — set POKEMON_TCG_API_KEY for higher rate limits)'}`,
);
console.log(
  `RapidAPI Pokemon TCG comps: ${process.env.RAPIDAPI_KEY || process.env.RAPIDAPI_POKEMON_TCG_KEY ? 'enabled' : 'disabled (set RAPIDAPI_KEY)'}`,
);
console.log(`JustTCG comps: ${process.env.JUSTTCG_API_KEY ? 'enabled' : 'disabled (set JUSTTCG_API_KEY)'}`);
console.log(
  `PokéWallet comps: ${process.env.POKEWALLET_API_KEY ? 'enabled' : 'disabled (set POKEWALLET_API_KEY)'}`,
);

if (COLLECTR_TOKEN) {
  startCollectrPortfolioSync({ collectrClient });
  console.log('Collectr api-v2 portfolio sync enabled (CSV export watcher skipped)');
} else {
  startCollectrExportWatcher({ collectrClient, destCsvPath: COLLECTR_CSV });
  console.log('Watching Downloads/export.csv for newer Collectr exports');
}
