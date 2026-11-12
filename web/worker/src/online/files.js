// The state the online host keeps (crates/online/src/files.rs: stats.json, races.json, the friends lists' shelf),
// through the injected storage instead of files: {get(key) -> string|undefined|null, put(key, string),
// delete(key), list(prefix) -> keys}, synchronous (a SQLite-backed Durable Object's ctx.storage.kv in production, a
// Map in the tests).  Keys are the files' paths under the server's state folder: "online/stats.json",
// "online/races.json", "online/friends/ab/ab....json", "online/buddies.json".

export class Store {
  /** @param storage the injected storage, or null (in memory only: nothing kept) @param prefix the folder */
  constructor(storage, prefix = 'online/') {
    this.storage = storage;
    this.prefix = prefix;
  }
  /** the file's text, or null */
  get(name) {
    const v = this.storage.get(this.prefix + name);
    return v === undefined || v === null ? null : String(v);
  }
  /** written whole: null, or the error's message */
  put(name, text) {
    try {
      this.storage.put(this.prefix + name, text);
      return null;
    } catch (e) {
      return String(e && e.message ? e.message : e);
    }
  }
  delete(name) {
    try {
      if (this.storage.delete) this.storage.delete(this.prefix + name);
      else this.storage.put(this.prefix + name, undefined);
    } catch {
      // as a file that could not be removed
    }
  }
  /** the names under sub (relative to the folder), sorted */
  list(sub) {
    if (!this.storage.list) return [];
    const p = this.prefix + sub;
    return [...this.storage.list(p)].filter((k) => k.startsWith(p)).map((k) => k.slice(this.prefix.length)).sort();
  }
  /** the file's name as the console lines quote it */
  path(name) {
    return this.prefix + name;
  }
}

/** a storage of a Map (the tests, and an in-memory server) */
export class MapStorage {
  constructor(m = new Map()) {
    this.m = m;
  }
  get(k) {
    return this.m.get(k);
  }
  put(k, v) {
    if (v === undefined) this.m.delete(k);
    else this.m.set(k, v);
  }
  delete(k) {
    this.m.delete(k);
  }
  list(prefix) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix));
  }
}

