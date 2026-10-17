// The upload queue and the downloaded bundle live in IndexedDB, in a database of their own:
// opting out deletes the queue without touching corrections.
//   pack     one record, the live bundle: { manifest, shas: { assetName: sha256 } }
//   assets   the downloaded bundle files, by sha256, so a file is fetched only when its sha changes
//   derived  one computed copy (the adapted catalog), keyed by what it was computed from

const DB_NAME = "card-scanner-share";
const QUEUE = "queue";
const PACK = "pack";
const ASSETS = "assets";
const DERIVED = "derived";
const PACK_KEY = "current";

export const MAX_QUEUED = 200;

/** @param idb an IndexedDB factory; the tests pass a small fake. */
export function createShareStore(idb = globalThis.indexedDB) {
  let opening = null;

  function open() {
    if (!idb) return Promise.reject(new Error("IndexedDB is not available here"));
    opening ??= new Promise((resolve, reject) => {
      const request = idb.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: "seq", autoIncrement: true });
        if (!db.objectStoreNames.contains(PACK)) db.createObjectStore(PACK, { keyPath: "id" });
        if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: "sha" });
        if (!db.objectStoreNames.contains(DERIVED)) db.createObjectStore(DERIVED, { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const forget = () => { opening = null; };
        db.onclose = forget;
        db.onversionchange = () => { db.close(); forget(); };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch((err) => {
      opening = null;
      throw err;
    });
    return opening;
  }

  async function attempt(mode, storeName, start) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = start(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    });
  }

  // A connection the browser is closing throws InvalidStateError; a fresh one works.
  async function run(mode, storeName, start) {
    try {
      return await attempt(mode, storeName, start);
    } catch (err) {
      if (err?.name !== "InvalidStateError") throw err;
      opening = null;
      return attempt(mode, storeName, start);
    }
  }

  return {
    /** Adds at the end; past MAX_QUEUED the oldest are dropped. */
    enqueue: (item) => run("readwrite", QUEUE, (store) => {
      const saved = store.put({ item });
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result.slice(0, Math.max(0, keys.result.length - MAX_QUEUED))) store.delete(key);
      };
      return saved;
    }),
    /** The oldest `limit` queued items as { seq, item }. */
    peek: (limit) => run("readonly", QUEUE, (store) => {
      const all = store.getAll(null, limit);
      return { get result() { return all.result.slice(0, limit).map(({ seq, item }) => ({ seq, item })); } };
    }),
    remove: (seqs) => run("readwrite", QUEUE, (store) => {
      let last;
      for (const seq of seqs) last = store.delete(seq);
      return last ?? store.count();
    }),
    count: () => run("readonly", QUEUE, (store) => store.count()),
    clearQueue: () => run("readwrite", QUEUE, (store) => store.clear()),
    /** The live bundle's record; one at a time. */
    savePack: (pack) => run("readwrite", PACK, (store) => store.put({ ...pack, id: PACK_KEY })),
    getPack: () => run("readonly", PACK, (store) => store.get(PACK_KEY)),
    clearPack: () => run("readwrite", PACK, (store) => store.clear()),
    putAsset: (sha, bytes) => run("readwrite", ASSETS, (store) => store.put({ sha, bytes })),
    getAsset: (sha) => run("readonly", ASSETS, (store) => store.get(sha)),
    /** Deletes every stored file whose sha256 is not in `keep`. */
    pruneAssets: (keep) => run("readwrite", ASSETS, (store) => {
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result) if (!keep.includes(key)) store.delete(key);
      };
      return keys;
    }),
    clearAssets: () => run("readwrite", ASSETS, (store) => store.clear()),
    getDerived: (key) => run("readonly", DERIVED, (store) => store.get(key)),
    /** Keeps only this one computed copy. */
    putDerived: (key, bytes) => run("readwrite", DERIVED, (store) => {
      store.clear();
      return store.put({ key, bytes });
    }),
  };
}
