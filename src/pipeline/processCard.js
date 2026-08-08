import { RetryablePokegradeError } from '../pokegrade/client.js';
import { decidePrice } from '../pricing/pricing.js';

export const MARKETPLACES = ['mercari', 'ebay'];

export async function processCard(
  cardId,
  { queue, pokegradeClient, tcgplayerClient, ebaySoldsClient, config = {}, createDraft } = {},
) {
  const card = queue.get(cardId);

  let pokegradeResult;
  try {
    pokegradeResult = await pokegradeClient.evaluateFrontImage(card.frontImagePath);
  } catch (err) {
    if (err instanceof RetryablePokegradeError) {
      return card;
    }
    throw err;
  }

  const { identity } = pokegradeResult;
  const [tcgplayerResult, ebayResult] = await Promise.all([
    tcgplayerClient.getMarketPrice(identity),
    ebaySoldsClient.getRecentSolds(identity),
  ]);

  const decision = decidePrice(
    { pokegrade: pokegradeResult, tcgplayer: tcgplayerResult, ebay: ebayResult },
    config,
  );

  queue.setPriced(cardId, {
    identity,
    comps: decision.comps,
    suggested: decision.suggested,
  });

  if (decision.action === 'needs_review') {
    return queue.setStatus(cardId, 'needs_review');
  }

  const record = queue.setStatus(cardId, 'drafting');
  if (createDraft) {
    const selected = MARKETPLACES.filter((marketplace) => card[marketplace]);
    for (const marketplace of selected) {
      await createDraft(marketplace, record);
    }
  }
  return record;
}
