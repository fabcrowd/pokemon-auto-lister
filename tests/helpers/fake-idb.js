
// Just enough of IndexedDB: requests answer on a later microtask and a transaction
// completes once every request it made, including ones made from callbacks, is done.
export function fakeIndexedDB({ failOpen = false, invalidStateOnce = false } = {}) {
  const stores = new Map();
  const opened = [];
  const transactions = [];
  const dbs = [];
  let invalidState = invalidStateOnce;
  const later = (fn) => Promise.resolve().then(fn);

  function makeStore(name, tx) {
    const entry = stores.get(name);
    const request = (compute) => {
      const req = { result: undefined, onsuccess: null };
      tx.pending += 1;
      later(() => {
        req.result = compute();
        req.onsuccess?.({ target: req });
        tx.pending -= 1;
        if (tx.pending === 0) later(() => tx.oncomplete?.());
      });
      return req;
    };
    const put = (value) => request(() => {
      const key = value[entry.options.keyPath] ?? entry.next++;
      entry.rows.set(key, { ...value, [entry.options.keyPath]: key });
      return key;
    });
    return {
      add: put,
      put,
      get: (key) => request(() => entry.rows.get(key)),
      delete: (key) => request(() => { entry.rows.delete(key); }),
      getAll: () => request(() => [...entry.rows.values()].map((r) => ({ ...r }))),
      getAllKeys: () => request(() => [...entry.rows.keys()]),
      count: () => request(() => entry.rows.size),
      clear: () => request(() => { entry.rows.clear(); }),
      openCursor: () => {
        const req = { result: null, onsuccess: null };
        const rows = [...entry.rows.values()];
        let at = 0;
        tx.pending += 1;
        const step = () => later(() => {
          req.result = at < rows.length ? { value: { ...rows[at++] }, continue: step } : null;
          req.onsuccess?.({ target: req });
          if (!req.result) {
            tx.pending -= 1;
            if (tx.pending === 0) later(() => tx.oncomplete?.());
          }
        });
        step();
        return req;
      },
    };
  }

  return {
    opened,
    transactions,
    stores,
    dbs,
    open(name, version) {
      opened.push({ name, version });
      const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        if (failOpen) {
          req.error = new Error('blocked');
          req.onerror?.({ target: req });
          return;
        }
        const db = {
          onclose: null,
          onversionchange: null,
          closed: false,
          close() { this.closed = true; },
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n, options) => { stores.set(n, { rows: new Map(), options, next: 1 }); },
          transaction: (n) => {
            transactions.push(n);
            if (invalidState) {
              invalidState = false;
              throw Object.assign(new Error('closing'), { name: 'InvalidStateError' });
            }
            const tx = { oncomplete: null, pending: 0 };
            tx.objectStore = (name) => makeStore(Array.isArray(n) ? name : n, tx);
            return tx;
          },
        };
        dbs.push(db);
        req.result = db;
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}
