import { decidePrice, postedListPrice, priceDrift, PRICE_DRIFT_THRESHOLD } from './pricing.js';

/**
 * Refresh comps for drafted/listed cards. Flag needs_review when market drifts
 * more than PRICE_DRIFT_THRESHOLD from the posted list price.
 */
export async function rescanListedPrices({
  queue,
  tcgplayerClient,
  ebaySoldsClient,
  collectrClient,
  rapidPokemonTcgClient = null,
  justTcgClient = null,
  pokeWalletClient = null,
  config = {},
} = {}) {
  if (!queue) {
    throw new Error('rescanListedPrices requires a queue');
  }

  const cards = [...queue.listByStatus('drafted'), ...queue.listByStatus('listed')];
  const results = [];
  const now = new Date().toISOString();

  for (const card of cards) {
    const identity = card.pricedCache?.identity;
    if (!identity) {
      results.push({ id: card.id, skipped: true, reason: 'no identity' });
      continue;
    }

    const posted = postedListPrice(card);
    if (posted == null) {
      results.push({ id: card.id, skipped: true, reason: 'no posted price' });
      continue;
    }

    const [tcgplayerResult, ebayResult, collectrResult, rapidapiResult, justtcgResult, pokewalletResult] =
      await Promise.all([
        Promise.resolve()
          .then(() => tcgplayerClient?.getMarketPrice?.(identity) ?? null)
          .catch(() => null),
        Promise.resolve()
          .then(() => ebaySoldsClient?.getRecentSolds?.(identity) ?? null)
          .catch(() => null),
        Promise.resolve()
          .then(() => collectrClient?.getMarketPrice?.(identity) ?? null)
          .catch(() => null),
        Promise.resolve()
          .then(() => rapidPokemonTcgClient?.getMarketPrice?.(identity) ?? null)
          .catch(() => null),
        Promise.resolve()
          .then(() => justTcgClient?.getMarketPrice?.(identity) ?? null)
          .catch(() => null),
        Promise.resolve()
          .then(() => pokeWalletClient?.getMarketPrice?.(identity) ?? null)
          .catch(() => null),
      ]);

    const cachedPokegrade =
      typeof card.pricedCache?.comps?.pokegrade === 'number'
        ? { value: card.pricedCache.comps.pokegrade, confidence: 'high' }
        : null;

    const decision = decidePrice(
      {
        pokegrade: cachedPokegrade,
        collectr: collectrResult,
        tcgplayer: tcgplayerResult,
        ebay: ebayResult,
        rapidapi: rapidapiResult,
        justtcg: justtcgResult,
        pokewallet: pokewalletResult,
      },
      config,
    );

    const market = decision.suggested?.mercari ?? decision.suggested?.ebay ?? null;
    const drift = priceDrift(posted, market);
    const priceMonitor = {
      posted,
      market,
      delta: drift.delta,
      absDelta: drift.absDelta,
      withinBand: drift.withinBand,
      threshold: PRICE_DRIFT_THRESHOLD,
      at: now,
    };

    const pricedCache = {
      ...card.pricedCache,
      comps: decision.comps,
      suggested: decision.suggested ?? card.pricedCache.suggested,
      action: drift.withinBand ? card.pricedCache.action || 'auto' : 'price_drift',
      reason: drift.withinBand
        ? card.pricedCache.reason || `within ${PRICE_DRIFT_THRESHOLD * 100}% of posted`
        : `price drifted ${(drift.absDelta * 100).toFixed(1)}% from posted $${posted} (market $${market}) — repost at new price; end old Mercari listing manually if still live`,
    };

    if (!drift.withinBand) {
      queue.patch(card.id, {
        pricedCache,
        priceMonitor,
        status: 'needs_review',
      });
      results.push({
        id: card.id,
        drifted: true,
        posted,
        market,
        delta: drift.delta,
      });
    } else {
      queue.patch(card.id, {
        pricedCache,
        priceMonitor,
      });
      results.push({
        id: card.id,
        drifted: false,
        posted,
        market,
        delta: drift.delta,
      });
    }
  }

  return {
    checked: results.length,
    drifted: results.filter((r) => r.drifted).length,
    results,
  };
}
