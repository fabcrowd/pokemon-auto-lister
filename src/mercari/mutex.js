/**
 * Serialize access to the shared Mercari Chrome page.
 * Sell drafts and sniper scans must never race on one persistent profile.
 */
export function createMercariMutex() {
  let chain = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withLock(fn) {
    const run = chain.then(() => fn());
    // Keep the chain alive even if fn rejects
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return { withLock };
}
