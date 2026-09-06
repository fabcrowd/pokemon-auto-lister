import { decideDeal, marketForStrategy } from './deal.js';
import { scanMercariSearch, mercariFirstPhotoUrl } from './mercariSearch.js';
import { heartItemOnSearchPage } from './heart.js';
import { RetryablePokegradeError } from '../pokegrade/client.js';

/**
 * Process one listing against a strategy.
 *
 * @returns {Promise<'hearted'|'worklist'|'suspect'|'skip'|'deferred'|'error'>}
 */
export async function processListing({
  listing,
  strategy,
  thresholds,
  sniperState,
  pokegradeClient,
  page,
  heartFn = heartItemOnSearchPage,
}) {
  const { itemId, askPrice } = listing;

  if (sniperState.isHearted(itemId)) {
    return 'skip';
  }
  if (sniperState.isSeen(itemId)) {
    return 'skip';
  }

  let pokeResult;
  try {
    pokeResult = await pokegradeClient.evaluateImageUrl(mercariFirstPhotoUrl(itemId), { itemId });
  } catch (err) {
    if (err instanceof RetryablePokegradeError) {
      return 'deferred';
    }
    // Missing price / identify failures stay unseen for retry
    return 'deferred';
  }

  const market = marketForStrategy(pokeResult, strategy);
  if (market == null) {
    return 'deferred';
  }

  const action = decideDeal(market, askPrice, thresholds);
  const ratio = market / askPrice;
  const meta = {
    ask: askPrice,
    market,
    ratio,
    strategyId: strategy.id,
    mode: strategy.mode,
    identity: pokeResult.identity ?? null,
  };

  if (action === 'suspect') {
    sniperState.addSuspect(itemId, meta);
    return 'suspect';
  }

  if (action === 'worklist') {
    sniperState.addWorklist(itemId, meta);
    return 'worklist';
  }

  if (action === 'heart') {
    // Durable check again immediately before click
    if (sniperState.isHearted(itemId)) {
      return 'skip';
    }
    const result = await heartFn(page, itemId);
    if (!result?.ok) {
      return 'deferred';
    }
    sniperState.markHearted(itemId, meta);
    return 'hearted';
  }

  sniperState.markSeen(itemId, { ...meta, action: 'skip' });
  return 'skip';
}

/**
 * Run one full sniper cycle across all strategies.
 *
 * @param {object} options
 * @param {object} options.config - sniper-strategies.json shape
 * @param {{ withMercariPage: Function }} options.mercariSession
 * @param {{ evaluateImageUrl: Function }} options.pokegradeClient
 * @param {ReturnType<import('./state.js').createSniperState>} options.sniperState
 */
export async function runSniperCycle({
  config,
  mercariSession,
  pokegradeClient,
  sniperState,
  scanFn = scanMercariSearch,
  heartFn = heartItemOnSearchPage,
}) {
  const thresholds = config.thresholds ?? {};
  const strategies = config.strategies ?? [];
  const summary = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    strategies: [],
    hearted: 0,
    worklist: 0,
    suspects: 0,
    skipped: 0,
    deferred: 0,
    errors: 0,
  };

  await mercariSession.withMercariPage(async (page) => {
    for (const strategy of strategies) {
      const strategySummary = {
        id: strategy.id,
        query: strategy.query,
        scanned: 0,
        hearted: 0,
        worklist: 0,
        suspects: 0,
        skipped: 0,
        deferred: 0,
      };

      let listings = [];
      try {
        listings = await scanFn(page, strategy.query);
      } catch (err) {
        summary.errors += 1;
        strategySummary.error = err.message;
        summary.strategies.push(strategySummary);
        continue;
      }

      strategySummary.scanned = listings.length;

      for (const listing of listings) {
        try {
          const outcome = await processListing({
            listing,
            strategy,
            thresholds,
            sniperState,
            pokegradeClient,
            page,
            heartFn,
          });
          if (outcome === 'hearted') {
            strategySummary.hearted += 1;
            summary.hearted += 1;
          } else if (outcome === 'worklist') {
            strategySummary.worklist += 1;
            summary.worklist += 1;
          } else if (outcome === 'suspect') {
            strategySummary.suspects += 1;
            summary.suspects += 1;
          } else if (outcome === 'deferred') {
            strategySummary.deferred += 1;
            summary.deferred += 1;
          } else {
            strategySummary.skipped += 1;
            summary.skipped += 1;
          }
        } catch (err) {
          summary.errors += 1;
          strategySummary.deferred += 1;
          summary.deferred += 1;
          console.error(`Sniper listing ${listing.itemId} failed:`, err.message);
        }
      }

      summary.strategies.push(strategySummary);
    }
  });

  summary.finishedAt = new Date().toISOString();
  sniperState.setLastCycle(summary);
  return summary;
}
