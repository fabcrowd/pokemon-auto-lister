// Saved corrections live in IndexedDB, not chrome.storage: the crops are too big for its quota.
// The service worker sleeps and forgets memory, so the pictures of recent scans are kept here too.

const DB_NAME = "card-scanner";
const CORRECTIONS = "corrections";
const SCANS = "scans";
// dev-only:start
const PHOTOS = "testPhotos";
// dev-only:end
const REFERENCES = "references";
const KEEP_SCANS = 2;

/** @param idb an IndexedDB factory; the tests pass a small fake. */
export function createCorrectionsStore(idb = globalThis.indexedDB) {
  let opening = null;

  function open() {
    if (!idb) return Promise.reject(new Error("IndexedDB is not available here"));
    opening ??= new Promise((resolve, reject) => {
      const request = idb.open(DB_NAME, 4);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CORRECTIONS)) {
          db.createObjectStore(CORRECTIONS, { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(SCANS)) db.createObjectStore(SCANS, { keyPath: "scanId" });
        // dev-only:start
        if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS, { keyPath: "id" });
        // dev-only:end
        if (!db.objectStoreNames.contains(REFERENCES)) db.createObjectStore(REFERENCES, { keyPath: "id" });
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

  // A list of store names gives `start` a function that picks the store, all inside one transaction.
  async function attempt(mode, storeName, start) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = start(Array.isArray(storeName) ? (name) => tx.objectStore(name) : tx.objectStore(storeName));
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
    /** Insert, or replace the record with the same id. */
    save: (record) => run("readwrite", CORRECTIONS, (store) => store.put(record)),
    getCorrection: (id) => run("readonly", CORRECTIONS, (store) => store.get(id)),
    // Without the pictures, which are most of each row: one row is held at a time.
    correctionHeads: () => run("readonly", CORRECTIONS, (store) => {
      const heads = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        const { id, ts, pickedId, crop, count, wrongId, lastAgreed } = at.value;
        heads.push({ id, ts, pickedId, hasCrop: Boolean(crop), count: count || 1, ...(wrongId ? { wrongId } : {}), ...(lastAgreed ? { lastAgreed } : {}) });
        at.continue();
      };
      return { get result() { return heads; } };
    }),
    deleteCorrection: (id) => run("readwrite", CORRECTIONS, (store) => store.delete(id)),
    all: () => run("readonly", CORRECTIONS, (store) => store.getAll()),
    count: () => run("readonly", CORRECTIONS, (store) => store.count()),
    clear: () => run("readwrite", CORRECTIONS, (store) => store.clear()),
    saveScan: (scan) => run("readwrite", SCANS, (store) => {
      const saved = store.put(scan);
      const everything = store.getAll();
      everything.onsuccess = () => {
        const newestFirst = everything.result.sort((a, b) => b.ts - a.ts);
        for (const old of newestFirst.slice(KEEP_SCANS)) store.delete(old.scanId);
      };
      return saved;
    }),
    getScan: (scanId) => run("readonly", SCANS, (store) => store.get(scanId)),
    // dev-only:start
    /** Insert, or replace the photo with the same id. */
    savePhoto: (photo) => run("readwrite", PHOTOS, (store) => store.put(photo)),
    countPhotos: () => run("readonly", PHOTOS, (store) => store.count()),
    photoIds: () => run("readonly", PHOTOS, (store) => store.getAllKeys()),
    // Photos are big, so callers fetch a few at a time to stay under the message size limit.
    getPhotos: (ids) => (ids.length === 0 ? Promise.resolve([]) : run("readonly", PHOTOS, (store) => {
      const found = [];
      for (const id of ids) {
        store.get(id).onsuccess = (event) => {
          if (event.target.result) found.push(event.target.result);
        };
      }
      return { get result() { return found; } };
    })),
    clearPhotos: () => run("readwrite", PHOTOS, (store) => store.clear()),
    // dev-only:end
    /** Insert, or replace the reference with the same id (the id of its correction). */
    saveReference: (ref) => run("readwrite", REFERENCES, (store) => store.put(ref)),
    allReferences: () => run("readonly", REFERENCES, (store) => store.getAll()),
    countReferences: () => run("readonly", REFERENCES, (store) => store.count()),
    deleteReference: (id) => run("readwrite", REFERENCES, (store) => store.delete(id)),
    clearReferences: () => run("readwrite", REFERENCES, (store) => store.clear()),
    // dev-only:start
    /** Swap every reference for `rows` in one transaction, so no reader sees half a set. */
    replaceReferences: (rows, { clearCorrections = false } = {}) => run("readwrite", [REFERENCES, CORRECTIONS], (storeOf) => {
      if (clearCorrections) storeOf(CORRECTIONS).clear();
      const refs = storeOf(REFERENCES);
      let last = refs.clear();
      for (const row of rows) last = refs.put(row);
      return last;
    }),
    // dev-only:end
  };
}
