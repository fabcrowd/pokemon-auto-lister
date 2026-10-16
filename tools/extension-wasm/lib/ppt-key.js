// The PokemonPriceTracker key lives in storage.local. Older versions kept it in storage.sync,
// which copies it to the user's other signed-in browsers and to Google; it is moved out once.

const KEY = "pptApiKey";

/** Copy the key from sync to local, then drop the sync copy. The sync copy goes only after the local write succeeds. */
export async function migratePptKey(sync, local) {
  const fromSync = (await sync.get(KEY))[KEY];
  if (fromSync == null) return { migrated: false };
  const existing = (await local.get(KEY))[KEY];
  if (!existing && fromSync) await local.set({ [KEY]: fromSync });
  await sync.remove(KEY);
  return { migrated: true };
}

const migrations = new WeakMap();

// Resolves true when the sync copy is gone (or never existed), false when the migration could not run.
function ensureMigrated(storage) {
  if (!migrations.has(storage)) {
    migrations.set(
      storage,
      migratePptKey(storage.sync, storage.local).then(
        () => true,
        (err) => {
          migrations.delete(storage);
          console.error("[ppt-key] migration failed:", err?.message || err);
          return false;
        },
      ),
    );
  }
  return migrations.get(storage);
}

export async function getPptKey(storage = chrome.storage) {
  const migrated = await ensureMigrated(storage);
  const local = (await storage.local.get(KEY))[KEY];
  if (local || migrated) return local || null;
  // Sync may be unavailable only some of the time; whatever it still holds is the user's key.
  return (await storage.sync.get(KEY).catch(() => ({})))[KEY] || null;
}

export async function savePptKey(key, storage = chrome.storage) {
  await ensureMigrated(storage);
  await storage.local.set({ [KEY]: key });
}

export async function clearPptKey(storage = chrome.storage) {
  await ensureMigrated(storage);
  await storage.local.remove(KEY);
  await storage.sync.remove(KEY).catch(() => {});
}
