// The switch's store, lan-addresses.json: a port of web/server-rs/crates/lan/src/store.rs (and members.rs store_list,
// the list it keeps).  [{"v":"10.77.0.2","h":"<base64url of the token's SHA-256>"},...]: the addresses held and then
// the ones reserved, so that the players come back to the same addresses after a restart.
//
// Rust writes a file whole (a temporary file renamed over the old one), half a second after any change while players
// come and go; here the file is a value under STORE_KEY in a storage of {get(key), put(key, value)} (a Durable
// Object's storage, or a Map for tests), whose calls may return promises or values: load and save always return
// promises.  The value is the same JSON text, byte for byte.

import { fromSlice, utf8Bytes } from '../util/serde-json.js';
import { base64url, fromBase64url, vipStr } from '../util/js.js';
import { jsString, vipNum } from './text.js';

/** the store's name: the Rust server's file name in its state folder */
export const STORE_KEY = 'lan-addresses.json';

const isThenable = (x) => x !== null && (typeof x === 'object' || typeof x === 'function') && typeof x.then === 'function';
const lossy = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/**
 * store.rs Store::load's reading, on what the storage held: the addresses and their hashes (none when it is missing or
 * broken; an entry that is not an address the switch hands out with a hash of 32 bytes is skipped).  value: a string,
 * bytes (Uint8Array or ArrayBuffer: read as Rust's String::from_utf8_lossy), or undefined/null for none.
 * @returns {Array<[number, Uint8Array]>}
 */
export function parseStore(value) {
  if (value === undefined || value === null) return [];
  let bytes;
  if (typeof value === 'string') bytes = utf8Bytes(value);
  else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    // (String::from_utf8_lossy: each bad sequence one U+FFFD, as the WHATWG decoder does)
    bytes = utf8Bytes(lossy.decode(value));
  } else return [];
  const r = fromSlice(bytes);
  if (!r.ok || !Array.isArray(r.value)) return [];
  const out = [];
  for (const e of r.value) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) continue;
    const v = vipNum(jsString(Object.hasOwn(e, 'v') ? e.v : undefined));
    const h = Object.hasOwn(e, 'h') ? e.h : undefined;
    if (typeof h !== 'string') continue;
    const hash = fromBase64url(h);
    if (v !== 0 && hash.length === 32) out.push([v, hash]);
  }
  return out;
}

/**
 * store.rs Store::load: what the switch starts with, from the storage
 * @param {{get(key: string): any}} storage
 * @returns {Promise<Array<[number, Uint8Array]>>}
 */
export async function load(storage) {
  return parseStore(await storage.get(STORE_KEY));
}

/** store.rs Store::written, per storage: the newest list written, and the save in progress */
const states = new WeakMap();
function stateOf(storage) {
  let st = states.get(storage);
  if (st === undefined) states.set(storage, (st = { written: 0, tail: null }));
  return st;
}

/**
 * store.rs Store::save: the list as it was at seq (the next change tries again when this fails).  An older list never
 * overwrites a newer one: saves to one storage run one after another (Rust: under its lock), and one whose seq is not
 * past the newest written does nothing.  Resolves to whether it wrote (a failed write resolves false, as Rust ignores
 * it).
 * @param {{put(key: string, value: string): any}} storage
 * @param {number} seq
 * @param {string} json
 * @returns {Promise<boolean>}
 */
export function save(storage, seq, json) {
  const st = stateOf(storage);
  const go = () => {
    if (seq <= st.written) return false;
    let r;
    try {
      r = storage.put(STORE_KEY, json);
    } catch {
      return false;
    }
    if (!isThenable(r)) {
      st.written = seq;
      return true;
    }
    return Promise.resolve(r).then(
      () => {
        if (seq > st.written) st.written = seq;
        return true;
      },
      () => false,
    );
  };
  // a storage that answers at once is written at once; else after the save before
  const res = st.tail === null ? go() : st.tail.then(go);
  if (!isThenable(res)) return Promise.resolve(res);
  const tail = res.then(
    () => undefined,
    () => undefined,
  );
  st.tail = tail;
  tail.then(() => {
    if (st.tail === tail) st.tail = null;
  });
  return res;
}

/**
 * members.rs store_list: what the store keeps, the JSON text: entries [vip, hash (32 bytes)] in order, the addresses
 * held first, then the ones reserved (the caller picks those: members.rs takes the peers, then the reservations still
 * running whose address no peer holds)
 * @param {Iterable<[number, Uint8Array]>} entries
 * @returns {string}
 */
export function storeList(entries) {
  let s = '[';
  let first = true;
  for (const [v, h] of entries) {
    if (!first) s += ',';
    first = false;
    s += '{"v":"' + vipStr(v) + '","h":"' + base64url(h) + '"}';
  }
  return s + ']';
}
