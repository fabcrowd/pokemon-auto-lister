import { cardPhotoPaths, findPostedCollision } from '../photos/postedLedger.js';

// Routes a marketplace listing request to its driver and records the outcome
// on the queue record. Driver failures are recorded per-marketplace rather
// than thrown, so one marketplace failing never blocks another marketplace
// (partial success). Mercari auto-publish → markListed; eBay drafts → markDrafted.
export function createDraftDispatcher({ queue, drivers = {}, dataDir = 'data' }) {
  return async function createDraft(marketplace, record) {
    const driver = drivers[marketplace];
    if (!driver) {
      throw new Error(`No draft driver configured for marketplace: ${marketplace}`);
    }

    if (record.drafts?.[marketplace]?.created) {
      return queue.get(record.id);
    }

    const collision = findPostedCollision(dataDir, cardPhotoPaths(record));
    if (collision && (!collision.cardId || collision.cardId !== record.id)) {
      const message = `Refusing to re-post photo already used${
        collision.cardId ? ` on card ${collision.cardId}` : ''
      } (${collision.via}: ${collision.path})`;
      return queue.recordDraftError(record.id, marketplace, message);
    }

    try {
      const draftInfo = await driver(record);
      if (marketplace === 'mercari' && (draftInfo?.published || draftInfo?.listingUrl)) {
        return queue.markListed(record.id, marketplace, draftInfo);
      }
      return queue.markDrafted(record.id, marketplace, draftInfo);
    } catch (err) {
      return queue.recordDraftError(record.id, marketplace, err.message);
    }
  };
}
