// The opt-in "Help improve recognition for everyone" setting. Off by default, and inert when the build
// has no relay address (lib/shared-config.js). The random install id exists only while the setting is on.

import { buildContribution } from "./contribution.js";

const ENABLED = "shareEnabled";
const INSTALL = "shareInstall";

/**
 * @param storage { get(key), set(key, value), remove(key) } over chrome.storage.local
 * @param store the share store; uploader flushes it
 */
export function createSharing({ storage, store, uploader, relayUrl, randomUUID = () => crypto.randomUUID(), now = () => new Date() }) {
  const available = () => Boolean(relayUrl);

  async function enabled() {
    return available() && (await storage.get(ENABLED)) === true && typeof (await storage.get(INSTALL)) === "string";
  }

  return {
    available,
    enabled,
    /** The id a deletion request names, or null while sharing is off. */
    async installId() {
      return (await enabled()) ? storage.get(INSTALL) : null;
    },
    async enable() {
      if (!available()) throw new Error("Sharing is not available in this build.");
      if (typeof (await storage.get(INSTALL)) !== "string") await storage.set(INSTALL, randomUUID());
      await storage.set(ENABLED, true);
    },
    /** Forgets the install id and everything still waiting to be sent. */
    async disable() {
      await storage.remove(ENABLED);
      await storage.remove(INSTALL);
      await store.clearQueue();
    },
    /** Queues one photo's rows. False when sharing is off. Throws on rows that break schema v1. */
    async contribute({ photoId, cards }) {
      if (!(await enabled())) return false;
      const contribution = buildContribution({ install: await storage.get(INSTALL), photoId, cards, now: now() });
      await store.enqueue(contribution);
      // Sending can wait: the queue is already safe.
      uploader.flush().catch((err) => console.error("[share] upload failed:", err?.message || err));
      return true;
    },
  };
}
