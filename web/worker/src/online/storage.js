// A synchronous storage for the Online host over a Durable Object's storage (files.js says why it must be
// synchronous): what is under the prefix read once into memory at the start, every write kept there and passed on to
// the Durable Object's storage at once (not awaited: the Durable Object's output gate holds its replies until the
// writes are durable).  On a SQLite-backed Durable Object, state.storage.kv (synchronous already) may be given instead.

/** @param doStorage a DurableObjectStorage (state.storage) @returns {Promise<{get, put, delete, list}>} */
export async function syncStorage(doStorage, prefix = 'online/') {
  const m = new Map();
  const all = await doStorage.list({ prefix });
  for (const [k, v] of all) m.set(k, typeof v === 'string' ? v : String(v));
  return {
    get: (k) => m.get(k),
    put: (k, v) => {
      if (v === undefined) {
        m.delete(k);
        doStorage.delete(k);
        return;
      }
      m.set(k, v);
      doStorage.put(k, v);
    },
    delete: (k) => {
      m.delete(k);
      doStorage.delete(k);
    },
    list: (p) => [...m.keys()].filter((k) => k.startsWith(p)),
  };
}

