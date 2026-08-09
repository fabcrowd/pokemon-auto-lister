// Routes a marketplace draft request to its driver and records the outcome
// on the queue record. Driver failures are recorded per-marketplace rather
// than thrown, so one marketplace failing never blocks another marketplace's
// draft from completing (partial success).
export function createDraftDispatcher({ queue, drivers = {} }) {
  return async function createDraft(marketplace, record) {
    const driver = drivers[marketplace];
    if (!driver) {
      throw new Error(`No draft driver configured for marketplace: ${marketplace}`);
    }

    try {
      const draftInfo = await driver(record);
      return queue.markDrafted(record.id, marketplace, draftInfo);
    } catch (err) {
      return queue.recordDraftError(record.id, marketplace, err.message);
    }
  };
}
