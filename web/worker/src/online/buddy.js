// EA Messenger (the game's "buddy server", port 13505 of the online host): friends lists, friend requests, who is
// online and what they do, messages, and game invites, between the personas logged in to this server's lobby
// (crates/online/src/buddy.rs: its module text says what each command does and why; this is that code in
// JavaScript, the same rules, frames, console lines and stored text).
//
// Kept in the store's friends/ folder, one file a persona (the shelf, by the SHA-256 of the persona in lower case),
// for claimed names only (nfsu2-claims): a list is read when its persona needs it and written when it changed, at
// most every saveMs; lists holds the lists read lately (limits.lists of them, the least recently seen going first,
// never one of a persona in the lobby or the Messenger); fans and blockers index those.  A name nobody claimed gets
// lists for the session (temp): never written.  Free roam's pages befriend and message through the same lists
// (friends()).  A buddy connection's state stays readable until the event that closed it is over (graveyard).

import { assert, cleanText, lower, stripAt, validName, slice16, monthOf, isMonth, hex, utf8, cmpStr, q } from './jsx.js';
import { encodeFrame, FieldMap, FrameReader } from './aries.js';
import { Bucket } from './bucket.js';
import { fourPrintable, slurSaid } from './rules.js';
import { sha256 } from '../util/sha256.js';
import { canonical, UNCLAIMABLE } from '../claims/claims.js';
import { blockedName, chatSlur } from '../names/index.js';

/** friends one persona has, at most, and the blocked and the players met (the Messenger's All list) */
const MAX_FRIENDS = 250;
const MAX_LIST = 50;
/** friend requests one persona has waiting, and the days one waits for its answer */
const MAX_ASKED = 20;
const ASK_DAYS = 30;
/** messages waiting for one persona, for all of them together, and the days one waits */
const MAX_MAIL = 20;
const ALL_MAIL = 20000;
const MAIL_DAYS = 7;
/** a page's message to a friend, at most (characters) */
export const PAGE_MSG_LEN = 120;
const DAY_MS = 86400000;
/** how long after the friends list the waiting messages go (buddy.rs MAIL_WAIT_MS) */
const MAIL_WAIT_MS = 3000;
/** the roster's request bits as ROST and RNOT write them */
const ASKED_ME = 'R';
const I_ASKED = 'S';
const TITL = 'Need for Speed Underground 2 [PC]';
/** the folder of the lists in the store, and the file of before it (moved in at the start) */
const SHELF = 'friends';
const OLD_FILE = 'buddies.json';
/** how often the shelf is swept of the lists of claims that ended */
const SWEEP_MS = 3600000;

/** EA Messenger's limits (buddy.rs BuddyLimits::default) */
export const BUDDY_LIMITS = Object.freeze({ lists: 50000, listRate: 20, msgRate: 10, heavyRate: 1, presenceMs: 1000 });

/** a handler's error as the Rust code returns one (Err(String)): the console line and a destroy, never a crash */
export class BuddyError extends Error {}

/** the error of a handler that needs the connection's persona once it is gone */
function nullPersona() {
  return new BuddyError("TypeError: Cannot read properties of null (reading 'toLowerCase')");
}

/** f(), a BuddyError let go (Rust's let _ = ...): true when it went through */
function quiet(f) {
  try {
    f();
    return true;
  } catch (e) {
    if (e instanceof BuddyError) return false;
    throw e;
  }
}

/** Rust's char::is_whitespace (Unicode White_Space) */
function rustSpace(c) {
  return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

/** Rust's str::trim (JS trim also takes U+FEFF and leaves U+0085) */
function rustTrim(s) {
  let a = 0, b = s.length;
  while (a < b && rustSpace(s.charCodeAt(a))) a++;
  while (b > a && rustSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** A Discord username as Discord allows one (2 to 32 of a-z, 0-9, _ and ., never two . together), from what a player
 *  typed: the spaces around it, a leading @ and capitals let go.  null: not one. */
export function discordName(typed) {
  let t = rustTrim(typed);
  if (t.startsWith('@')) t = t.slice(1);
  t = t.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return t.length >= 2 && t.length <= 32 && /^[a-z0-9_.]*$/.test(t) && !t.includes('..') ? t : null;
}

/** f64::total_cmp */
function totalCmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  if (Object.is(a, b)) return 0;
  return Object.is(a, -0) ? -1 : 1;
}

/** f64 as i64, written (Rust's `t as i64`: truncated, saturated, NaN 0) */
function i64s(t) {
  if (Number.isNaN(t)) return '0';
  if (t >= 9223372036854775807) return '9223372036854775807';
  if (t <= -9223372036854775808) return '-9223372036854775808';
  const x = Math.trunc(t);
  return Math.abs(x) < 1e21 ? String(x) : BigInt(x).toString();
}

/** an object's own field (a JSON object's), or undefined */
function own(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

/** a persona's lists (buddy.rs FriendsList): b friends, i blocked (lower -> name), r sent and q got requests (lower ->
 *  [name, t]), m the messages that wait (oldest first: {from, body, subj, kind, t}) */
function newList(name, seen) {
  return { name, b: new Map(), i: new Map(), r: new Map(), q: new Map(), m: [], seen, owner: null, temp: false, contact: null };
}

/** nothing in it to keep */
function isEmpty(l) {
  return l.b.size === 0 && l.i.size === 0 && l.r.size === 0 && l.q.size === 0 && l.m.length === 0 && l.contact === null;
}

/** keys past n deleted (IndexMap::truncate) */
function truncate(m, n) {
  if (m.size <= n) return;
  let i = 0;
  for (const k of [...m.keys()]) {
    if (i >= n) m.delete(k);
    i++;
  }
}

/** a claimed name of before claims that nobody claims (NAME, Player) */
function unclaimable(name) {
  const c = canonical(name);
  return c !== null && c !== undefined && UNCLAIMABLE.includes(c);
}

/** the shelf's file of persona k (lower case) */
export function shelfFile(k) {
  const h = hex(sha256(utf8(k)).subarray(0, 16));
  return SHELF + '/' + h.slice(0, 2) + '/' + h + '.json';
}

/** a file's JSON object, or null */
function parseObj(text) {
  if (text === null) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  return isObj(v) ? v : null;
}

function shelfRead(store, k) {
  return parseObj(store.get(shelfFile(k)));
}

/** a time the file keeps (ms since 1970, whole), or null */
function when(v) {
  return typeof v === 'number' && v >= 0 && v <= 1e15 ? Math.floor(v) : null;
}

/** names of a list's file (B, I) onto a list's map: the later spelling of a name in the earlier one's place */
function readNames(v, into, max) {
  if (!Array.isArray(v)) return;
  const n = Math.min(v.length, max);
  for (let i = 0; i < n; i++) {
    const s = str(v[i]);
    if (s !== null && validName(s)) into.set(lower(s), s);
  }
}

/** one list of a file read leniently (buddy.rs list_of_json); null: no name of a persona */
export function listOfJson(o) {
  const name = str(own(o, 'name'));
  if (name === null || !validName(name)) return null;
  const seen0 = str(own(o, 'seen'));
  const l = newList(name, seen0 !== null && isMonth(seen0) ? seen0 : '1970-01');
  const ow = str(own(o, 'owner'));
  l.owner = ow !== null && /^[A-Za-z0-9_-]{22}$/.test(ow) ? ow : null;
  readNames(own(o, 'B'), l.b, MAX_FRIENDS);
  readNames(own(o, 'I'), l.i, MAX_LIST);
  for (const [key, into] of [['R', l.r], ['Q', l.q]]) {
    const a = own(o, key);
    if (!Array.isArray(a)) continue;
    const n = Math.min(a.length, MAX_ASKED);
    for (let i = 0; i < n; i++) {
      const e = a[i];
      if (!Array.isArray(e) || e.length !== 2) continue;
      const nm = str(e[0]);
      const t = when(e[1]);
      if (nm !== null && validName(nm) && t !== null) into.set(lower(nm), [nm, t]);
    }
  }
  const a = own(o, 'M');
  if (Array.isArray(a)) {
    for (let i = Math.max(0, a.length - MAX_MAIL); i < a.length; i++) {
      const e = a[i];
      if (!isObj(e)) continue;
      const from = str(own(e, 'from'));
      const t = own(e, 't') === undefined ? null : when(own(e, 't'));
      if (from === null || !validName(from) || t === null) continue;
      const text = (k, n) => {
        const s = str(own(e, k));
        return s === null ? '' : cleanText(s, n);
      };
      const ty = str(own(e, 'type'));
      l.m.push({ from, body: text('body', 500), subj: text('subj', 64), kind: ty === null ? 'C' : slice16(ty, 4), t });
    }
  }
  const c = str(own(o, 'C'));
  l.contact = c === null ? null : discordName(c);
  return l;
}

/** ,"<key>":[names] */
function writeNames(key, names) {
  let s = ',"' + key + '":[';
  let i = 0;
  for (const n of names) {
    if (i > 0) s += ',';
    s += q(n);
    i++;
  }
  return s + ']';
}

/** one list's text, as the shelf keeps it (B always, the others when not empty) */
export function listJson(l) {
  let s = '{"v":4,"name":' + q(l.name) + ',"seen":' + q(l.seen);
  if (l.owner !== null) s += ',"owner":' + q(l.owner);
  s += writeNames('B', l.b.values());
  if (l.i.size > 0) s += writeNames('I', l.i.values());
  for (const [key, reqs] of [['R', l.r], ['Q', l.q]]) {
    if (reqs.size === 0) continue;
    s += ',"' + key + '":[';
    let i = 0;
    for (const [n, t] of reqs.values()) {
      if (i > 0) s += ',';
      s += '[' + q(n) + ',' + i64s(t) + ']';
      i++;
    }
    s += ']';
  }
  if (l.m.length > 0) {
    s += ',"M":[';
    l.m.forEach((m, i) => {
      if (i > 0) s += ',';
      s += '{"from":' + q(m.from) + ',"t":' + i64s(m.t) + ',"body":' + q(m.body) + ',"subj":' + q(m.subj) + ',"type":' + q(m.kind) + '}';
    });
    s += ']';
  }
  if (l.contact !== null) s += ',"C":' + q(l.contact);
  return s + '}';
}

/** The shelf swept of what nobody will read again: the lists whose claim ended, and lists of before claims of the
 *  names nobody claims.  skip: the lists in memory (left alone).  The number of files that went.  (Rust runs it on a
 *  thread of its own; here it runs where it is called.) */
export function sweep(store, claims, now, skip) {
  let gone = 0;
  for (const name of store.list(SHELF + '/')) {
    // (the files of the shelf's folders: friends/<sub>/<file>.json)
    const parts = name.split('/');
    if (parts.length !== 3 || parts[0] !== SHELF) continue;
    const dot = parts[2].lastIndexOf('.');
    if (dot <= 0 || parts[2].slice(dot + 1) !== 'json') continue;
    const o = parseObj(store.get(name));
    if (o === null) continue;
    const n = str(own(o, 'name'));
    if (n === null || skip.has(lower(n))) continue;
    const owner = str(own(o, 'owner'));
    const dead = owner !== null ? claims.holder(n, now) !== owner : unclaimable(n);
    if (dead) {
      store.delete(name);
      gone += 1;
    }
  }
  return gone;
}

/** every list on the shelf, as written, by name (tests: buddy.rs shelf_texts) */
export function shelfTexts(store) {
  const out = [];
  for (const f of store.list(SHELF + '/')) {
    const text = store.get(f);
    const name = JSON.parse(text).name;
    assert(f === shelfFile(lower(name)), name + "'s file is where its name says");
    out.push([name, text]);
  }
  out.sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1]));
  return out.map((x) => x[1]);
}

/** the same lists read and written again (tests: buddy.rs shelf_reread) */
export function shelfReread(store) {
  return shelfTexts(store).map((t) => listJson(listOfJson(JSON.parse(t))));
}

export class Buddies {
  /** buddy.rs Buddies::with_claims: the store (null: in memory), the claims (null: every list kept for its name), as of
   *  now (ms since 1970); a buddies.json of before in it is moved onto the shelf first */
  constructor({ store = null, limits = BUDDY_LIMITS, claims = null, now = 0 } = {}) {
    this.l = { ...BUDDY_LIMITS, ...limits };
    this.store = store;
    this.saveMs = 10000;
    this.claims = claims;
    /** lower-case persona -> its friends list (the ones in memory), least recently seen first */
    this.lists = new Map();
    /** lower-case persona -> buddy connection; onlineSeq its place in the order (get_placed) */
    this.online = new Map();
    this.onlineSeq = new Map();
    this.onlineNext = 0;
    /** lower-case persona -> the lists that have it as a friend; the connections that met it */
    this.fans = new Map();
    this.metBy = new Map();
    /** lower-case persona -> how many lists block it */
    this.blockers = new Map();
    this.mail = 0;
    this.pageMail = null;
    /** lower-case persona -> {times, until} (msgSlur) */
    this.msgSlurs = new Map();
    this.pruned = -Infinity;
    this.swept = now;
    /** client group -> bucket: new friends lists */
    this.made = new Map();
    this.timer = null;
    this.dirty = new Set();
    this.conns = new Map();
    this.graveyard = [];
    this.next = 0;
    if (this.store !== null) this.moveIn(now);
  }

  /** k online on connection b (a known key keeps its place) */
  onlineSet(k, b) {
    if (!this.online.has(k)) {
      this.onlineSeq.set(k, this.onlineNext);
      this.onlineNext += 1;
    }
    this.online.set(k, b);
  }
  onlineDelete(k) {
    this.onlineSeq.delete(k);
    return this.online.delete(k);
  }
  /** [place, connection] of k online, or null (OrderedMap::get_placed) */
  placed(k) {
    return this.online.has(k) ? [this.onlineSeq.get(k), this.online.get(k)] : null;
  }

  /** buddies.json onto the shelf, then renamed to buddies.json.moved (buddy.rs move_in) */
  moveIn(now) {
    const store = this.store;
    const text = store.get(OLD_FILE);
    if (text === null) return;
    const rows = [];
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = undefined;
    }
    const ps = isObj(j) ? own(j, 'personas') : undefined;
    if (Array.isArray(ps)) {
      for (const o of ps) {
        if (!isObj(o)) continue;
        const l = listOfJson(o);
        if (l === null || isEmpty(l)) continue;
        if (this.claims !== null) {
          const ended = l.owner !== null ? this.claims.holder(l.name, now) !== l.owner : unclaimable(l.name);
          if (ended) continue;
        }
        rows.push(l);
      }
    }
    // (a name twice: the more recently seen list, in the other one's place)
    rows.sort((a, b) => cmpStr(a.seen, b.seen));
    const lists = new Map();
    for (const l of rows) lists.set(lower(l.name), l);
    const asks = [];
    for (const l of lists.values()) for (const [k, [n, t]] of l.r) asks.push([k, n, l.name, t]);
    for (const [k, name, from, t] of asks) {
      let l = lists.get(k);
      if (l === undefined) {
        l = newList(name, monthOf(now));
        l.owner = this.claims !== null ? this.claims.holder(name, now) : null;
        lists.set(k, l);
      }
      if (l.q.size < MAX_ASKED) l.q.set(lower(from), [from, t]);
    }
    for (const [k, l] of lists) {
      if (store.put(shelfFile(k), listJson(l)) !== null) return;
    }
    if (store.put(OLD_FILE + '.moved', text) === null) store.delete(OLD_FILE);
  }

  /** the store's indexes learn of the list of owner, which is in lists */
  index(owner) {
    const l = this.lists.get(owner);
    if (l === undefined) return;
    for (const k of l.b.keys()) this.fanAdd(k, owner);
    for (const k of l.i.keys()) this.blockedMore(k);
    this.mail += l.m.length;
  }

  fanAdd(k, owner) {
    let s = this.fans.get(k);
    if (s === undefined) {
      s = new Set();
      this.fans.set(k, s);
    }
    s.add(owner);
  }

  /** the list of k changed: written at the next save */
  mark(k) {
    if (this.store !== null) this.dirty.add(k);
  }

  /** The list of k in memory, read from the shelf if it is there (true); room made first (pinned(k): never pushed out) */
  fetch(k, now, pinned) {
    if (this.lists.has(k)) return true;
    if (this.store === null) return false;
    const o = shelfRead(this.store, k);
    const l = o === null ? null : listOfJson(o);
    if (l === null || lower(l.name) !== k) return false;
    if (this.claims !== null) {
      if (l.owner !== null) {
        if (this.claims.holder(l.name, Math.trunc(now)) !== l.owner) {
          this.store.delete(shelfFile(k));
          return false;
        }
      } else {
        if (unclaimable(l.name)) this.store.delete(shelfFile(k));
        return false;
      }
    }
    this.makeRoom(pinned);
    this.lists.set(k, l);
    this.index(k);
    if (this.pruneOne(k, now)) this.mark(k);
    return true;
  }

  /** k's list of before claims (no owner) from the shelf, or null */
  dormant(k) {
    if (this.store === null) return null;
    const o = shelfRead(this.store, k);
    const l = o === null ? null : listOfJson(o);
    return l !== null && l.owner === null && lower(l.name) === k ? l : null;
  }

  /** room for one more list in memory */
  makeRoom(pinned) {
    const most = this.lists.size;
    for (let n = 0; this.lists.size >= this.l.lists; n++) {
      assert(n <= most, 'makeRoom ends');
      let old = null;
      for (const k of this.lists.keys()) {
        if (!pinned(k) && !this.online.has(k)) {
          old = k;
          break;
        }
      }
      if (old === null) return;
      if (this.dirty.delete(old)) this.writeOne(old);
      this.takeList(old);
    }
  }

  /** k's list onto the shelf as it is now: null, or the error */
  writeOne(k) {
    if (this.store === null) return null;
    const l = this.lists.get(k);
    if (l === undefined || l.temp) return null;
    if (isEmpty(l)) {
      this.store.delete(shelfFile(k));
      return null;
    }
    return this.store.put(shelfFile(k), listJson(l));
  }

  /** the lists that changed, onto the shelf: the first error, if any (written again next time) */
  writeDirty() {
    let err = null;
    const ks = [...this.dirty];
    this.dirty = new Set();
    for (const k of ks) {
      const e = this.writeOne(k);
      if (e !== null) {
        this.dirty.add(k);
        if (err === null) err = e;
      }
    }
    return err;
  }

  /** a list into the store, at the most recently seen end */
  putList(k, l) {
    this.takeList(k);
    this.lists.set(k, l);
    this.index(k);
    this.mark(k);
  }

  /** the persona old's list (lower case) is name's now (buddy.rs move_list) */
  moveList(old, name) {
    const l = this.takeList(old);
    if (l === null) return;
    if (this.store !== null) this.store.delete(shelfFile(old));
    this.dirty.delete(old);
    const k = lower(name);
    l.name = name;
    const sent = [...l.r.keys()], got = [...l.q.keys()];
    const cur = this.takeList(k);
    if (cur !== null) {
      for (const [x, n] of cur.b) l.b.set(x, n);
      for (const [x, n] of cur.i) l.i.set(x, n);
      // (a request both had: the later)
      for (const [m, theirs] of [[l.r, cur.r], [l.q, cur.q]]) {
        for (const [x, [n, t]] of theirs) {
          const was = m.get(x);
          if (was === undefined || was[1] < t) m.set(x, [n, t]);
        }
      }
      l.m.push(...cur.m);
      l.contact = cur.contact !== null ? cur.contact : l.contact;
      l.seen = cur.seen;
    }
    for (const x of [old, k]) {
      l.b.delete(x);
      l.i.delete(x);
      l.r.delete(x);
      l.q.delete(x);
    }
    const unfriended = [...l.b.keys()].slice(MAX_FRIENDS);
    truncate(l.b, MAX_FRIENDS);
    truncate(l.i, MAX_LIST);
    const newest = (m) => {
      if (m.size <= MAX_ASKED) return [];
      const e = [...m].sort((a, b) => totalCmp(b[1][1], a[1][1]));
      m.clear();
      for (const [x, v] of e) m.set(x, v);
      const cut = e.slice(MAX_ASKED).map((x) => x[0]);
      truncate(m, MAX_ASKED);
      return cut;
    };
    const unasked = [newest(l.r), newest(l.q)];
    if (l.m.length > MAX_MAIL) {
      l.m.sort((a, b) => totalCmp(a.t, b.t));
      l.m.splice(0, l.m.length - MAX_MAIL);
    }
    this.putList(k, l);
    const rename = (m) => {
      const e = m.get(old);
      if (e === undefined) return false;
      m.delete(old);
      m.set(k, [name, e[1]]);
      return true;
    };
    const changed = [];
    for (const [who, theirsQ] of [...sent.map((w) => [w, true]), ...got.map((w) => [w, false])]) {
      const wl = this.lists.get(who);
      if (wl !== undefined && rename(theirsQ ? wl.q : wl.r)) changed.push(who);
    }
    const fans = this.fans.get(old);
    if (fans !== undefined) {
      this.fans.delete(old);
      for (const f of fans) {
        const fl = this.lists.get(f);
        if (fl !== undefined && fl.b.delete(old)) {
          fl.b.set(k, name);
          changed.push(f);
        }
      }
      for (const f of fans) this.fanAdd(k, f);
    }
    // what did not fit, off the other side too
    for (const x of unfriended) if (this.removeFriend(x, k)) changed.push(x);
    for (const [cut, theirsQ] of [[unasked[0], true], [unasked[1], false]]) {
      for (const x of cut) {
        const wl = this.lists.get(x);
        if (wl !== undefined && (theirsQ ? wl.q : wl.r).delete(k)) changed.push(x);
      }
    }
    for (const f of changed) this.mark(f);
  }

  /** a list out of memory (and the indexes): not off the shelf.  The list, or null */
  takeList(owner) {
    const l = this.lists.get(owner);
    if (l === undefined) return null;
    for (const k of [...l.b.keys()]) this.unfan(k, owner);
    for (const k of [...l.i.keys()]) this.blockedLess(k);
    this.mail -= l.m.length;
    this.lists.delete(owner);
    return l;
  }

  /** a friend on owner's list (false: it has none) */
  addFriend(owner, k, name) {
    const l = this.lists.get(owner);
    if (l === undefined) return false;
    l.b.set(k, name);
    this.fanAdd(k, owner);
    this.mark(owner);
    return true;
  }

  /** a friend off owner's list (false: it was not on it) */
  removeFriend(owner, k) {
    const l = this.lists.get(owner);
    if (l === undefined || !l.b.delete(k)) return false;
    this.unfan(k, owner);
    this.mark(owner);
    return true;
  }

  /** k on owner's blocked list (false: it has no list, or k was on it: its name as given then, as IndexMap::insert) */
  blockAdd(owner, k, name) {
    const l = this.lists.get(owner);
    if (l === undefined) return false;
    const had = l.i.has(k);
    l.i.set(k, name);
    if (had) return false;
    this.blockedMore(k);
    this.mark(owner);
    return true;
  }

  /** k off owner's blocked list (false: it was not on it) */
  blockRemove(owner, k) {
    const l = this.lists.get(owner);
    if (l === undefined || !l.i.delete(k)) return false;
    this.blockedLess(k);
    this.mark(owner);
    return true;
  }

  /** owner (lower case) blocks k */
  blocks(owner, k) {
    const l = this.lists.get(owner);
    return l !== undefined && l.i.has(k);
  }

  /** some list blocks k (lower case) */
  blocked(k) {
    return this.blockers.has(k);
  }

  blockedMore(k) {
    this.blockers.set(k, (this.blockers.get(k) || 0) + 1);
  }
  blockedLess(k) {
    const n = this.blockers.get(k);
    if (n === undefined) return;
    if (n - 1 === 0) this.blockers.delete(k);
    else this.blockers.set(k, n - 1);
  }

  /** from's friend request to to while it waits: the asker's name, or null */
  request(from, to, now) {
    let name, t;
    const tl = this.lists.get(to);
    if (tl !== undefined) {
      const e = tl.q.get(from);
      if (e === undefined) return null;
      [name, t] = e;
    } else {
      const fl = this.lists.get(from);
      if (fl === undefined) return null;
      const e = fl.r.get(to);
      if (e === undefined) return null;
      name = fl.name;
      t = e[1];
    }
    return now - t < ASK_DAYS * DAY_MS ? name : null;
  }

  /** from's request to to, on from's list (which is there) and on to's (when in memory) */
  ask(from, to, name, t) {
    const l = this.lists.get(from);
    if (l === undefined) return;
    l.r.set(to, [name, t]);
    const fromName = l.name;
    this.mark(from);
    const tl = this.lists.get(to);
    if (tl !== undefined) {
      tl.q.set(from, [fromName, t]);
      if (tl.q.size > MAX_ASKED) tl.q.delete(tl.q.keys().next().value);
      this.mark(to);
    }
  }

  /** from's request to to goes, from both lists (false: there was none) */
  unask(from, to) {
    const fl = this.lists.get(from), tl = this.lists.get(to);
    const sent = fl !== undefined && fl.r.delete(to);
    const got = tl !== undefined && tl.q.delete(from);
    if (sent) this.mark(from);
    if (got) this.mark(to);
    return sent || got;
  }

  /** a list goes, from memory and the shelf */
  dropList(owner) {
    this.takeList(owner);
    this.dirty.delete(owner);
    if (this.store !== null) this.store.delete(shelfFile(owner));
  }

  /** the session lists whose persona is not online go: true when any did */
  dropTemp() {
    const gone = [];
    for (const [k, l] of this.lists) if (l.temp && !this.online.has(k)) gone.push(k);
    for (const k of gone) {
      this.takeList(k);
      this.dirty.delete(k);
    }
    return gone.length > 0;
  }

  unfan(k, owner) {
    const s = this.fans.get(k);
    if (s === undefined) return;
    s.delete(owner);
    if (s.size === 0) this.fans.delete(k);
  }

  /** the requests and messages that waited too long go, from the lists in memory (false: none did) */
  prune(now) {
    let any = false;
    for (const k of [...this.lists.keys()]) {
      if (this.pruneOne(k, now)) {
        this.mark(k);
        any = true;
      }
    }
    return any;
  }

  /** k's requests (both ways) and messages that waited too long go (false: none did) */
  pruneOne(k, now) {
    const l = this.lists.get(k);
    if (l === undefined) return false;
    const r = l.r.size, qn = l.q.size, m = l.m.length;
    for (const map of [l.r, l.q]) {
      for (const [x, [, t]] of [...map]) if (!(now - t < ASK_DAYS * DAY_MS)) map.delete(x);
    }
    l.m = l.m.filter((x) => now - x.t < MAIL_DAYS * DAY_MS);
    const mail = m - l.m.length;
    this.mail -= mail;
    return r !== l.r.size || qn !== l.q.size || mail > 0;
  }

  /** k's list (in memory) when it names me back and is its name's claimer's, or null */
  namesBack(k, me, now) {
    const f = this.lists.get(k);
    if (f === undefined || !f.b.has(me) || f.temp) return null;
    if (this.claims !== null) {
      return f.owner !== null && f.owner === this.claims.holder(f.name, Math.trunc(now)) ? f : null;
    }
    return f;
  }

  /** a persona's friends list, or null */
  list(name) {
    const l = this.lists.get(lower(name));
    return l === undefined ? null : l;
  }

  purge() {
    const ids = this.graveyard;
    this.graveyard = [];
    for (const id of ids) {
      const x = this.conns.get(id);
      if (x === undefined) continue;
      this.conns.delete(id);
      for (const k of x.met) {
        const s = this.metBy.get(k);
        if (s !== undefined) {
          s.delete(id);
          if (s.size === 0) this.metBy.delete(k);
        }
      }
    }
  }
}

/** a persona's presence as its friends see it */
function presence(b) {
  return [['USER', b.persona], ['SHOW', b.show], ['STAT', b.stat], ['PROD', b.prod], ['TITL', TITL], ['EXTR', 'NFS-CONSOLE-2005'], ['ATTR', 'D']];
}

/** the presence of a persona that is not online */
function offline(name) {
  return [['USER', name], ['SHOW', 'DISC'], ['STAT', ''], ['PROD', ''], ['TITL', TITL], ['EXTR', 'NFS-CONSOLE-2005'], ['ATTR', 'D']];
}

/** encodeFrame, its error a handler's (BuddyError) */
function frameOf(kind, code, fields) {
  try {
    return encodeFrame(kind, code, fields);
  } catch (e) {
    throw new BuddyError(e && e.message !== undefined ? e.message : String(e));
  }
}

const tr = (now) => Math.trunc(now);

export const buddyMethods = {
  /** the connection's words to the game (throws BuddyError: a field name that is not one) */
  bsend(b, kind, fields, code) {
    const f = frameOf(kind, code, fields);
    const x = this.buddies.conns.get(b);
    if (x !== undefined) this.connWrite(x.conn, f);
  },

  /** a message encoded once, to one more connection */
  bsendFrame(b, frame) {
    const x = this.buddies.conns.get(b);
    if (x !== undefined) this.connWrite(x.conn, frame);
  },

  bnow() {
    return this.clocks.now();
  },

  /** the presence of persona name (lower case k): its connection's, or offline */
  presenceOf(k, name) {
    const o = this.buddies.online.get(k);
    const x = o === undefined ? undefined : this.buddies.conns.get(o);
    return x !== undefined ? presence(x) : offline(name);
  },

  buddyConnect(c) {
    const ids = this.connIds(c);
    if (ids === null) return;
    const [vip, , group] = ids;
    const now = this.bnow();
    const l = this.buddies.l;
    this.buddies.next += 1;
    const id = this.buddies.next;
    const t = this.setTimeout(60000, { k: 'BuddyLogin', b: id });
    this.buddies.conns.set(id, {
      conn: c, vip, group, persona: null, key: '', show: 'CHAT', stat: '', prod: '', msgsT: now, msgsV: 5,
      met: new Set(), told: null, presenceTimer: null, mailTimer: null,
      rate: Bucket.withBurstAt(l.msgRate, 3 * l.msgRate, now), heavy: Bucket.withBurstAt(l.heavyRate, 4, now),
      tries: 0, reader: new FrameReader(), loginTimer: t,
    });
    this.setSvc(c, { k: 'buddy', id });
  },

  /** the 60 s for a login are over */
  buddyLoginIdle(b) {
    const x = this.buddies.conns.get(b);
    if (x !== undefined) this.connDestroy(x.conn, 'buddy: no login');
  },

  /** the connection closed: its login timer ends, it is gone */
  buddyClosed(b) {
    const x = this.buddies.conns.get(b);
    if (x !== undefined && x.loginTimer !== null) {
      const t = x.loginTimer;
      x.loginTimer = null;
      this.timers.clear(t);
    }
    this.buddyGone(b);
    this.buddies.graveyard.push(b);
  },

  buddyData(b, buf) {
    const x = this.buddies.conns.get(b);
    if (x === undefined) return;
    const msgs = x.reader.push(buf);
    const conn = x.conn;
    for (const m of msgs) {
      if (!this.connOpen(conn)) return;
      const now = this.bnow();
      const y = this.buddies.conns.get(b);
      if (!(y !== undefined && y.rate.takeAt(now, 1))) return this.connDestroy(conn, 'buddy: too many messages');
      if (!fourPrintable(m.kind)) return this.connDestroy(conn, 'buddy: not the lobby protocol');
      const f = FieldMap.parse(m.body);
      try {
        this.buddyMessage(b, m.kind, f);
      } catch (e) {
        if (!(e instanceof BuddyError)) throw e;
        // the error as "<name>: <message>" (a TypeError names itself, the others are an Error)
        const t = e.message.startsWith('TypeError') ? e.message : 'Error: ' + e.message;
        this.consoleError('[online] buddy "' + m.kind + '" failed: ' + t);
        return this.connDestroy(conn, 'server error');
      }
    }
    const z = this.buddies.conns.get(b);
    if (z !== undefined && z.reader.error !== null) this.connDestroy(conn, 'buddy: not the lobby protocol');
  },

  /** the connection's persona goes offline: its timers dropped, off online, its friends told */
  buddyGone(b) {
    const bs = this.buddies;
    const x = bs.conns.get(b);
    if (x === undefined) return;
    for (const t of [x.presenceTimer, x.mailTimer]) if (t !== null) this.timers.clear(t);
    x.presenceTimer = null;
    x.mailTimer = null;
    if (x.persona === null) return;
    const keys = [];
    for (const [k, o] of bs.online) if (o === b) keys.push(k);
    for (const k of keys) bs.onlineDelete(k);
    if (keys.length > 0) quiet(() => this.buddyAnnounce(b, true));
    const y = bs.conns.get(b);
    if (y !== undefined) {
      y.persona = null;
      y.key = '';
    }
    // (a name nobody claimed: its session's lists go with it)
    bs.dropTemp();
  },

  touchLists() {
    const bs = this.buddies;
    if (bs.store === null || bs.timer !== null) return;
    bs.timer = this.setTimeout(bs.saveMs, { k: 'BuddySave' });
  },

  /** the friends lists' save timer fired */
  buddySaveTimer() {
    this.buddies.timer = null;
    this.buddySave();
  },

  /** the lists that changed onto the shelf */
  buddySave() {
    const bs = this.buddies;
    if (bs.store === null) return;
    const now = this.bnow();
    if (now - bs.pruned >= 3600000) {
      bs.pruned = now;
      bs.prune(now);
    }
    bs.dropTemp();
    const e = bs.writeDirty();
    if (e !== null) {
      this.log('[online] the friends lists could not be written: ' + e, null);
      this.touchLists();
    }
  },

  buddyStop() {
    const bs = this.buddies;
    if (bs.timer !== null) {
      this.timers.clear(bs.timer);
      bs.timer = null;
    }
    this.buddySave();
  },

  /** once an hour (the lobby's tick): the shelf swept of the lists of claims that ended (here at once) */
  buddyTick() {
    const bs = this.buddies;
    const now = this.bnow();
    if (bs.store === null || bs.claims === null) return;
    if (now - bs.swept < SWEEP_MS) return;
    bs.swept = now;
    const skip = new Set(bs.lists.keys());
    const gone = sweep(bs.store, bs.claims, tr(now), skip);
    if (gone > 0) this.log('[online] ' + gone + ' friends list(s) of claims that ended went from the shelf', null);
  },

  /** k's list in memory when the shelf has it: room made without pushing out a persona's in the lobby */
  buddyFetch(k) {
    const now = this.bnow();
    const lobby = this.lobby.byPersona;
    return this.buddies.fetch(k, now, (x) => lobby.has(x));
  },

  /** k's list in memory as buddyFetch has it, and whether it names me back; me's own kept in memory meanwhile */
  fetchBack(me, k) {
    const now = this.bnow();
    const lobby = this.lobby.byPersona;
    this.buddies.fetch(k, now, (x) => x === me || lobby.has(x));
    return this.buddies.namesBack(k, me, now) !== null;
  },

  /** a persona's friends list, made if needed (on behalf of client group): false when that client made its share */
  makeList(name, group) {
    const k = lower(name);
    if (this.buddyFetch(k)) return true;
    const now = this.bnow();
    const bs = this.buddies;
    const l = bs.l;
    if (!bs.made.has(group)) {
      if (bs.made.size >= 10000) {
        for (const [g, x] of [...bs.made]) if (x.hasAt(now, 0) && x.v >= x.cap) bs.made.delete(g);
      }
      bs.made.set(group, Bucket.withBurstAt(l.listRate / 3600, l.listRate, now));
    }
    if (!bs.made.get(group).takeAt(now, 1)) return false;
    this.newList(name, now);
    return true;
  },

  /** a new, empty list for name (room made for it) */
  newList(name, now) {
    const bs = this.buddies;
    const lobby = this.lobby.byPersona;
    bs.makeRoom((x) => lobby.has(x));
    const list = newList(name, monthOf(now));
    if (bs.claims !== null) {
      list.owner = bs.claims.holder(name, tr(now));
      list.temp = list.owner === null;
    }
    const k = lower(name);
    // (OrderedMap::insert: a known key keeps its place)
    bs.lists.set(k, list);
  },

  /** the list a request to name waits on, made for a claimed name (false: none) */
  askedList(name) {
    const k = lower(name);
    if (this.buddyFetch(k)) return true;
    const now = this.bnow();
    const bs = this.buddies;
    if (bs.claims !== null && bs.claims.holder(name, tr(now)) === null) return false;
    this.newList(name, now);
    return true;
  },

  /** the lists of the persona b logs in as, by the claims (buddy.rs lists_at_login) */
  listsAtLogin(persona, owner) {
    const bs = this.buddies;
    const k = lower(persona);
    this.buddyFetch(k);
    const c = bs.claims;
    if (c === null) return;
    const now = tr(this.bnow());
    const holder = c.holder(persona, now);
    const mine = holder !== null && holder === owner;
    const l0 = bs.lists.get(k);
    const temp = l0 !== undefined ? l0.temp : false;
    const of = l0 !== undefined ? l0.owner : null;
    if (l0 !== undefined) {
      if (mine && (temp || of === null)) {
        l0.temp = false;
        l0.owner = owner;
        bs.mark(k);
        this.touchLists();
      } else if ((mine && of !== owner) || (!mine && !temp)) {
        bs.dropList(k);
        this.touchLists();
      }
    }
    if (!(owner !== null && mine)) return;
    const o = owner;
    if (!bs.lists.has(k)) {
      const l = bs.dormant(k);
      if (l !== null) {
        l.owner = o;
        l.name = persona;
        const lobby = this.lobby.byPersona;
        bs.makeRoom((x) => lobby.has(x));
        bs.putList(k, l);
        this.touchLists();
      }
    }
    this.listsFromBefore(persona, o);
  },

  /** the lists of the name keyphrase owner had before its last change move to its current name persona */
  listsFromBefore(persona, owner) {
    const bs = this.buddies;
    const c = bs.claims;
    if (c === null) return;
    const k = lower(persona);
    const old = c.previous(owner, tr(this.bnow()));
    if (old === null || old === undefined || old === k) return;
    if (!this.ownList(old, owner) || !bs.lists.has(old) || !this.ownList(k, owner)) return;
    const others = [];
    for (const n of [old, k]) {
      const l = bs.lists.get(n);
      if (l === undefined) continue;
      others.push(...l.b.keys(), ...l.r.keys(), ...l.q.keys());
    }
    for (const o of others) this.buddyFetch(o);
    bs.moveList(old, persona);
    this.log('[online] "' + persona + '": EA Messenger lists moved from "' + old + '" (a name change)', null);
    const e = bs.writeDirty();
    if (e !== null) this.log('[online] the friends lists could not be written: ' + e, null);
    this.touchLists();
  },

  /** k's list, if any, is keyphrase owner's from now on (false: a session's own list, left alone) */
  ownList(k, owner) {
    const bs = this.buddies;
    if (!this.buddyFetch(k)) {
      const d = bs.dormant(k);
      if (d !== null) {
        d.owner = owner;
        const lobby = this.lobby.byPersona;
        bs.makeRoom((x) => lobby.has(x));
        bs.putList(k, d);
        this.touchLists();
        return true;
      }
    }
    const l = bs.lists.get(k);
    if (l === undefined) return true;
    if (l.temp) return false;
    if (l.owner === owner) return true;
    if (l.owner !== null) {
      bs.dropList(k);
      this.touchLists();
      return true;
    }
    l.owner = owner;
    bs.mark(k);
    this.touchLists();
    return true;
  },

  /** a persona was seen: its list moves to the most recently seen end */
  seenList(name) {
    const bs = this.buddies;
    const k = lower(name);
    const l = bs.lists.get(k);
    if (l === undefined) return;
    bs.lists.delete(k);
    bs.lists.set(k, l);
    const m = monthOf(this.bnow());
    if (l.seen !== m) {
      l.seen = m;
      bs.mark(k);
      this.touchLists();
    }
  },

  /** every online persona that has b as a friend (or met it) gets its presence now */
  buddyAnnounce(b, gone) {
    const bs = this.buddies;
    const x = bs.conns.get(b);
    assert(x !== undefined, 'buddyAnnounce of a held connection');
    const p = x.persona;
    if (p === null) throw nullPersona();
    const me = lower(p);
    const what = gone ? offline(p) : presence(x);
    x.told = this.bnow();
    const frame = frameOf('PGET', '', what);
    const hear = [];
    const fans = bs.fans.get(me);
    if (fans !== undefined) {
      for (const owner of fans) {
        const pl = bs.placed(owner);
        if (pl !== null) hear.push(pl);
      }
    }
    const met = bs.metBy.get(me);
    if (met !== undefined) {
      for (const o of met) {
        const ox = bs.conns.get(o);
        if (ox === undefined || ox.persona === null) continue;
        const pl = bs.placed(ox.key);
        if (pl !== null && pl[1] === o) hear.push([pl[0], o]);
      }
    }
    hear.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
    for (let i = 0; i < hear.length; i++) {
      if (i > 0 && hear[i][0] === hear[i - 1][0] && hear[i][1] === hear[i - 1][1]) continue;
      const o = hear[i][1];
      const ox = bs.conns.get(o);
      if (o !== b && ox !== undefined && ox.persona !== null) this.bsendFrame(o, frame);
    }
  },

  /** b's presence changed: out now, or the latest of it once presenceMs has passed since the last */
  presenceChanged(b) {
    const x = this.buddies.conns.get(b);
    if (x.presenceTimer !== null) return;
    const wait = (x.told === null ? -Infinity : x.told) + this.buddies.l.presenceMs - this.bnow();
    if (wait <= 0) return this.buddyAnnounce(b, false);
    x.presenceTimer = this.setTimeout(wait, { k: 'Presence', b });
  },

  /** a held-back presence goes out */
  presenceTimer(b) {
    const x = this.buddies.conns.get(b);
    if (x === undefined) return;
    x.presenceTimer = null;
    if (x.persona !== null) quiet(() => this.buddyAnnounce(b, false));
  },

  /** the messages that waited for the connection's persona go to it */
  buddyMailTimer(b) {
    const x = this.buddies.conns.get(b);
    if (x === undefined) return;
    x.mailTimer = null;
    const conn = x.conn, me = x.persona !== null ? x.key : null;
    if (me !== null && this.connOpen(conn)) quiet(() => this.deliverMail(b, me));
  },

  /** b and the persona who become friends, both told */
  befriend(b, who, how) {
    const x = this.buddies.conns.get(b);
    const bp = x.persona;
    if (bp === null) throw nullPersona();
    this.befriendAs(bp, x.group, who, how);
  },

  /** persona bp (on behalf of client group) and who become friends (false: a list is full, or the client made its
   *  share of new lists); throws BuddyError as Rust's Err */
  befriendAs(bp, group, who, how) {
    const bs = this.buddies;
    const k = lower(who), me = lower(bp);
    this.buddyFetch(k);
    const u1 = bs.unask(k, me);
    const u2 = bs.unask(me, k);
    if (u1 || u2) this.touchLists();
    const fullWithout = (l, n) => l !== null && l.b.size >= MAX_FRIENDS && !l.b.has(n);
    if (fullWithout(bs.list(bp), k) || fullWithout(bs.list(who), me)) return false;
    const mine = this.makeList(bp, group);
    const them = mine && this.makeList(who, group);
    if (!mine || !them) return false;
    bs.addFriend(me, lower(who), who);
    bs.addFriend(k, lower(bp), bp);
    this.touchLists();
    this.log('[online] "' + bp + '" and "' + who + '" are friends (' + how + ')', group);
    const b1 = bs.online.get(me), o = bs.online.get(k);
    if (b1 !== undefined) {
      this.bsend(b1, 'RNOT', [['USER', who], ['CHNG', 'A'], ['ATTR', 0]], '');
      this.bsend(b1, 'PGET', this.presenceOf(k, who), '');
    }
    if (o !== undefined) {
      this.bsend(o, 'RNOT', [['USER', bp], ['CHNG', 'A'], ['ATTR', 0]], '');
      this.bsend(o, 'PGET', this.presenceOf(me, bp), '');
    }
    return true;
  },

  /** What a page asks of its persona's lists: owner is its keyphrase, whose claimed name is the persona; group its
   *  client.  ask: {k:'List'}|{k:'ListMail'}|{k:'Send', name, body}|{k:'Ask', name}|{k:'AskByName', name}|
   *  {k:'Answer', name, yes}|{k:'Remove', name}|{k:'Block', name}|{k:'Discord', typed} */
  friends(owner, group, ask) {
    const bs = this.buddies;
    const now = this.bnow();
    const mineC = bs.claims !== null ? bs.claims.mine(owner, tr(now)) : null;
    if (mineC === null || mineC === undefined) return { me: null, done: 'claim', friends: [], asks: [], sent: [], mail: [], contact: null };
    const me = mineC.name;
    const mk = lower(me);
    this.ownList(mk, owner);
    this.listsFromBefore(me, owner);
    let mail = [];
    let done;
    switch (ask.k) {
      case 'List':
        done = 'ok';
        break;
      case 'ListMail':
        mail = this.takePageMail(mk);
        done = 'ok';
        break;
      case 'Send':
        done = this.pageSend(me, group, ask.name, ask.body);
        break;
      case 'Ask':
        done = this.pageAsk(me, group, ask.name, 'free roam');
        break;
      case 'AskByName':
        done = this.pageAsk(me, group, ask.name, 'the start page');
        break;
      case 'Answer':
        done = this.pageAnswer(me, group, ask.name, ask.yes);
        break;
      case 'Remove': {
        const k = lower(ask.name);
        this.buddyFetch(k);
        const l = bs.list(me);
        const was = l !== null && (l.b.has(k) || l.r.has(k));
        quiet(() => this.unfriend(me, ask.name));
        done = was ? 'ok' : 'none';
        break;
      }
      case 'Block':
        if (validName(ask.name) && lower(ask.name) !== mk) {
          quiet(() => this.unfriend(me, ask.name));
          done = this.block(me, group, ask.name) ? 'ok' : 'full';
        } else done = 'name';
        break;
      case 'Discord':
        done = this.setDiscord(me, group, ask.typed);
        break;
      default:
        assert(false, 'a friends ask ' + ask.k);
    }
    // (each friend's list in memory, for whether it names this persona back)
    const l0 = bs.lists.get(mk);
    const keys = l0 !== undefined ? [...l0.b.keys()] : [];
    for (const k of keys) this.fetchBack(mk, k);
    const l = bs.lists.get(mk);
    const waits = (t) => now - t < ASK_DAYS * DAY_MS;
    const friends = [];
    if (l !== undefined) {
      for (const [k, n] of l.b) {
        const back = bs.namesBack(k, mk, now);
        const mutual = back !== null;
        friends.push({
          name: n, mutual, online: mutual && (bs.online.has(k) || this.lobby.byPersona.has(k)),
          contact: back !== null ? back.contact : null,
        });
      }
    }
    const notFriend = (k) => !(l !== undefined && l.b.has(k));
    const asks = [], sent = [];
    if (l !== undefined) {
      for (const [k, [n, t]] of l.q) if (waits(t) && notFriend(k) && !bs.blocks(mk, k)) asks.push(n);
      for (const [k, [n, t]] of l.r) if (waits(t) && notFriend(k)) sent.push(n);
    }
    const contact = l !== undefined ? l.contact : null;
    return { me, done, friends, asks, sent, mail, contact };
  },

  /** persona me's Discord username from now on: what it typed, "" none (the log says that it changed, never what) */
  setDiscord(me, group, typed) {
    const bs = this.buddies;
    let to;
    if (rustTrim(typed) === '') to = null;
    else {
      const d = discordName(typed);
      if (d === null || blockedName(d)) return 'name';
      to = d;
    }
    const k = lower(me);
    const lm = bs.list(me);
    const had = lm !== null ? lm.contact : null;
    if (had === to) return 'ok';
    if (!this.makeList(me, group)) return 'full';
    const l = bs.lists.get(k);
    if (l === undefined) return 'full';
    l.contact = to;
    bs.mark(k);
    this.touchLists();
    const what = to !== null ? 'set a Discord name' : 'took its Discord name away';
    this.log('[online] "' + me + '" ' + what, group);
    return 'ok';
  },

  /** the page of persona me asks name to be friends (via: 'free roam' or 'the start page') */
  pageAsk(me, group, name, via) {
    const bs = this.buddies;
    const mk = lower(me), k = lower(name);
    if (!validName(name)) return 'name';
    if (k === mk) return 'self';
    const now = this.bnow();
    if (bs.claims !== null && bs.claims.holder(name, tr(now)) === null) return 'claim';
    const back = this.fetchBack(mk, k);
    const l = bs.list(me);
    const friends = l !== null && l.b.has(k) && back;
    const full = l !== null && l.b.size >= MAX_FRIENDS && !l.b.has(k);
    const askedFull = l !== null && l.r.size >= MAX_ASKED && !l.r.has(k);
    if (friends) return 'friends';
    // two requests that cross make friends
    const asker = bs.request(k, mk, now);
    if (asker !== null) {
      const how = via === 'free roam' ? 'asked back in free roam' : 'asked back on the start page';
      try {
        return this.befriendAs(me, group, asker, how) ? 'friends' : 'full';
      } catch (e) {
        if (e instanceof BuddyError) return 'full';
        throw e;
      }
    }
    if (full || askedFull || !this.makeList(me, group)) return 'full';
    if (bs.blockRemove(mk, k)) this.touchLists();
    if (bs.blocks(k, mk)) return 'asked';
    this.askedList(name);
    bs.ask(mk, k, name, Math.floor(now));
    this.touchLists();
    this.log('[online] "' + me + '" asked "' + name + '" to be friends (' + via + ')', group);
    const o = bs.online.get(k);
    if (o !== undefined) {
      quiet(() => this.bsend(o, 'RNOT', [['USER', me], ['CHNG', 'A'], ['ATTR', ASKED_ME]], ''));
      const p = this.presenceOf(mk, me);
      quiet(() => this.bsend(o, 'PGET', p, ''));
    }
    return 'asked';
  },

  /** the page of persona me answers name's request */
  pageAnswer(me, group, name, yes) {
    const bs = this.buddies;
    const mk = lower(me), k = lower(name);
    const now = this.bnow();
    this.buddyFetch(k);
    const asker = bs.request(k, mk, now);
    if (asker === null) return 'none';
    if (bs.unask(k, mk)) this.touchLists();
    if (yes) {
      try {
        return this.befriendAs(me, group, asker, 'accepted on the page') ? 'friends' : 'full';
      } catch (e) {
        if (e instanceof BuddyError) return 'full';
        throw e;
      }
    }
    this.log('[online] "' + me + '" declined "' + asker + '"\'s friend request', group);
    const o = bs.online.get(k);
    if (o !== undefined) quiet(() => this.bsend(o, 'RNOT', [['USER', me], ['CHNG', 'D']], ''));
    return 'ok';
  },

  /** persona meName and who are friends no more, and me's request to who taken back: who told when that changed */
  unfriend(meName, who) {
    const bs = this.buddies;
    const me = lower(meName), k = lower(who);
    this.buddyFetch(k);
    const a = bs.removeFriend(me, k);
    const b = bs.removeFriend(k, me);
    const c = bs.unask(me, k);
    if (!(a || b || c)) return;
    this.touchLists();
    const o = bs.online.get(k);
    if (o !== undefined) this.bsend(o, 'RNOT', [['USER', meName], ['CHNG', 'D']], '');
  },

  /** who on me's blocked list, its request to me gone; false: no room */
  block(meName, group, who) {
    const bs = this.buddies;
    const me = lower(meName), k = lower(who);
    this.buddyFetch(me);
    const l = bs.list(meName);
    if ((l !== null && l.i.size >= MAX_LIST && !l.i.has(k)) || !this.makeList(meName, group)) return false;
    bs.blockAdd(me, k, who);
    this.buddyFetch(k);
    bs.unask(k, me);
    this.touchLists();
    return true;
  },

  /** a message to persona k that is away: a friend's pages take it first, else it waits */
  keepMail(k, from, f, t) {
    const body = cleanText(f.str('BODY'), 500);
    if (this.pageMailTo(k, { from, body, t: Math.floor(t) })) return;
    const subj = cleanText(f.str('SUBJ'), 64);
    const g = f.get('TYPE');
    const kind = slice16(g === null ? 'C' : g, 4);
    this.keep(k, { from, body, subj, kind, t: Math.floor(t) });
  },

  /** keepMail's store: false when it is not kept */
  keep(k, m) {
    const bs = this.buddies;
    const me = lower(m.from);
    this.buddyFetch(k);
    if (bs.mail >= ALL_MAIL || bs.blocks(k, me)) return false;
    bs.mark(k);
    const l = bs.lists.get(k);
    if (l === undefined || !l.b.has(me)) return false;
    l.m.push(m);
    bs.mail += 1;
    if (l.m.length > MAX_MAIL) {
      l.m.shift();
      bs.mail -= 1;
    }
    this.touchLists();
    return true;
  },

  /** a friend's message to k's pages (setPageMail's hook): true when a page took it */
  pageMailTo(k, m) {
    const bs = this.buddies;
    const me = lower(m.from);
    this.buddyFetch(k);
    const l = bs.lists.get(k);
    if (l === undefined || !l.b.has(me)) return false;
    const name = l.name;
    if (bs.blocks(k, me)) return false;
    return bs.pageMail !== null && !!bs.pageMail(name, m);
  },

  /** where a friend's messages go when its persona is not in the Messenger: fn(name, {from, body, t}) -> bool */
  setPageMail(fn) {
    this.buddies.pageMail = fn;
  },

  /** the messages that waited for persona me, for its page, gone from the store */
  takePageMail(me) {
    const bs = this.buddies;
    const l = bs.lists.get(me);
    if (l === undefined || l.m.length === 0) return [];
    const mail = l.m;
    l.m = [];
    bs.mail -= mail.length;
    bs.mark(me);
    this.touchLists();
    const now = this.bnow();
    return mail
      .filter((m) => now - m.t < MAIL_DAYS * DAY_MS && !bs.blocks(me, lower(m.from)))
      .map((m) => ({ from: m.from, body: m.body, t: m.t }));
  },

  /** a friend's message of persona mk that reads as a slur: reaches no one, the log says so (true) */
  msgSlur(mk, who, body, group) {
    const word = chatSlur(body);
    if (word === null || word === undefined) return false;
    const now = this.bnow(), l = this.lobby.l;
    let rec = this.buddies.msgSlurs.get(mk);
    if (rec === undefined) {
      rec = { times: [], until: 0 };
      this.buddies.msgSlurs.set(mk, rec);
    }
    const muted = slurSaid(l, rec, now);
    const off = String(l.slurMuteMs / 1000);
    const then = muted ? '; messages off for ' + off + ' s' : '';
    this.log('[online] "' + who + '": a message with ' + JSON.stringify(word) + ' in it, sent to no one' + then, group === undefined ? null : group);
    return true;
  },

  /** persona mk's messages are off now */
  msgMuted(mk) {
    const now = this.bnow();
    const x = this.buddies.msgSlurs.get(mk);
    if (x === undefined) return false;
    if (x.until > now) return true;
    if (x.times.every((t) => now - t >= this.lobby.l.slurWindowMs)) this.buddies.msgSlurs.delete(mk);
    return false;
  },

  /** the page of persona me sends its friend name a message: "sent", "kept", "none", "empty", "off", "full" */
  pageSend(me, group, name, body0) {
    const bs = this.buddies;
    const mk = lower(me), k = lower(name);
    const body = cleanText(body0, PAGE_MSG_LEN);
    if (body === '') return 'empty';
    if (this.msgMuted(mk)) return 'off';
    this.buddyFetch(k);
    const l = bs.list(me);
    const to = l !== null && l.b.has(k) ? l.b.get(k) : null;
    if (to === null) return 'none';
    if (this.msgSlur(mk, me, body, group) || bs.blocks(k, mk)) return 'sent';
    const now = this.bnow();
    let o = bs.online.get(k);
    if (o !== undefined) {
      const ox = bs.conns.get(o);
      if (ox === undefined || ox.persona === null) o = undefined;
    }
    let done;
    if (o !== undefined) {
      const rec = [['USER', me], ['BODY', body], ['SUBJ', ''], ['TYPE', 'C'], ['TIME', Math.floor(now / 1000)]];
      done = quiet(() => this.bsend(o, 'RECV', rec, '')) ? 'sent' : 'full';
    } else if (this.pageMailTo(k, { from: me, body, t: Math.floor(now) })) done = 'sent';
    else if (this.keep(k, { from: me, body, subj: '', kind: 'C', t: Math.floor(now) })) done = 'kept';
    else done = 'full';
    const how = done === 'sent' ? 'got it' : done === 'kept' ? 'away, it waits' : 'no room for it';
    this.log('[online] "' + me + '" sent "' + to + '" a message (' + how + ')', group);
    return done;
  },

  /** the messages that waited for persona me, to connection b, gone from the store */
  deliverMail(b, me) {
    const bs = this.buddies;
    const l = bs.lists.get(me);
    if (l === undefined || l.m.length === 0) return;
    const mail = l.m;
    l.m = [];
    bs.mail -= mail.length;
    bs.mark(me);
    this.touchLists();
    const now = this.bnow();
    for (const m of mail) {
      if (now - m.t >= MAIL_DAYS * DAY_MS || bs.blocks(me, lower(m.from))) continue;
      this.bsend(b, 'RECV', [['USER', m.from], ['BODY', m.body], ['SUBJ', m.subj], ['TYPE', m.kind], ['TIME', Math.floor(m.t / 1000)]], '');
    }
  },

  /** the AUTH tried again */
  buddyRetry(b, f) {
    const x = this.buddies.conns.get(b);
    if (x === undefined) return;
    if (!this.connOpen(x.conn) || x.persona !== null) return;
    quiet(() => this.buddyMessage(b, 'AUTH', f));
  },

  /** one message of the game's buddy client (throws BuddyError as Rust's Err) */
  buddyMessage(b, kind, f) {
    const bs = this.buddies;
    const id = f.get('ID');
    const withId = id !== null ? [['ID', id]] : [];
    const wid = (extra) => [...withId, ...extra];
    const x = bs.conns.get(b);
    assert(x !== undefined, 'a held buddy connection');
    if (kind === 'AUTH') {
      if (x.persona !== null) return this.bsend(b, 'AUTH', [['TITL', 'EA MESSENGER']], 'logn');
      const key = f.str('LKEY');
      const vip = x.vip;
      let s = null;
      if (key.length >= 24) {
        for (const sid of this.lobby.ofVip(vip)) {
          const y = this.lobby.s(sid);
          if (y.vip === vip && y.lkey !== null && y.lkey !== undefined && y.lkey !== '' && y.lkey.startsWith(key)) {
            s = sid;
            break;
          }
        }
      }
      if (s === null) {
        x.tries += 1;
        // the lobby login may finish a moment later
        if (x.tries <= 6) {
          this.setTimeout(500, { k: 'BuddyRetry', b, f: f.clone() });
          return;
        }
        return this.bsend(b, 'AUTH', [['TITL', 'EA MESSENGER']], 'pass');
      }
      const xl = bs.conns.get(b);
      if (xl !== undefined && xl.loginTimer !== null) {
        const t = xl.loginTimer;
        xl.loginTimer = null;
        this.timers.clear(t);
      }
      const sp = this.lobby.s(s).persona;
      const persona = sp === null || sp === undefined ? '' : sp;
      const k = lower(persona);
      const old = bs.online.get(k);
      if (old !== undefined && old !== b) {
        const ox = bs.conns.get(old);
        if (ox !== undefined) this.connDestroy(ox.conn, 'logged in again');
      }
      const x2 = bs.conns.get(b);
      if (x2 !== undefined) {
        x2.persona = persona;
        x2.key = k;
      }
      bs.onlineSet(k, b);
      const so = this.lobby.s(s).owner;
      this.listsAtLogin(persona, so === undefined ? null : so);
      this.seenList(persona);
      // (requests and messages that waited too long go, at most once an hour)
      const now = this.bnow();
      if (now - bs.pruned >= 3600000) {
        bs.pruned = now;
        if (bs.prune(now)) this.touchLists();
      }
      return this.bsend(b, 'AUTH', [['TITL', 'EA MESSENGER']], '');
    }
    if (kind === 'PING') return this.bsend(b, 'PING', [], '');
    if (kind === 'DISC') {
      this.buddyGone(b);
      this.connEnd(bs.conns.get(b).conn);
      return;
    }
    const short = slice16(kind, 4);
    const bp = bs.conns.get(b).persona;
    if (bp === null) return this.bsend(b, short, [], 'auth');
    const me = lower(bp);
    const group = bs.conns.get(b).group;
    const listOf = (f) => (f.str('LIST').toUpperCase() === 'I' ? 'I' : 'B');
    const listField = (f) => (f.has('LIST') ? listOf(f) : 'B');
    if (kind === 'EPGT') return this.bsend(b, 'EPGT', wid([['ENAB', 'N'], ['ADDR', '']]), '');
    if (kind === 'RGET') {
      const now = this.bnow();
      if (!bs.conns.get(b).heavy.takeAt(now, 1)) return this.bsend(b, 'RGET', withId, 'full');
      const which = listField(f);
      // the entries: name, ATTR (a request's letter, none for a friend or a blocked one)
      const rows = [];
      const l = bs.lists.get(me);
      if (which === 'I') {
        if (l !== undefined) for (const n of l.i.values()) rows.push([n, '']);
      } else {
        if (l !== undefined) for (const n of l.b.values()) rows.push([n, '']);
        const pend = f.str('PEND');
        if (pend === 'Y' || pend === 'y') {
          const friendOrAsked = (k) => l !== undefined && (l.b.has(k) || l.r.has(k));
          if (l !== undefined) {
            for (const [k, [n, t]] of l.r) if (now - t < ASK_DAYS * DAY_MS && !l.b.has(k)) rows.push([n, I_ASKED]);
          }
          const askers = l !== undefined ? [...l.q.keys()] : [];
          askers.sort(cmpStr);
          for (const k of askers) {
            const n = bs.request(k, me, now);
            if (n !== null && !bs.blocks(me, k) && !friendOrAsked(k)) rows.push([n, ASKED_ME]);
          }
        }
      }
      this.bsend(b, 'RGET', wid([['SIZE', rows.length]]), '');
      for (const [n, a] of rows) {
        const r = wid([['USER', n], ['LIST', which]]);
        if (a !== '') r.push(['ATTR', a]);
        this.bsend(b, 'ROST', r, '');
      }
      if (which === 'B') {
        for (const [n] of rows) this.bsend(b, 'PGET', this.presenceOf(lower(n), n), '');
        // the messages that waited, a moment later (MAIL_WAIT_MS)
        const lm = bs.lists.get(me);
        const waiting = lm !== undefined && lm.m.length > 0;
        const xc = bs.conns.get(b);
        if (waiting && xc.mailTimer === null) xc.mailTimer = this.setTimeout(MAIL_WAIT_MS, { k: 'BuddyMail', b });
      }
      return;
    }
    // (RADD LIST=B: a friend request, as RADM below)
    if ((kind === 'RADD' || kind === 'RDEL' || kind === 'RDEM') && (kind !== 'RADD' || listField(f) === 'I')) {
      const which = kind === 'RDEM' ? 'B' : listField(f);
      const who = stripAt(f.str('USER'));
      if (!validName(who) || lower(who) === me) return this.bsend(b, kind, withId, 'user');
      const k = lower(who);
      if (which === 'I') {
        if (kind === 'RADD') {
          if (!this.block(bp, group, who)) return this.bsend(b, kind, withId, 'full');
        } else if (bs.blockRemove(me, k)) this.touchLists();
        return this.bsend(b, kind, withId, '');
      }
      // a friend taken off, or the request taken back: on neither side any more
      this.bsend(b, kind, withId, '');
      return this.unfriend(bp, who);
    }
    if (kind === 'RADM' || kind === 'RADD') {
      // a friend request (Send Friend Request): it waits for the persona's answer, RRSP
      const who = stripAt(f.str('USER'));
      const k = lower(who);
      if (!validName(who) || k === me) return this.bsend(b, kind, withId, 'user');
      const now = this.bnow();
      const back = this.fetchBack(me, k);
      const l = bs.list(bp);
      const friends = l !== null && l.b.has(k) && back;
      const full = l !== null && l.b.size >= MAX_FRIENDS && !l.b.has(k);
      const askedFull = l !== null && l.r.size >= MAX_ASKED && !l.r.has(k);
      if (friends) return this.bsend(b, kind, withId, '');
      if (full) return this.bsend(b, kind, withId, 'full');
      // two requests that cross (the asked one asks back) make friends
      if (bs.request(k, me, now) !== null) {
        this.bsend(b, kind, withId, '');
        return this.befriend(b, who, 'asked back');
      }
      if (askedFull || !this.makeList(bp, group)) return this.bsend(b, kind, withId, 'full');
      this.bsend(b, kind, withId, '');
      // the asked persona's presence for the asker's new entry
      this.bsend(b, 'PGET', this.presenceOf(k, who), '');
      // (a persona that blocks the asker never hears of it)
      if (bs.blocks(k, me)) return;
      this.askedList(who);
      bs.ask(me, k, who, Math.floor(now));
      this.touchLists();
      this.log('[online] "' + bp + '" asked "' + who + '" to be friends', group);
      const o = bs.online.get(k);
      if (o === undefined) return;
      this.bsend(o, 'RNOT', [['USER', bp], ['CHNG', 'A'], ['ATTR', ASKED_ME]], '');
      return this.bsend(o, 'PGET', presence(bs.conns.get(b)), '');
    }
    if (kind === 'RRSP') {
      // the answer to a friend request: Y accept, N decline, B block
      const who = stripAt(f.str('USER'));
      const k = lower(who);
      const now = this.bnow();
      this.buddyFetch(k);
      const asker = bs.request(k, me, now);
      this.bsend(b, kind, withId, '');
      // (one that waited too long goes too)
      if (bs.unask(k, me)) this.touchLists();
      if (asker === null) return;
      const answer = f.str('ANSW');
      const c = answer.charAt(0);
      const a = c === 'y' || c === 'Y' ? 'Y' : c === 'b' || c === 'B' ? 'B' : null;
      if (a === 'Y') return this.befriend(b, asker, 'ANSW=' + cleanText(answer, 8));
      if (a === 'B') this.block(bp, group, asker);
      this.log('[online] "' + bp + '" declined "' + asker + '"\'s friend request', group);
      const o = bs.online.get(k);
      if (o !== undefined) this.bsend(o, 'RNOT', [['USER', bp], ['CHNG', 'D']], '');
      return;
    }
    if (kind === 'PADD' || kind === 'PDEL') {
      // the Messenger's "All" list: players this one searched for or met (in memory only); their presence
      const who = stripAt(f.str('USER'));
      this.bsend(b, kind, withId, '');
      if (!validName(who)) return;
      const xc = bs.conns.get(b);
      const k = lower(who);
      if (kind === 'PDEL') {
        if (xc.met.delete(k)) {
          const s = bs.metBy.get(k);
          if (s !== undefined) {
            s.delete(b);
            if (s.size === 0) bs.metBy.delete(k);
          }
        }
        return;
      }
      if (xc.met.size < MAX_LIST && !xc.met.has(k)) {
        xc.met.add(k);
        let s = bs.metBy.get(k);
        if (s === undefined) {
          s = new Set();
          bs.metBy.set(k, s);
        }
        s.add(b);
      }
      return this.bsend(b, 'PGET', this.presenceOf(k, who), '');
    }
    if (kind === 'USCH') {
      // Search: personas online now or known from their races whose name starts with the text (at most MAXR, 20)
      const now = this.bnow();
      if (!bs.conns.get(b).heavy.takeAt(now, 1)) return this.bsend(b, 'USCH', wid([['SIZE', 0]]), '');
      const qs = slice16(lower(stripAt(f.str('USER'))), 15);
      const max = Math.min(20, Math.max(1, f.num('MAXR', 20) | 0));
      const found = new Map();
      if (qs !== '') {
        for (const [k, s] of this.lobby.byPersona) {
          if (!k.startsWith(qs)) continue;
          const p = this.lobby.s(s).persona;
          if (p !== null && p !== undefined) found.set(k, p);
        }
        for (const n of this.stats.startingWith(qs, max + 1)) found.set(lower(n), n);
      }
      found.delete(me);
      const names = [...found.values()].sort(cmpStr).slice(0, max);
      this.bsend(b, 'USCH', wid([['SIZE', names.length]]), '');
      for (const n of names) this.bsend(b, 'USER', wid([['USER', n]]), '');
      return;
    }
    if (kind === 'PSET') {
      const g = f.get('SHOW');
      const show = slice16(g === null ? 'CHAT' : g, 8);
      const stat = slice16(f.str('STAT'), 64);
      const prod = cleanText(f.str('PROD'), 64);
      this.bsend(b, 'PSET', withId, '');
      const xc = bs.conns.get(b);
      if (xc.told !== null && show === xc.show && stat === xc.stat && prod === xc.prod) return;
      xc.show = show;
      xc.stat = stat;
      xc.prod = prod;
      return this.presenceChanged(b);
    }
    if (kind === 'SEND' || kind === 'GINV' || kind === 'GRSP' || kind === 'GRVK') {
      const to = stripAt(f.str('USER'));
      const k = lower(to);
      let o = bs.online.get(k);
      const t = this.bnow();
      const xc = bs.conns.get(b);
      // messages and invites: 2 a second, a burst of 5 (over that: "full", the connection stays)
      xc.msgsV = Math.min(5, xc.msgsV + (t - xc.msgsT) / 500);
      xc.msgsT = t;
      if (xc.msgsV < 1) return this.bsend(b, kind, withId, 'full');
      xc.msgsV -= 1;
      this.bsend(b, kind, withId, '');
      // a message that reads as a slur, or one while the sender's are off, reaches no one
      if (kind === 'SEND' && (this.msgMuted(me) || this.msgSlur(me, bp, cleanText(f.str('BODY'), 500), group))) return;
      if (o !== undefined) {
        const ox = bs.conns.get(o);
        if (ox === undefined || ox.persona === null) o = undefined;
      }
      // away: a message from a friend goes to its pages, or waits for the persona (an invite is forgotten)
      if (o === undefined) {
        if (kind === 'SEND' && validName(to)) this.keepMail(k, bp, f, t);
        return;
      }
      // this sender is blocked
      if (bs.blocks(k, me)) return;
      const xb = bs.conns.get(b);
      const bp2 = xb !== undefined ? xb.persona : null;
      if (kind === 'SEND') {
        const g = f.get('TYPE');
        const rec = [
          ['USER', bp2], ['BODY', cleanText(f.str('BODY'), 500)], ['SUBJ', cleanText(f.str('SUBJ'), 64)],
          ['TYPE', slice16(g === null ? 'C' : g, 4)], ['TIME', Math.floor(t / 1000)],
        ];
        return this.bsend(o, 'RECV', rec, '');
      }
      // a game invite and its answers: the game's own fields, the sender named by the server
      const rec = [['USER', bp2]];
      let n = 0;
      for (const [fk, fv] of f.m) {
        if (n >= 12) break;
        if (fv === null || fk === 'USER' || fk === 'ID' || fk === 'LKEY') continue;
        rec.push([fk, cleanText(fv, 128)]);
        n++;
      }
      return this.bsend(o, kind, rec, '');
    }
    return this.bsend(b, short, withId, '');
  },
};


/** an empty list (tests) */
export { newList as newFriendsList };
