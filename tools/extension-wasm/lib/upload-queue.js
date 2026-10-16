// Sends queued contributions to the relay in batches. Failures keep the batch and wait longer each time.

export const BATCH_SIZE = 20;
const BASE_DELAY_MS = 60 * 1000;
const MAX_DELAY_MS = 6 * 3600 * 1000;

/** How long to wait after the `failures`-th failure in a row. */
export function backoffDelay(failures) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, failures - 1));
}

// The relay refuses a batch it will never accept; retrying would only repeat the refusal.
const retryable = (status) => status >= 500 || status === 429 || status === 408;

/**
 * @param backoff { get(): { failures, nextAt } | null, set(state), clear() } persisted, because the worker sleeps
 * @param fetchFn fetch-compatible
 */
export function createUploader({ store, relayUrl, fetchFn = (...args) => fetch(...args), backoff, now = Date.now }) {
  let running = null;

  async function drain() {
    if (!relayUrl) return { sent: 0, left: await store.count(), inert: true };
    let sent = 0;
    let dropped = 0;
    for (;;) {
      const waiting = await backoff.get();
      if (waiting && now() < waiting.nextAt) return { sent, left: await store.count(), waiting: true };
      const batch = await store.peek(BATCH_SIZE);
      if (batch.length === 0) return dropped ? { sent, left: 0, dropped } : { sent, left: 0 };
      let status = 0;
      try {
        const response = await fetchFn(relayUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({ v: 1, contributions: batch.map((row) => row.item) }),
        });
        status = response.status;
        if (!response.ok && retryable(status)) status = -1;
        else if (response.ok) status = 0;
      } catch {
        status = -1;
      }
      if (status === -1) {
        const failures = ((await backoff.get())?.failures ?? 0) + 1;
        await backoff.set({ failures, nextAt: now() + backoffDelay(failures) });
        return { sent, left: await store.count(), waiting: true };
      }
      await store.remove(batch.map((row) => row.seq));
      await backoff.clear();
      if (status === 0) sent += batch.length;
      else dropped += batch.length;
    }
  }

  return {
    /** One drain at a time: a second request while one runs shares its result. */
    flush() {
      running ??= drain().finally(() => { running = null; });
      return running;
    },
  };
}
