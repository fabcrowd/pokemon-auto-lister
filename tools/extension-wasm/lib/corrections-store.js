// Saved corrections live in IndexedDB, not chrome.storage: the crops are too big for its quota.
// The service worker sleeps and forgets memory, so the pictures of recent scans are kept here too.

const DB_NAME = "card-scanner";
const CORRECTIONS = "corrections";
const SCANS = "scans";
const KEEP_SCANS = 2;

/** @param idb an IndexedDB factory; the tests pass a small fake. */
export function createCorrectionsStore(idb = globalThis.indexedDB) {
  let opening = null;

  function open() {
    if (!idb) return Promise.reject(new Error("IndexedDB is not available here"));
    opening ??= new Promise((resolve, reject) => {
      const request = idb.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CORRECTIONS)) {
          db.createObjectStore(CORRECTIONS, { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(SCANS)) db.createObjectStore(SCANS, { keyPath: "scanId" });
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
    /** Insert, or replace the record with the same id. */
    save: (record) => run("readwrite", CORRECTIONS, (store) => store.put(record)),
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
  };
}
