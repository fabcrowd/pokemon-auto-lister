/**
 * Identify a front (optional back) photo and pull multi-source comps.
 * Shared by the listing pipeline and the UI scanner — no queue / drafts.
 */

import { RetryablePokegradeError } from '../pokegrade/client.js';
import { decidePrice } from '../pricing/pricing.js';

/**
 * @param {{
 *   frontImagePath: string,
 *   backImagePath?: string|null,
 *   pokegradeClient?: object,
 *   identityResolver?: object|null,
 *   tcgplayerClient?: object|null,
 *   ebaySoldsClient?: object|null,
 *   collectrClient?: object|null,
 *   rapidPokemonTcgClient?: object|null,
 *   justTcgClient?: object|null,
 *   pokeWalletClient?: object|null,
 *   pokemonTcgApiClient?: object|null,
 *   config?: object,
 * }} opts
 */
export async function scanAndPrice({
  frontImagePath,
  backImagePath = null,
  pokegradeClient,
  identityResolver = null,
  tcgplayerClient = null,
  ebaySoldsClient = null,
  collectrClient = null,
  rapidPokemonTcgClient = null,
  justTcgClient = null,
  pokeWalletClient = null,
  pokemonTcgApiClient = null,
  config = {},
} = {}) {
  if (!frontImagePath) {
    return {
      ok: false,
      identity: null,
      identities: {},
      identityConflict: false,
      comps: {},
      suggested: null,
      reason: 'no full-card photo',
      action: 'needs_review',
      grading: null,
      mode: null,
      idSource: null,
      pricingSources: [],
    };
  }

  let resolveResult;
  let pokegradeResult = null;

  try {
    if (identityResolver) {
      resolveResult = await identityResolver.evaluateFrontImage(frontImagePath, {
        backImagePath,
      });
      pokegradeResult = resolveResult.pokegrade;
    } else if (pokegradeClient) {
      pokegradeResult = await pokegradeClient.evaluateFrontImage(frontImagePath, {
        backImagePath,
      });
      resolveResult = {
        mode: 'pokegrade-only',
        identity: pokegradeResult.identity,
        pokegrade: pokegradeResult,
        vellum: null,
        identities: { pokegrade: pokegradeResult.identity },
        identityConflict: false,
        localAbstained: false,
        pokegradeSkipped: false,
        reason: null,
      };
    } else {
      return {
        ok: false,
        identity: null,
        identities: {},
        identityConflict: false,
        comps: {},
        suggested: null,
        reason: 'no identity client configured',
        action: 'needs_review',
        grading: null,
        mode: null,
        idSource: null,
        pricingSources: [],
      };
    }
  } catch (err) {
    if (err instanceof RetryablePokegradeError) {
      throw err;
    }
    return {
      ok: false,
      identity: null,
      identities: {},
      identityConflict: false,
      comps: {},
      suggested: null,
      reason: err?.message || 'identity failed',
      action: 'error',
      grading: null,
      mode: null,
      idSource: null,
      pricingSources: [],
      error: true,
    };
  }

  const identity = resolveResult.identity;
  if (!identity) {
    return {
      ok: false,
      identity: null,
      identities: resolveResult.identities,
      identityConflict: resolveResult.identityConflict,
      comps: {},
      suggested: null,
      reason: resolveResult.reason || 'no identity',
      action: 'needs_review',
      grading: pokegradeResult?.grading ?? null,
      mode: resolveResult.mode,
      idSource:
        resolveResult.mode === 'local-only' ? 'vellum-ai-solo' : resolveResult.mode,
      pricingSources: [],
    };
  }

  const [
    tcgplayerResult,
    ebayResult,
    collectrResult,
    rapidapiResult,
    justtcgResult,
    pokewalletResult,
    pokemontcgapiResult,
  ] = await Promise.all([
    Promise.resolve()
      .then(() => tcgplayerClient?.getMarketPrice?.(identity))
      .catch((err) => {
        console.error('TCGPlayer comps failed:', err.message);
        return null;
      }),
    Promise.resolve()
      .then(() => ebaySoldsClient?.getRecentSolds?.(identity))
      .catch((err) => {
        console.error('eBay solds comps failed:', err.message);
        return { prices: [], median: null };
      }),
    Promise.resolve()
      .then(() => collectrClient?.getMarketPrice?.(identity) ?? null)
      .catch((err) => {
        console.error('Collectr comps failed:', err.message);
        return null;
      }),
    Promise.resolve()
      .then(() => rapidPokemonTcgClient?.getMarketPrice?.(identity) ?? null)
      .catch((err) => {
        console.error('RapidAPI Pokemon TCG comps failed:', err.message);
        return null;
      }),
    Promise.resolve()
      .then(() => justTcgClient?.getMarketPrice?.(identity) ?? null)
      .catch((err) => {
        console.error('JustTCG comps failed:', err.message);
        return null;
      }),
    Promise.resolve()
      .then(() => pokeWalletClient?.getMarketPrice?.(identity) ?? null)
      .catch((err) => {
        console.error('PokéWallet comps failed:', err.message);
        return null;
      }),
    Promise.resolve()
      .then(() => pokemonTcgApiClient?.getPrices?.(identity) ?? null)
      .catch((err) => {
        console.error('pokemontcg.io comps failed:', err.message);
        return null;
      }),
  ]);

  const cardmarketResult = pokemontcgapiResult?.cardmarket ?? null;
  const pokemontcgapiTcg = pokemontcgapiResult?.tcgplayer
    ? { ...pokemontcgapiResult.tcgplayer, source: 'pokemontcg-io', name: pokemontcgapiResult.name }
    : null;

  const decision = decidePrice(
    {
      pokegrade: pokegradeResult,
      collectr: collectrResult,
      tcgplayer: tcgplayerResult,
      ebay: ebayResult,
      rapidapi: rapidapiResult,
      justtcg: justtcgResult,
      pokewallet: pokewalletResult,
      pokemontcgapi: pokemontcgapiTcg,
      cardmarket: cardmarketResult,
    },
    config,
  );

  let action = decision.action;
  let reason = decision.reason;
  if (resolveResult.identityConflict) {
    action = 'needs_review';
    reason = resolveResult.reason || 'identity sources disagree';
  } else if (resolveResult.localAbstained && resolveResult.mode === 'dual' && action === 'auto') {
    reason = `${reason} (VellumAI abstained)`;
  }

  const idSource =
    resolveResult.mode === 'local-only'
      ? 'vellum-ai-solo'
      : resolveResult.mode === 'dual'
        ? 'dual'
        : 'pokegrade';

  return {
    ok: true,
    identity,
    identities: resolveResult.identities,
    identityConflict: resolveResult.identityConflict,
    comps: decision.comps,
    suggested: decision.suggested,
    reason,
    action,
    grading: pokegradeResult?.grading ?? resolveResult.vellum?.grading ?? null,
    mode: resolveResult.mode,
    idSource,
    pricingSources: listPricingSources(decision.comps, pokegradeResult),
    gridPngB64: resolveResult.vellum?.raw?.grid_png_b64 ?? null,
    candidates: resolveResult.vellum?.candidates ?? [],
    vellumConfidence: resolveResult.vellum?.confidence ?? null,
  };
}

/**
 * Names of sources that returned a usable market number.
 * @param {Record<string, unknown>|null|undefined} comps
 * @param {{ value?: number|null }|null|undefined} pokegradeResult
 */
export function listPricingSources(comps, pokegradeResult = null) {
  const map = { ...(comps && typeof comps === 'object' ? comps : {}) };
  if (map.pokegrade == null && typeof pokegradeResult?.value === 'number') {
    map.pokegrade = pokegradeResult.value;
  }
  const sources = [];
  for (const key of ['pokegrade', 'collectr', 'tcgplayer', 'ebay', 'rapidapi', 'justtcg', 'pokewallet', 'pokemontcgapi', 'cardmarket']) {
    const row = map[key];
    if (row == null) {
      continue;
    }
    if (typeof row === 'number' && Number.isFinite(row)) {
      sources.push(key);
      continue;
    }
    if (typeof row === 'object') {
      const n =
        row.market ??
        row.mid ??
        row.median ??
        row.value ??
        row.price ??
        row.usd ??
        null;
      if (typeof n === 'number' && Number.isFinite(n)) {
        sources.push(key);
      }
    }
  }
  return sources;
}
