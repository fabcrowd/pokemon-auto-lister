import { RetryablePokegradeError } from '../pokegrade/client.js';
import { decidePrice } from '../pricing/pricing.js';
import { pickBackImagePath } from '../photos/roles.js';

export const MARKETPLACES = ['mercari', 'ebay'];
export { pickBackImagePath } from '../photos/roles.js';

export async function processCard(
  cardId,
  {
    queue,
    pokegradeClient,
    identityResolver = null,
    tcgplayerClient,
    ebaySoldsClient,
    collectrClient,
    rapidPokemonTcgClient = null,
    justTcgClient = null,
    pokeWalletClient = null,
    config = {},
    createDraft,
  } = {},
) {
  const card = queue.get(cardId);
  const backImagePath = pickBackImagePath(card);

  if (!card.frontImagePath) {
    queue.setPriced(cardId, {
      identity: null,
      identities: {},
      identityConflict: false,
      comps: {},
      suggested: null,
      reason: card.intakeReason || 'no full-card photo',
      action: 'needs_review',
      grading: null,
    });
    return queue.setStatus(cardId, 'needs_review');
  }

  let resolveResult;
  let pokegradeResult = null;

  try {
    if (identityResolver) {
      resolveResult = await identityResolver.evaluateFrontImage(card.frontImagePath, {
        backImagePath,
      });
      pokegradeResult = resolveResult.pokegrade;
    } else {
      pokegradeResult = await pokegradeClient.evaluateFrontImage(card.frontImagePath, {
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
    }
  } catch (err) {
    if (err instanceof RetryablePokegradeError) {
      return card;
    }
    return queue.setStatus(cardId, 'error');
  }

  const identity = resolveResult.identity;
  if (!identity) {
    queue.setPriced(cardId, {
      identity: null,
      identities: resolveResult.identities,
      identityConflict: resolveResult.identityConflict,
      idSource: resolveResult.mode === 'local-only' ? 'vellum-ai-solo' : resolveResult.mode,
      mode: resolveResult.mode,
      comps: {},
      suggested: null,
      reason: resolveResult.reason || 'no identity',
      action: 'needs_review',
      grading: pokegradeResult?.grading ?? null,
    });
    return queue.setStatus(cardId, 'needs_review');
  }

  const [
    tcgplayerResult,
    ebayResult,
    collectrResult,
    rapidapiResult,
    justtcgResult,
    pokewalletResult,
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
  ]);

  const decision = decidePrice(
    {
      pokegrade: pokegradeResult,
      collectr: collectrResult,
      tcgplayer: tcgplayerResult,
      ebay: ebayResult,
      rapidapi: rapidapiResult,
      justtcg: justtcgResult,
      pokewallet: pokewalletResult,
    },
    config,
  );

  let action = decision.action;
  let reason = decision.reason;
  if (resolveResult.identityConflict) {
    action = 'needs_review';
    reason = resolveResult.reason || 'identity sources disagree';
  } else if (resolveResult.localAbstained && resolveResult.mode === 'dual') {
    // Dual with Vellum abstain: still allow PG path; note in reason when reviewing
    if (action === 'auto') {
      reason = `${reason} (VellumAI abstained)`;
    }
  }

  const idSource =
    resolveResult.mode === 'local-only'
      ? 'vellum-ai-solo'
      : resolveResult.mode === 'dual'
        ? 'dual'
        : 'pokegrade';

  queue.setPriced(cardId, {
    identity,
    identities: resolveResult.identities,
    identityConflict: resolveResult.identityConflict,
    idSource,
    mode: resolveResult.mode,
    comps: decision.comps,
    suggested: decision.suggested,
    reason,
    action,
    grading: pokegradeResult?.grading ?? resolveResult.vellum?.grading ?? null,
  });

  if (action === 'needs_review') {
    return queue.setStatus(cardId, 'needs_review');
  }

  const listPrice = decision.suggested?.mercari ?? decision.suggested?.ebay ?? null;
  if (typeof listPrice === 'number') {
    queue.patch(cardId, { listPrice });
  }

  const record = queue.setStatus(cardId, 'drafting');
  if (createDraft) {
    const selected = MARKETPLACES.filter((marketplace) => card[marketplace]);
    for (const marketplace of selected) {
      await createDraft(marketplace, { ...record, listPrice: listPrice ?? record.listPrice });
    }
  }
  return record;
}
