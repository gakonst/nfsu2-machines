// Who is on the switch (admission, a connection's close, the free addresses, "LAN full", the reservations, the peer
// list's changes, the store): crates/lan/src/members.rs.

import { closePayload } from './conn.js';
import { SwapMap } from './timers.js';
import { Line } from './queue.js';
import { jsString, newToken, tokenFits, tokenHash, cleanName, vipNum } from './text.js';
import * as lag from './lag.js';
import * as paths from './paths.js';
import * as plates from './plates.js';
import * as store from './store.js';
import * as json from '../util/json.js';
import { PLAIN, COMPACT, DELTAS, FPRED, OTHERS } from './conn.js';
import { ADDRS, MASK, Pair, Peer, slot, vipAt, vipStr, utf8, bucketAt, udpOf, GONE_MAX } from './lib.js';

/** members.rs Members */
export class Members {
  constructor() {
    /** in the order they came (a replaced holder keeps its place) */
    this.peers = new Map();
    /** the ones of peers whose LAN play is not off (IndexMap with swap_remove) */
    this.lan = new SwapMap();
    /** vip -> {hash, until, group, site} */
    this.reserved = new Map();
    this.next = 0;
    this.changed = new Set();
    this.left = new Set();
    this.deltaArmed = false;
    this.saveArmed = false;
    this.saveGen = 0;
    this.saveSeq = 0;
    this.line = new Line();
  }

  /** a free address that is nobody's reservation, or 0 */
  allocate() {
    for (let i = 0; i < ADDRS; i++) {
      const k = (this.next + i) % ADDRS;
      const c = vipAt(k);
      if (!this.peers.has(c) && !this.reserved.has(c)) {
        this.next = (k + 1) % ADDRS;
        return c;
      }
    }
    return 0;
  }

  /** a newcomer has no place now */
  full(maxPeers, now) {
    let live = 0;
    for (const r of this.reserved.values()) if (r.until > now) live++;
    return this.peers.size + live >= Math.min(maxPeers, ADDRS);
  }
}

const M = {
  /** members.rs admit */
  admit(conn, ctx, hello) {
    if (!conn.open()) return null;
    const m = this.members;
    let held = heldAddress(m, hello, this.now);
    if (held[0] === 0 && ctx.queue && hello && typeof hello.ticket === 'string') {
      const t = hello.ticket;
      if (this.rejoin(m, conn, ctx, hello, t)) {
        this.letIn();
        return conn.peer;
      }
      held = m.line.seatedFor(m.peers, m.reserved, t, this.now);
    }
    const place = this.place(m, held, false);
    if (place) {
      const [vip, old, resumed] = place;
      const [peer, count] = this.seat(m, conn, ctx, hello, vip, old);
      if (ctx.onJoin) ctx.onJoin(peer.vip, resumed, count);
      return peer;
    }
    if (!(ctx.queue && this.enqueue(m, conn, ctx, hello))) {
      this.stats.refused++;
      conn.close(lanFull());
    }
    return null;
  },

  /** members.rs place */
  place(m, held, first) {
    this.expire(m);
    const [vip, old] = held;
    if (vip !== 0) {
      if (!old && m.peers.size >= this.o.maxPeers) return null;
      m.reserved.delete(vip);
      this.stats.resumed++;
      return [vip, old, true];
    }
    if ((!first && m.line.beforeNewcomers()) || m.full(this.o.maxPeers, this.now)) return null;
    const v = m.allocate();
    return v === 0 ? null : [v, null, false];
  },

  /** members.rs seat */
  seat(m, conn, ctx, hello, vip, old) {
    const o = this.o;
    const token = newToken(this.prng);
    const now = this.mono();
    conn.vip = vip;
    const peer = new Peer({
      vip, conn, group: ctx.group, site: ctx.site, tokenHash: tokenHash(token), nameSet: null, hello: false, bundle: false,
      lan: false, udp: 0, framesIn: 0, framesOut: 0, buckets: new Pair(o.frameRate, o.byteRate, now),
      ctl: { texts: bucketAt(o.textRate, now), ctl: bucketAt(o.ctlRate, now) }, alive: true, lastIn: this.now,
      probe: new lag.Probe(now), share: { v: lag.SHARE_FULL }, away: false, roamAt: 0, listed: false, ident: ctx.ident,
      since: this.now, country: ctx.country, lanTo: new Uint32Array(paths.LAN_TO), plates: new plates.Seen(),
    });
    if (hello) {
      peer.ctl.texts.takeAt(now, 1);
      greet(peer, hello, o.fpred, o.probeEcho);
      this.handHub(peer, hello);
    }
    m.peers.set(vip, peer);
    m.lan.swapRemove(vip);
    if (peer.lan) m.lan.set(vip, peer);
    conn.peer = peer;
    const welcome = '{"t":"welcome","vip":' + vip + ',"vipStr":"' + vipStr(vip) + '","mask":"' + MASK + '","token":"' + token + '","bundle":1}';
    conn.push({ k: 'text', data: utf8(welcome) });
    if (peer.hello) {
      const list = this.listFor(m, peer);
      this.send(peer, { k: 'text', data: list });
    }
    if (slot(vip) !== null) this.table.set(vip, peer);
    this.publish(m);
    if (old) old.conn.terminate();
    this.peersChanged(m, vip, false);
    this.persist(m);
    return [peer, m.peers.size];
  },

  /** members.rs closed: the 'close' of a connection */
  closed(conn, ctx) {
    this.leaveGroup(false, ctx.group);
    if (ctx.site) this.leaveGroup(true, ctx.site);
    const peer = conn.peer;
    conn.peer = null;
    if (!peer) {
      this.leftLine(conn);
      return;
    }
    this.streams.remove(conn.id);
    conn.streaming = false;
    const vip = peer.vip;
    const m = this.members;
    if (m.peers.get(vip) !== peer) return;
    m.peers.delete(vip);
    m.lan.swapRemove(vip);
    if (slot(vip) !== null) this.table.delete(vip);
    this.publish(m);
    if (conn.letGo()) this.stats.released++;
    else this.reserve(m, vip, peer);
    this.persist(m);
    this.peersChanged(m, vip, true);
    const count = m.peers.size;
    for (const h of [this.online, this.roam]) if (h) this._post(() => h.peerGone(vip, this.now));
    if (this.gone.length >= GONE_MAX) this.gone.shift();
    this.gone.push(peer.who('', this.now));
    if (this.impair) this.impair.forget(vip);
    if (ctx.onLeave) ctx.onLeave(vip, peer.name(), count);
    this.letIn();
  },

  publish(m) {
    this.all = [...m.peers.values()];
    this.publishLan(m);
  },

  publishLan(m) {
    this.lanAll = m.lan.values();
  },

  /** members.rs set_lan */
  setLan(peer, on) {
    const m = this.members;
    peer.lan = on;
    this.lanChanged(m, peer);
    if (m.peers.get(peer.vip) !== peer || !peer.hello) return;
    if (!on) {
      peer.listed = false;
    } else if (!peer.listed) {
      peer.listed = true;
      const list = this.peerList(m);
      this.send(peer, { k: 'text', data: list });
    }
  },

  listFor(m, peer) {
    const all = peer.lan;
    peer.listed = all;
    return all ? this.peerList(m) : this.hostsList();
  },

  lanChanged(m, peer) {
    const vip = peer.vip;
    if (m.peers.get(vip) !== peer) return;
    const want = peer.lan;
    if (want === m.lan.has(vip)) return;
    if (want) m.lan.set(vip, peer);
    else m.lan.swapRemove(vip);
    this.publishLan(m);
  },

  /** members.rs expire: the reservations past their time go; whether any went */
  expire(m) {
    const now = this.now;
    const before = m.reserved.size;
    const lapsed = [];
    for (const [v, r] of m.reserved) {
      if (r.until > now) continue;
      if (r.group === null) lapsed.push(v);
      m.reserved.delete(v);
    }
    for (const vip of lapsed) for (const h of [this.online, this.roam]) if (h) this._post(() => h.peerGone(vip, this.now));
    return m.reserved.size !== before;
  },

  /** members.rs reserve */
  reserve(m, vip, peer) {
    const now = this.now;
    const group = peer.group.id;
    const site = peer.site ? peer.site.id : null;
    m.reserved.set(vip, { hash: peer.tokenHash, until: now + this.o.reserveMs, group, site });
    const trim = (bySite, id, max) => {
      const mine = [];
      for (const [v, r] of m.reserved) {
        if (r.until > now && (bySite ? r.site === id : r.group === id)) mine.push([v, r.until]);
      }
      // a stable sort: equal times stay in the order of reserved
      mine.sort((a, b) => a[1] - b[1]);
      for (const [v] of mine.slice(0, Math.max(0, mine.length - max))) {
        m.reserved.delete(v);
        this.stats.evicted++;
      }
    };
    trim(false, group, this.o.groupReserve);
    if (site !== null) trim(true, site, this.o.siteReserve);
  },

  peerList(m) {
    return this.listOf([...m.peers.values()]);
  },

  hostsList() {
    return this.listOf([]);
  },

  listOf(peers) {
    let s = '{"t":"peers","peers":[';
    let first = true;
    for (const p of peers) {
      if (!first) s += ',';
      first = false;
      s += entry(p.vip, p.name());
    }
    for (const h of [this.online, this.roam]) {
      if (h && h.listed()) {
        if (!first) s += ',';
        first = false;
        s += entry(h.vip >>> 0, h.name).slice(0, -1) + ',"server":true}';
      }
    }
    s += ']}';
    return utf8(s);
  },

  /** vip joined, got its name or left; everyone hears of it peers_ms later */
  peersChanged(m, vip, left) {
    m.changed.add(vip);
    if (left) m.left.add(vip);
    if (!m.deltaArmed) {
      m.deltaArmed = true;
      this.after(this.o.peersMs, () => this.sendDelta());
    }
  },

  /** a timer of the switch's (ended by stop()) */
  after(ms, f) {
    this._after(ms, () => {
      if (!this.stopped) f();
    });
  },

  sendDelta() {
    const m = this.members;
    m.deltaArmed = false;
    let s = '{"t":"delta","peers":[';
    let first = true;
    for (const v of m.changed) {
      const p = m.peers.get(v);
      if (p) {
        if (!first) s += ',';
        first = false;
        s += entry(p.vip, p.name());
      }
    }
    s += '],"gone":[' + [...m.left].join(',') + ']}';
    m.changed.clear();
    m.left.clear();
    const msg = utf8(s);
    for (const p of m.peers.values()) {
      if (p.listed && p.open()) this.send(p, { k: 'text', data: msg });
    }
  },

  /** a hello, the connection's first (later ones change nothing) */
  hello(peer, msg) {
    const m = this.members;
    if (peer.hello) return;
    const was = peer.name();
    greet(peer, msg, this.o.fpred, this.o.probeEcho);
    this.handHub(peer, msg);
    this.lanChanged(m, peer);
    const list = this.listFor(m, peer);
    this.send(peer, { k: 'text', data: list });
    if (peer.name() !== was) this.peersChanged(m, peer.vip, false);
  },

  handHub(peer, hello) {
    const h = this.roam;
    if (!h) return;
    const vip = peer.vip, name = peer.name();
    if (h.pageName) this._post(() => h.pageName(vip, name, this.now));
    const names = blockNames(hello);
    if (names.length && h.blocks) this._post(() => h.blocks(vip, names, this.now));
  },

  /** the store gets the addresses held and reserved, shortly after a change */
  persist(m) {
    if (!this.store || m.saveArmed) return;
    m.saveArmed = true;
    const era = m.saveGen;
    // after_always: stop() does not end it
    this._after(500, () => {
      if (this.members.saveGen === era) this.flush(false);
    });
  },

  flush(_now) {
    if (!this.store) return;
    const m = this.members;
    m.saveArmed = false;
    m.saveGen++;
    m.saveSeq++;
    const seq = m.saveSeq;
    const list = storeList(m, this.now);
    const p = store.save(this.storage, seq, list);
    if (p && typeof p.catch === 'function') p.catch((e) => console.error('[lan] store: ' + e));
  },

  flushNow() {
    this.flush(true);
  },
};

export function installMembers(C) {
  Object.assign(C.prototype, M);
}

/** members.rs store_list: the addresses held, then the ones reserved, each with its token's hash */
export function storeList(m, now) {
  const e = [];
  for (const p of m.peers.values()) e.push([p.vip, p.tokenHash]);
  for (const [v, r] of m.reserved) if (r.until > now && !m.peers.has(v)) e.push([v, r.hash]);
  return store.storeList(e);
}

/** members.rs held_address: the address a hello's token held, and the connection it replaces; [0, null] for none */
export function heldAddress(m, hello, now) {
  if (!hello || typeof hello.token !== 'string') return [0, null];
  const tok = hello.token;
  const w = vipNum(jsString(hello.vip));
  const h = m.peers.get(w);
  if (!h) {
    const r = m.reserved.get(w);
    if (r && r.until > now && tokenFits(tok, r.hash)) return [w, null];
    return [0, null];
  }
  if (tokenFits(tok, h.tokenHash)) return [w, h];
  return [0, null];
}

/** {"vip":N,"name":"..."} */
function entry(vip, name) {
  return '{"vip":' + vip + ',"name":' + JSON.stringify(name) + '}';
}

/** a full switch's answer */
export function lanFull() {
  return closePayload(1013, 'LAN full');
}

const BLOCK_MAX = 32;
/** members.rs block_names */
export function blockNames(m) {
  if (!Array.isArray(m.block)) return [];
  const out = [];
  for (const v of m.block) {
    if (typeof v !== 'string') continue;
    let s = '';
    let n = 0;
    for (const c of v) {
      if (n >= 24) break;
      if (c >= ' ' && c <= '~') {
        s += c;
        n++;
      }
    }
    s = rustTrim(s);
    if (!s) continue;
    out.push(s);
    if (out.length >= BLOCK_MAX) break;
  }
  return out;
}

/** str::trim on printable ASCII: spaces only (the only whitespace left) */
function rustTrim(s) {
  return s.replace(/^ +| +$/g, '');
}

/** members.rs greet: a connection's first hello */
export function greet(peer, m, fp, echo) {
  const isNum = (v) => json.isNum(v, 1);
  peer.hello = true;
  peer.bundle = isNum(m.bundle);
  let c = !isNum(m.compact) ? PLAIN : !isNum(m.delta) ? COMPACT : !isNum(m.fpred) ? DELTAS : FPRED;
  if (c === FPRED && !fp) c = DELTAS;
  if (c >= DELTAS && isNum(m.ldelta)) c |= OTHERS;
  peer.conn.compact = c;
  peer.conn.echo = echo && c !== PLAIN && isNum(m.echo);
  peer.lan = isNum(m.lan);
  peer.udp = udpOf(m.udp);
  if (typeof m.name === 'string' && peer.nameSet === null) peer.nameSet = cleanName(m.name);
}

