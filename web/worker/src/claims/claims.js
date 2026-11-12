// Claimed names (docs/web/PLAYING.md, "Your name"): a port of web/server-rs/crates/claims (nfsu2-claims).  A player
// claims the name it plays under with its keyphrase, and while the claim holds nobody else plays under that name: the
// Online lobby gives anyone else the name with four digits in place of its end, free roam's hub links nobody else
// under it, and EA Messenger keeps its lists only for a claimed name.
//
// - A name is compared in its Online form (clean), in any case.
// - NAME and Player (UNCLAIMABLE) and a name that reads as a slur (web/worker/src/names) are never claimed.
// - A claim lasts HOLD_DAYS after its owner last played under it (seen) or used the keyphrase (used).
// - One name a keyphrase; a change at most every CHANGE_DAYS; the name before stays the owner's GRACE_DAYS more.
// - The owner is a keyphrase, by a hash of its token (ownerOfToken).
// - A claim of a name also holds its second form (second: "Alex" holds "Alex_2"), co-op free roam's second player.
//
// Kept in names.json (serialize / Claims.fromText), here through the injected storage ({get, put}: Durable Object
// storage in production, a Map in tests) by Claims.open and save.  Sans-IO: every call takes the time (ms) it is at.
//
// Deviations from the Rust (none in what a call answers): one thread (no locks), and where the Rust iterates a
// HashMap (reading a file edited by hand with two current names of one owner made in the same ms) the order here is
// the file's.

import { blockedName } from '../names/index.js';
import { base64url } from '../util/js.js';
import { writeStr } from '../util/json.js';
import { sha256 } from '../util/sha256.js';

export const DAY_MS = 86400000;
export const HOLD_DAYS = 730;
export const CHANGE_DAYS = 7;
export const GRACE_DAYS = 14;
export const UNCLAIMABLE = Object.freeze(['name', 'player']);
export const MAX_CLAIMS = 5000000;
const PRUNE_EVERY_MS = 3600000;
const FULL_PRUNE_MS = 60000;
const SEEN_STEP_MS = 3600000;
/** the most characters of a name its second form keeps */
export const SECOND_BASE = 13;
/** the storage key of the claims' file */
export const NAMES_KEY = 'names.json';

function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** The Online form of a name (claims clean): letters, digits, - and _, any other run one _, cut to 15, padded to 3; null: none */
export function clean(name) {
  let out = '';
  let gap = false;
  for (const ch of name) {
    if (out.length >= 15) break;
    const c = ch.codePointAt(0);
    if (!(isAlnum(c) || ch === '_' || ch === '-')) {
      gap = true;
      continue;
    }
    if (gap && out.length > 0 && out.length < 14) out += '_';
    gap = false;
    out += ch;
  }
  if (out.length === 0) return null;
  while (out.length < 3) out += '_';
  return out;
}

function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** what a name is compared by: its Online form in lower case */
export function canonical(name) {
  const c = clean(name);
  return c === null ? null : asciiLower(c);
}

/** The second form of a name: "Alex" -> "Alex_2" (null: nothing of a name in it) */
export function second(name) {
  const base = clean(name);
  if (base === null) return null;
  return base.slice(0, Math.min(base.length, SECOND_BASE)) + '_2';
}

/** The name a second form was made of, as far as it keeps it; null: form is no second form */
export function secondBase(form) {
  if (!form.endsWith('_2')) return null;
  const b = form.slice(0, form.length - 2);
  return b.length >= 3 && b.length <= SECOND_BASE ? b : null;
}

/** The name as typed or its Online form reads as a slur */
export function readsAsSlur(typed, shown) {
  return blockedName(typed) || blockedName(shown);
}

/** the owner a keyphrase's token stands for (43 characters of base64url), null when it is no token */
export function ownerOfToken(token) {
  if (typeof token !== 'string' || token.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return ownerOfId(sha256(new TextEncoder().encode(token)));
}

/** the owner of the keyphrase kept under id (the token's SHA-256, 32 bytes) */
export function ownerOfId(id) {
  const pre = new TextEncoder().encode('nfsu2 claim\0');
  const b = new Uint8Array(pre.length + id.length);
  b.set(pre);
  b.set(id, pre.length);
  return base64url(sha256(b)).slice(0, 22);
}

function claimEnd(c) {
  return c.until > 0 ? c.until : c.seen + HOLD_DAYS * DAY_MS;
}

function claimLive(c, now) {
  return now < claimEnd(c);
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The claimed names (claims Claims) */
export class Claims {
  constructor() {
    /** lower case -> {name, owner, made, seen, until} (dead ones too, until prune) */
    this.names = new Map();
    /** owner -> {current, changed, prev} */
    this.owners = new Map();
    /** the keys of names longer than SECOND_BASE, by their first SECOND_BASE */
    this.long = new Map();
    this.prunedAt = 0;
    this.gen = 1;
    this.dirty = false;
  }

  /** claims kept nowhere */
  static inMemory() {
    return new Claims();
  }

  /** the claims of a names.json text (what is not a live claim of a claimable name is left out) */
  static fromText(text, now) {
    const c = new Claims();
    c.read(text, now);
    return c;
  }

  /** the claims kept in storage under NAMES_KEY (none yet: empty) */
  static async open(storage, now) {
    const text = storage ? await storage.get(NAMES_KEY) : null;
    return typeof text === 'string' ? Claims.fromText(text, now) : new Claims();
  }

  /** names.json written to storage when anything changed since the last time: true when it was */
  async save(storage, now) {
    if (!storage || !this.dirty) return false;
    this.dirty = false;
    try {
      await storage.put(NAMES_KEY, this.serialize(now));
    } catch (e) {
      this.dirty = true;
      throw e;
    }
    return true;
  }

  changed() {
    this.gen++;
    this.dirty = true;
  }

  /** one more each time a name's owner changes: readers that keep what they found look again */
  generation() {
    return this.gen;
  }

  live(key, now) {
    const c = this.names.get(key);
    return c !== undefined && claimLive(c, now) ? c : null;
  }

  seconds(key, now) {
    const base = secondBase(key);
    if (base === null) return [];
    const long = base.length === SECOND_BASE ? this.long.get(base) || [] : [];
    const exact = this.live(base, now);
    let of = exact ? [exact] : [];
    for (const k of long) {
      if (k === key) continue;
      const c = this.live(k, now);
      if (c) of.push(c);
    }
    let first = exact;
    if (!first) {
      for (const c of of) if (first === null || c.made < first.made || (c.made === first.made && c.name < first.name)) first = c;
    }
    if (first) {
      const owner = first.owner;
      of = of.filter((c) => c.owner === owner);
    }
    return of;
  }

  sharesSecond(key, owner, now) {
    if (key.length < SECOND_BASE) return false;
    const base = key.slice(0, SECOND_BASE);
    const form = base + '_2';
    const keys = [base, ...(this.long.get(base) || [])];
    for (const k of keys) {
      if (k === key || k === form) continue;
      const c = this.live(k, now);
      if (c && c.owner !== owner) return true;
    }
    return false;
  }

  indexOne(key) {
    if (key.length > SECOND_BASE) {
      const b = key.slice(0, SECOND_BASE);
      let keys = this.long.get(b);
      if (!keys) {
        keys = [];
        this.long.set(b, keys);
      }
      if (!keys.includes(key)) keys.push(key);
    }
  }

  unindex(key) {
    if (key.length > SECOND_BASE) {
      const b = key.slice(0, SECOND_BASE);
      const keys = this.long.get(b);
      if (keys) {
        const left = keys.filter((k) => k !== key);
        if (left.length === 0) this.long.delete(b);
        else this.long.set(b, left);
      }
    }
  }

  indexAll() {
    this.long.clear();
    for (const k of this.names.keys()) if (k.length > SECOND_BASE) this.indexOne(k);
  }

  current(owner, now) {
    const r = this.owners.get(owner);
    if (!r || r.current == null) return null;
    const c = this.live(r.current, now);
    return c && c.until === 0 && c.owner === owner ? r.current : null;
  }

  mineOf(owner, now) {
    const k = this.current(owner, now);
    if (k === null) return null;
    const c = this.names.get(k);
    const r = this.owners.get(owner);
    const changed = r ? r.changed : 0;
    return { name: c.name, until: claimEnd(c), nextChange: changed > 0 ? changed + CHANGE_DAYS * DAY_MS : 0 };
  }

  pruneInner(now) {
    this.prunedAt = now;
    const n = this.names.size;
    for (const [k, c] of [...this.names]) if (!claimLive(c, now)) this.names.delete(k);
    for (const [o, r] of [...this.owners]) {
      if (r.current != null) {
        const c = this.names.get(r.current);
        if (!(c && c.owner === o)) r.current = null;
      }
      if (!(r.current != null || now < r.changed + CHANGE_DAYS * DAY_MS)) this.owners.delete(o);
    }
    const gone = this.names.size !== n;
    if (gone) this.indexAll();
    return gone;
  }

  /** how many names are claimed now */
  count(now) {
    let n = 0;
    for (const c of this.names.values()) if (claimLive(c, now)) n++;
    return n;
  }

  /** what name is to owner (null: to nobody's keyphrase): {kind: 'invalid'|'default'|'blocked'|'free'|'taken'} or {kind: 'yours', until, current} */
  status(name, owner, now) {
    const shown = clean(name);
    if (shown === null) return { kind: 'invalid' };
    const key = asciiLower(shown);
    if (UNCLAIMABLE.includes(key)) return { kind: 'default' };
    if (readsAsSlur(name, shown)) return { kind: 'blocked' };
    const yours = (c) => ({ kind: 'yours', until: claimEnd(c), current: c.until === 0 });
    const c = this.live(key, now);
    if (c) return owner != null && c.owner === owner ? yours(c) : { kind: 'taken' };
    const of = this.seconds(key, now);
    let best = null;
    if (owner != null) {
      for (const x of of) {
        if (x.owner !== owner) continue;
        // max_by_key((until == 0, end)): the last of the greatest
        if (best === null || (x.until === 0) > (best.until === 0) || ((x.until === 0) === (best.until === 0) && claimEnd(x) >= claimEnd(best))) best = x;
      }
    }
    if (best) return yours(best);
    if (of.length === 0 && this.sharesSecond(key, owner != null ? owner : '', now)) return { kind: 'taken' };
    if (of.length === 0) return { kind: 'free' };
    return { kind: 'taken' };
  }

  /** The keyphrase name is claimed by now (null: nobody's), by a claim of that name itself */
  holder(name, now) {
    const key = canonical(name);
    if (key === null) return null;
    const c = this.live(key, now);
    return c ? c.owner : null;
  }

  /** the keyphrases that hold name now (its claim's, else the owner of the names a second form is made of) */
  holders(name, now) {
    const key = canonical(name);
    if (key === null) return [];
    const c = this.live(key, now);
    if (c) return [c.owner];
    const of = this.seconds(key, now).map((x) => x.owner);
    of.sort(cmpStr);
    return of.filter((x, i) => i === 0 || of[i - 1] !== x);
  }

  /** whoever has owner (null: none) may play under name */
  mayUse(name, owner, now) {
    const key = canonical(name);
    if (key === null) return true;
    const c = this.live(key, now);
    if (c) return owner != null && c.owner === owner;
    const of = this.seconds(key, now);
    return of.length === 0 || (owner != null && of.some((x) => x.owner === owner));
  }

  /** owner's current name: {name, until, nextChange} or null */
  mine(owner, now) {
    return this.mineOf(owner, now);
  }

  /** the name owner had before its last change, while that change is younger than GRACE_DAYS (lower case) */
  previous(owner, now) {
    const r = this.owners.get(owner);
    if (!r) return null;
    return now < r.changed + GRACE_DAYS * DAY_MS ? (r.prev != null ? r.prev : null) : null;
  }

  /** owner claims name: {ok: mine} or {err: {kind: 'invalid'|'default'|'blocked'|'taken'|'full'} | {kind: 'tooSoon', next}} */
  claim(name, owner, now) {
    const shown = clean(name);
    if (shown === null) return { err: { kind: 'invalid' } };
    const key = asciiLower(shown);
    if (UNCLAIMABLE.includes(key)) return { err: { kind: 'default' } };
    if (readsAsSlur(name, shown)) return { err: { kind: 'blocked' } };
    const c = this.live(key, now);
    if (c && c.owner !== owner) return { err: { kind: 'taken' } };
    if (c && c.until === 0) {
      if (c.name !== shown || now - c.seen >= SEEN_STEP_MS) {
        c.name = shown;
        c.seen = now;
        this.dirty = true;
      }
      return { ok: this.mineOf(owner, now) };
    }
    if (!c) {
      const of = this.seconds(key, now);
      if (of.some((x) => x.owner !== owner)) return { err: { kind: 'taken' } };
      if (of.length > 0) {
        const mine = this.mineOf(owner, now);
        if (mine) return { ok: mine };
      }
    }
    if (this.sharesSecond(key, owner, now)) return { err: { kind: 'taken' } };
    const old = this.current(owner, now);
    if (old !== null) {
      const rec = this.owners.get(owner) || { current: null, changed: 0, prev: null };
      if (rec.changed > 0 && now < rec.changed + CHANGE_DAYS * DAY_MS) return { err: { kind: 'tooSoon', next: rec.changed + CHANGE_DAYS * DAY_MS } };
      this.names.get(old).until = now + GRACE_DAYS * DAY_MS;
      let r = this.owners.get(owner);
      if (!r) {
        r = { current: null, changed: 0, prev: null };
        this.owners.set(owner, r);
      }
      r.prev = old;
      r.changed = now;
    }
    if (this.names.size >= MAX_CLAIMS && !this.names.has(key)) {
      if (now >= this.prunedAt + FULL_PRUNE_MS) this.pruneInner(now);
      if (this.names.size >= MAX_CLAIMS) return { err: { kind: 'full' } };
    }
    this.names.set(key, { name: shown, owner, made: now, seen: now, until: 0 });
    this.indexOne(key);
    let r = this.owners.get(owner);
    if (!r) {
      r = { current: null, changed: 0, prev: null };
      this.owners.set(owner, r);
    }
    r.current = key;
    const mine = this.mineOf(owner, now);
    this.changed();
    return { ok: mine };
  }

  /** owner played under name: a claim of its current name holds HOLD_DAYS from now */
  seen(name, owner, now) {
    const key = canonical(name);
    if (key === null) return;
    const c = this.live(key, now);
    if (!(c && c.owner === owner && c.until === 0 && now - c.seen >= SEEN_STEP_MS)) return;
    c.seen = now;
    this.dirty = true;
  }

  /** owner's keyphrase was used: the claim of its current name holds HOLD_DAYS from now */
  used(owner, now) {
    const k = this.current(owner, now);
    if (k !== null) this.seen(this.names.get(k).name, owner, now);
  }

  /** a keyphrase gone from the cloud: its names are free.  How many there were. */
  release(owner) {
    const keys = [];
    for (const [k, c] of this.names) if (c.owner === owner) keys.push(k);
    for (const k of keys) {
      this.names.delete(k);
      this.unindex(k);
    }
    this.owners.delete(owner);
    if (keys.length > 0) this.changed();
    return keys.length;
  }

  /** the operator frees a name: whose it was (its name as shown), null when nobody's */
  unclaim(name) {
    const key = canonical(name);
    if (key === null) return null;
    const c = this.names.get(key);
    if (!c) return null;
    this.names.delete(key);
    this.unindex(key);
    const r = this.owners.get(c.owner);
    if (r && r.current === key) r.current = null;
    this.changed();
    return c.name;
  }

  /** the dead claims go, at most every PRUNE_EVERY_MS: true when any did */
  prune(now) {
    if (now < this.prunedAt + PRUNE_EVERY_MS) return false;
    const gone = this.pruneInner(now);
    if (gone) this.changed();
    return gone;
  }

  /** names.json's text */
  serialize(now) {
    const names = [];
    for (const c of this.names.values()) if (claimLive(c, now)) names.push(c);
    const owners = [];
    for (const [o, r] of this.owners) if (r.changed > 0) owners.push([o, r.prev, r.changed]);
    names.sort((a, b) => a.made - b.made || cmpStr(a.name, b.name));
    let s = '{"v":1,"note":"claimed names: the keyphrase hash that claimed each, when, last played","claims":[';
    names.forEach((c, i) => {
      if (i > 0) s += ',';
      s += '{"name":' + writeStr(c.name) + ',"owner":' + writeStr(c.owner) + ',"made":' + c.made + ',"seen":' + c.seen;
      if (c.until > 0) s += ',"until":' + c.until;
      s += '}';
    });
    s += '],"owners":[';
    owners.sort((a, b) => cmpStr(a[0], b[0]));
    owners.forEach(([o, prev, changed], i) => {
      if (i > 0) s += ',';
      s += '{"owner":' + writeStr(o) + ',"changed":' + changed;
      if (prev != null) s += ',"prev":' + writeStr(prev);
      s += '}';
    });
    return s + ']}';
  }

  /** names.json read (what is not a live claim of a claimable name is left out) */
  read(text, now) {
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return;
    }
    const num = (o, k) => {
      const t = o[k];
      return typeof t === 'number' && t >= 0.0 && t < 1e15 ? Math.trunc(t) : null;
    };
    const ownerOf = (o) => {
      const s = o.owner;
      return typeof s === 'string' && s.length === 22 && /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
    };
    const claims = j && Array.isArray(j.claims) ? j.claims : [];
    for (const e of claims) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const name = typeof e.name === 'string' ? clean(e.name) : null;
      const who = ownerOf(e), made = num(e, 'made'), seen = num(e, 'seen');
      if (name === null || who === null || made === null || seen === null) continue;
      const key = asciiLower(name);
      if (UNCLAIMABLE.includes(key) || blockedName(name)) continue;
      const c = { name, owner: who, made, seen, until: num(e, 'until') ?? 0 };
      // (a key read twice: the later one, as a HashMap insert)
      if (claimLive(c, now)) {
        this.names.delete(key);
        this.names.set(key, c);
      }
    }
    const cur = new Map();
    for (const [k, c] of this.names) {
      if (c.until === 0) {
        const e = cur.get(c.owner);
        if (!e) cur.set(c.owner, [c.made, k]);
        else if (c.made > e[0]) cur.set(c.owner, [c.made, k]);
      }
    }
    for (const [k, c] of [...this.names]) {
      if (!(c.until > 0 || (cur.has(c.owner) && cur.get(c.owner)[1] === k))) this.names.delete(k);
    }
    for (const [o, [, k]] of cur) {
      let r = this.owners.get(o);
      if (!r) {
        r = { current: null, changed: 0, prev: null };
        this.owners.set(o, r);
      }
      r.current = k;
    }
    const owners = j && Array.isArray(j.owners) ? j.owners : [];
    for (const e of owners) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const who = ownerOf(e), changed = num(e, 'changed');
      if (who === null || changed === null) continue;
      let r = this.owners.get(who);
      if (!r) {
        r = { current: null, changed: 0, prev: null };
        this.owners.set(who, r);
      }
      r.changed = changed;
      r.prev = typeof e.prev === 'string' ? canonical(e.prev) : null;
    }
    this.pruneInner(now);
    this.indexAll();
  }
}
