// The virtual LAN switch, sans-IO: crates/lan/src/lib.rs (the crate doc there is the protocol's reference).  One
// instance holds every /lan connection (the Durable Object feeds it); time comes in as nowMs with every call and
// randomness from the injected Prng.  What the Rust switch did on threads and tokio tasks runs here as steps of one
// event loop: an input (a message, a timer) is handled at once, then the hosts' mailboxes are drained, then the
// connections that ended run their close logic, then the writers that were woken write (settle()).

import { Conn, Clock, encode, closePayload, PLAIN, DELTAS, FPRED, OTHERS } from './conn.js';
import { saneOptions, bundleTickUs } from './options.js';
import { Timers } from './timers.js';
import { Bucket } from '../util/bucket.js';
import * as compact from './compact.js';
import * as fpred from './fpred.js';
import * as mix from './mix.js';
import * as lag from './lag.js';
import * as paths from './paths.js';
import { Impair } from './impair.js';
import { cleanName, vipNum } from './text.js';
import { installMembers, Members } from './members.js';
import { installRoute, Streams } from './route.js';
import { installReader } from './reader.js';
import { installQueue } from './queue.js';
import * as store from './store.js';
import * as json from '../util/json.js';

export { cleanName, vipNum };

export const MASK = '255.255.128.0';
export const NETS = 96;
export const ADDRS = NETS * 250;
export const BROADCAST = 0xffffffff;
export const CLOSE_KICKED = 4001;
export const CLOSE_BANNED = 4003;
export const CLOSE_RENAME = 4004;
const ROAM_DUEL = 9;
const ROAM_LOBBY = 12;
export const ROAM_LOBBIES = 13;
export const WAS_MAX = 4;
const GONE_MS = 60 * 60_000;
const GONE_MAX = 2000;
export const BASE = ((10 << 24) | (77 << 16)) >>> 0;
export const KIND_UDP = 1;
export const KIND_LAN_UDP = 3;
export const KIND_STREAM = 4;
export const KIND_LAN_ICMP = 5;
export { KIND_BUNDLE } from './conn.js';
export const UDP_SET = 0x80000000;
export const STREAM_LOW = 64 << 10;
export const BEHIND_MS = 1000.0;
const PROBE_ROAM_MS = 5000.0;
const PROBE_OTHERS = 10;
export const MSG_KINDS = ['racing or in a race lobby', 'in Online mode', 'on the LAN or Online screens', 'driving in free roam',
  'in free roam, not driving', 'leaving or starting'];
export const CUT = { Flood: 0, Slow: 1, Queue: 2, Dead: 3, Idle: 4, Hog: 5, Stall: 6 };
const CUT_NAMES = ['flood', 'slow', 'queue', 'dead', 'idle', 'hog', 'stall'];

const N2FR = [0x4e, 0x32, 0x46, 0x52];

/** lib.rs roam_type: a free-roam datagram's type, or null */
export function roamType(d) {
  return d.length > 21 && d[0] === KIND_UDP && d[16] === N2FR[0] && d[17] === N2FR[1] && d[18] === N2FR[2] && d[19] === N2FR[3] ? d[21] : null;
}

/** lib.rs races: a frame that races another player */
export function races(d) {
  if (d[0] >= KIND_LAN_UDP && d[0] <= KIND_LAN_ICMP) return true;
  const t = roamType(d);
  return t === ROAM_DUEL || t === ROAM_LOBBY;
}

/** lib.rs udp_of: a hello's or {"t":"lan"}'s "udp" */
export function udpOf(v) {
  const m = v === undefined ? null : json.safeInteger(v);
  if (m === null || m === undefined || m < 0 || m > 0xffffffff) return 0;
  return (m & UDP_SET) !== 0 ? m >>> 0 : 0;
}

/** lib.rs slot: the table's index of an address the switch hands out, or null */
export function slot(vip) {
  vip >>>= 0;
  const host = vip & 255;
  const net = (vip >>> 8) & 255;
  if (((vip & 0xffff0000) >>> 0) !== BASE || net >= NETS || host < 2 || host > 251) return null;
  return net + NETS * (host - 2);
}

/** lib.rs vip_at: the i-th address in the order they are handed out */
export function vipAt(i) {
  return (BASE | ((i % NETS) << 8) | (Math.floor(i / NETS) + 2)) >>> 0;
}

/** nfsu2_util::vip_str */
export function vipStr(v) {
  return ((v >>> 24) & 255) + '.' + ((v >>> 16) & 255) + '.' + ((v >>> 8) & 255) + '.' + (v & 255);
}

function be32(b, at) {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}
export { be32 };

const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(s);

/** a token bucket at now (Bucket::new_at) */
export function bucketAt(rate, now) {
  return Bucket.newAt ? Bucket.newAt(rate, now) : new Bucket(rate, now);
}

/** lib.rs Stats: the switch's counts */
export class Stats {
  constructor() {
    for (const k of ['frames', 'bytes', 'dropped', 'limited', 'refused', 'shed', 'thinned', 'echoes', 'bcastSkipped',
      'bcastSkippedBytes', 'bundlesIn', 'bundlesOut', 'resumed', 'released', 'evicted', 'lost', 'queued', 'rejoined',
      'lineIn', 'lineLeft', 'snapBytes', 'snapEntries', 'fpredEntries', 'otherBytes', 'otherEntries']) this[k] = 0;
    this.cuts = new Array(7).fill(0);
    this.mix = new Array(2 * mix.KINDS).fill(0);
    this.mixIn = new Array(2 * mix.KINDS).fill(0);
    this.msgs = new Array(mix.MSGS).fill(0);
  }
  entryIn(k, n) {
    this.mixIn[k] += n;
    this.mixIn[mix.KINDS + k] += 1;
  }
  msg(t) {
    this.msgs[t] += 1;
  }
  entryOut(data, src, dst, e) {
    const k = mix.ofEntry(data, src, dst);
    this.mix[k] += e.length;
    this.mix[mix.KINDS + k] += 1;
    if (data.length > 16 + 5 && data[1] === compact.ROAM_OK && data[16 + 5] === 3) {
      this.snapBytes += e.length;
      this.snapEntries++;
      if (e.length > 0 && e[0] === fpred.F_FPRED) this.fpredEntries++;
    } else {
      this.otherBytes += e.length;
      this.otherEntries++;
    }
  }
  cut(why) {
    this.cuts[why]++;
  }
}

/** lib.rs Pair: a token bucket pair, frames and bytes a second */
export class Pair {
  constructor(frameRate, byteRate, now) {
    this.frames = bucketAt(frameRate, now);
    this.bytes = bucketAt(byteRate, now);
  }
  refill(now) {
    this.frames.hasAt(now, 0);
    this.bytes.hasAt(now, 0);
    return [this.frames.v, this.bytes.v];
  }
  spendPaid(f, b) {
    this.frames.v -= f;
    this.bytes.v -= b;
  }
  spend(now, f, b) {
    const a = this.frames.spendAt(now, f);
    const c = this.bytes.spendAt(now, b);
    return a && c;
  }
}

/** lib.rs Peer: a player on the switch, one connection holding one address */
export class Peer {
  constructor(f) {
    Object.assign(this, f);
  }
  name() {
    return this.nameSet ?? 'player';
  }
  lanOn() {
    return this.lan;
  }
  /** a LAN broadcast to port is for it */
  takesUdp(port) {
    const m = this.udp;
    return (m & UDP_SET) === 0 || (m & (1 << (port % 31))) !== 0;
  }
  open() {
    return this.conn.open();
  }
  takesBundles() {
    return this.bundle;
  }
  who(doing, left) {
    return { vip: this.vip, name: this.name(), ident: this.ident, browser: this.conn.browser, owner: this.conn.owner,
      since: this.since, left, doing, game: [] };
  }
}

/** the sender's buckets while the Online host handles its frame (lib.rs Cause, nfsu2_util::Charge) */
class Cause {
  constructor(sw, peer) {
    this.sw = sw;
    this.peer = peer;
    this.over = false;
    this.counted = false;
  }
  spend(frames, bytes) {
    const now = this.sw.mono();
    let ok = this.peer.buckets.spend(now, frames, bytes);
    ok = this.peer.group.buckets.spend(now, frames, bytes) && ok;
    if (this.peer.site) ok = this.peer.site.buckets.spend(now, frames, bytes) && ok;
    if (!ok) this.over = true;
  }
  overspent() {
    if (this.over && !this.counted) {
      this.counted = true;
      this.sw.stats.limited++;
    }
    return this.over;
  }
}
export { Cause };

/**
 * The switch.
 *
 * transport: what carries the connections' messages (the Durable Object's WebSockets, the simulator's network):
 *   write(conn, msgs, bytes) -> bytes taken now (the rest the transport reports later with sw.drained(conn, n, nowMs));
 *     msgs: [{op:'text'|'binary'|'ping'|'pong'|'close', data:Uint8Array}]
 *   end(conn): the writer ended its half after the close frames (ws socket.end())
 *   kill(conn): the connection goes at once without a close frame (ws terminate())
 */
export class LanSwitch {
  /**
   * @param {{options?:object, prng:any, nowMs:number, transport:any, impair?:string, hosts?:{online?:Function, roam?:Function},
   *   hostOptions?:{online?:any, roam?:any}, storage?:any (the switch's own store: get/put, may be async),
   *   hostStorage?:any (the hosts': synchronous get/put/delete/list(prefix)), stored?:[number, Uint8Array][], tap?:Function, onText?:Function, onLine?:Function}} a
   */
  constructor(a) {
    const o = saneOptions(a.options ?? {});
    this.o = o;
    this.prng = a.prng;
    if (!this.prng) throw new Error('LanSwitch needs a prng');
    this.now = a.nowMs;
    this.start = a.nowMs;
    /** lag.rs pick's xorshift (Rust: one per thread, seeded from the OS) */
    this.pickRng = lag.PickRng.fromPrng(this.prng);
    this.transport = a.transport;
    this.timers = new Timers();
    this.stopped = false;
    this.stats = new Stats();
    this.impair = a.impair ? Impair.parse(a.impair, this.prng) : null;
    this.tap = a.tap ?? null;
    this.storage = a.storage ?? null;
    this.store = a.storage ? true : null;
    this.members = new Members();
    if (this.store && a.stored) {
      const until = this.now + o.reserveMs;
      for (const [v, hash] of a.stored) this.members.reserved.set(v >>> 0, { hash, until, group: null, site: null });
    }
    /** vip -> Peer (the Rust table of 24000 slots) */
    this.table = new Map();
    this.all = [];
    this.lanAll = [];
    this.streams = new Streams();
    this.groups = new Map();
    this.sites = new Map();
    this.anon = 0;
    this.probes = 0;
    this.connIds = 0;
    this.gone = [];
    this._onText = a.onText ?? null;
    this._onLine = a.onLine ?? null;
    /** the sans-IO loop's work lists */
    this.woken = new Set();
    this.finishing = new Set();
    this.mail = [];
    this.depth = 0;
    this.clock = o.bundleMs > 0 ? new Clock(this, o.bundleMs, o.bundleJitter, 0) : null;
    this.slow = o.bundleMs > 0 && o.awayMs > o.bundleMs ? new Clock(this, o.awayMs, o.bundleJitter, 1) : null;
    this.lanClock = o.bundleMs > 0 && o.lanMs > 0 ? new Clock(this, o.lanMs, 0, 2) : null;
    // the hosts, constructed with the switch's way to the browsers
    const sw = this.switchSend();
    const mk = (f, opts) => (f ? f({ sw, prng: this.prng, storage: a.hostStorage ?? a.storage ?? null, nowMs: this.now, options: opts ?? {} }) : null);
    this.online = mk(a.hosts?.online, a.hostOptions?.online);
    this.roam = mk(a.hosts?.roam, a.hostOptions?.roam);
    this.onlineVip = this.online ? this.online.vip >>> 0 : null;
    this.roamVip = this.roam ? this.roam.vip >>> 0 : null;
    this.startTimers();
  }

  // ---- the sans-IO plumbing ----

  /** run fn as one step at now, then settle what it set going */
  _step(now, fn) {
    if (now !== undefined) {
      if (!Number.isFinite(now)) throw new Error('nowMs ' + now);
      if (now > this.now) this.now = now;
    }
    this.depth++;
    let r;
    try {
      r = fn();
    } finally {
      this.depth--;
    }
    if (this.depth === 0) this._settle();
    return r;
  }

  _settle() {
    this.depth++;
    try {
      for (let guard = 0; ; guard++) {
        if (guard > 10_000_000) throw new Error('switch did not settle');
        if (this.mail.length) {
          const m = this.mail;
          this.mail = [];
          for (const f of m) f();
          continue;
        }
        if (this.finishing.size) {
          const [c] = this.finishing;
          this.finishing.delete(c);
          this._finish(c);
          continue;
        }
        if (this.woken.size) {
          const [c] = this.woken;
          this.woken.delete(c);
          this._write(c);
          continue;
        }
        break;
      }
    } finally {
      this.depth--;
    }
  }

  /** performance.now() of the Rust switch (mono_ms): ms since the switch started; this.now is Date.now() (now_ms) */
  mono() {
    return this.now - this.start;
  }

  _nowUs() {
    return Math.floor((this.now - this.start) * 1000) >>> 0;
  }

  _after(ms, fn) {
    return this.timers.at(this.now + ms, fn);
  }

  _wake(conn) {
    if (!conn.w.done) this.woken.add(conn);
  }

  _killed(conn) {
    this.finishing.add(conn);
  }

  /** post to a host's mailbox (Rust posted to the host's thread) */
  _post(f) {
    this.mail.push(f);
  }

  /** conn.rs run's end: the reader is over (killed, or the socket went): end, stop the writer, the close logic */
  _finish(conn) {
    if (conn.rd.done) return;
    conn.rd.done = true;
    const wasLive = !conn.socketGone && !conn.w.done;
    conn.end();
    conn.w.done = true;
    this.woken.delete(conn);
    if (wasLive && this.transport.kill) this.transport.kill(conn);
    if (this.transport.finished) this.transport.finished(conn);
    this.closed(conn, conn.ctx);
  }

  /** conn.rs write_loop: everything queued at once into one write, until the queue is empty or the transport is full */
  _write(conn) {
    const w = conn.w;
    for (let guard = 0; guard < 1_000_000; guard++) {
      if (w.done || w.busy) return;
      if (conn.q.length === 0) return;
      const items = conn.q;
      conn.q = [];
      conn.dgram = 0;
      const m = conn.compact;
      const mode = m & ~OTHERS, others = (m & OTHERS) !== 0;
      let stamp = null;
      if (mode !== PLAIN && conn.stamp && items.some((it) => it.k === 'dgram')) {
        conn.stamp = false;
        if (conn.peer) stamp = conn.peer.probe.ping(this.mono(), this.prng);
      }
      const c = mode !== PLAIN
        ? { own: conn.vip, refs: mode >= DELTAS ? w.refs : null, fp: mode === FPRED ? w.fp : null, others: others && mode >= DELTAS, body: w.body, stamp, nowUs: this._nowUs() }
        : null;
      const msgs = [];
      const e = encode(this.stats, items, msgs, w, c);
      let total = 0;
      for (const x of msgs) total += (x.data.length < 126 ? 2 : x.data.length < 65536 ? 4 : 10) + x.data.length;
      if (total > 0) this.stats.msg(mix.OUT_WRITES);
      conn.msgsOut += e.msgs;
      conn.buffered += e.extra;
      const finish = () => {
        conn.buffered -= e.counted + e.extra - total;
        if (e.end || (e.close && conn.closeSent())) {
          w.done = true;
          if (this.transport.end) this.transport.end(conn);
          return false;
        }
        if (conn.streaming) this.pump(conn);
        return true;
      };
      if (total > 0) {
        const took = this.transport.write(conn, msgs, total);
        if (!(took >= 0 && took <= total)) throw new Error('transport took ' + took + ' of ' + total);
        conn.buffered -= took;
        if (took < total) {
          w.busy = true;
          w.pending = total - took;
          w.finish = finish;
          return;
        }
      }
      if (!finish()) return;
    }
    throw new Error('writer did not end');
  }

  /** the transport took n more bytes of what the writer gave it */
  drained(conn, n, nowMs) {
    this._step(nowMs, () => {
      const w = conn.w;
      if (!w.busy) return;
      const k = Math.min(n, w.pending);
      conn.buffered -= k;
      w.pending -= k;
      if (w.pending === 0) {
        w.busy = false;
        const f = w.finish;
        w.finish = null;
        if (f()) this._wake(conn);
      }
    });
  }

  /** every timer due by nowMs (the switch's, the clocks', the impairment's, the hosts'), in time order */
  tick(nowMs) {
    if (nowMs > this.now) {
      // each timer runs at its own time, as tokio's did
      for (let guard = 0; guard < 10_000_000; guard++) {
        const t = Math.min(this.timers.next(), this._hostsNext(), this.impair ? this.impair.nextDueMs() : Infinity);
        if (t > nowMs) break;
        this._step(Math.max(t, this.now), () => this._runDue(this.now));
      }
      this._step(nowMs, () => this._runDue(nowMs));
    } else {
      this._step(nowMs, () => this._runDue(this.now));
    }
  }

  _runDue(now) {
    for (let t = this.timers.take(now), n = 0; t; t = this.timers.take(now), n++) {
      if (n > 1_000_000) throw new Error('timers did not end');
      if (t.live) t.fn();
    }
    if (this.impair) {
      for (const d of this.impair.due(now)) {
        this.deliverNow(d.from, d.to, d.data, d.dst);
      }
    }
    for (const h of [this.online, this.roam]) {
      if (h && h.nextTickMs() <= now) this._post(() => h.tick(this.now));
    }
  }

  _hostsNext() {
    let t = Infinity;
    for (const h of [this.online, this.roam]) if (h) t = Math.min(t, h.nextTickMs());
    return t;
  }

  /** when tick() should next run (absolute ms; Infinity: nothing waits) */
  nextWakeMs() {
    return Math.min(this.timers.next(), this._hostsNext(), this.impair ? this.impair.nextDueMs() : Infinity);
  }

  // ---- lib.rs ----

  startTimers() {
    const o = this.o;
    const every = (first, period, fn) => {
      let next = first;
      const run = () => {
        if (this.stopped) return;
        fn();
        // MissedTickBehavior::Delay: the next one a period after this one ran
        next = Math.max(next + period, this.now);
        this.timers.at(next, run);
      };
      this.timers.at(next, run);
    };
    every(this.now + o.keepaliveMs, o.keepaliveMs, () => this.keepalive());
    every(this.now, 1000, () => this.lineTick());
    if (o.probeMs > 0) every(this.now + o.probeMs, o.probeMs, () => this.probe());
    if (this.slow) this.slow.start(this.now);
    if (this.lanClock) this.lanClock.start(this.now);
    if (this.clock) {
      this.clock.start(this.now);
      if (o.bundleMaxMs > o.bundleMs) {
        every(this.now, 1000, () => {
          const n = this.all.filter((p) => p.takesBundles() && p.open()).length;
          this.clock.setPeriod(bundleTickUs(this.o, n));
        });
      }
    }
  }

  /**
   * A new connection (its WebSocket accepted already).  opts: AttachOpts {resume, queue, group, site, onJoin, onLeave,
   * ident, refuse (control message text or bytes), onHello, onClaim, country}.  Returns the Conn the transport keys on;
   * bind(conn), when given, is called with it before anything is sent to it (its welcome goes at once).
   */
  attach(opts, nowMs, bind) {
    return this._step(nowMs, () => {
      const group = this.joinGroup(false, opts.group ?? null);
      const site = opts.site != null ? this.joinGroup(true, opts.site) : null;
      const ctx = {
        resume: !!opts.resume, queue: !!opts.queue, group, site, onJoin: opts.onJoin ?? null, onLeave: opts.onLeave ?? null,
        ident: opts.ident ?? null, onHello: opts.onHello ?? null, onClaim: opts.onClaim ?? null,
        country: opts.country ? paths.code([opts.country.charCodeAt(0), opts.country.charCodeAt(1)]) : 0,
      };
      const conn = new Conn(this.connIds++, this);
      conn.ctx = ctx;
      if (bind) bind(conn);
      if (opts.refuse != null) {
        this.expelConn(conn, typeof opts.refuse === 'string' ? utf8(opts.refuse) : opts.refuse, CLOSE_BANNED);
      } else if (!ctx.resume) {
        this.admit(conn, ctx, null);
      }
      this.readerStart(conn, ctx);
      return conn;
    });
  }

  joinGroup(site, id) {
    const key = id != null ? String(id) : '#' + ++this.anon;
    const [map, fr, br] = site ? [this.sites, this.o.siteFrameRate, this.o.siteByteRate] : [this.groups, this.o.groupFrameRate, this.o.groupByteRate];
    let e = map.get(key);
    if (!e) {
      e = { g: { id: key, buckets: new Pair(fr, br, this.mono()) }, n: 0 };
      map.set(key, e);
    }
    e.n++;
    return e.g;
  }

  leaveGroup(site, g) {
    const m = site ? this.sites : this.groups;
    const e = m.get(g.id);
    if (e && e.g === g) {
      e.n = Math.max(0, e.n - 1);
      if (e.n === 0) m.delete(g.id);
    }
  }

  _peerAt(vip) {
    if (slot(vip) === null) return null;
    return this.table.get(vip >>> 0) ?? null;
  }

  /** a host's frame to one browser, charged to cause when given: 'sent' | 'full' | 'gone' */
  sendTo(vip, data, cause) {
    vip >>>= 0;
    const p = this._peerAt(vip);
    if (!p || !p.open()) {
      this.stats.dropped++;
      return 'gone';
    }
    if (p.conn.buffered + p.conn.dgram > this.o.onlineQueue) {
      this.stats.shed++;
      return 'full';
    }
    if (p.conn.noRaces && roamType(data) === ROAM_LOBBIES) return 'sent';
    if (cause) cause.spend(1, data.length);
    const src = data.length >= 16 && data[0] === KIND_UDP ? be32(data, 4) : null;
    if (src !== null && src === this.roamVip && p.takesBundles()) {
      if (!this.room(p, CUT.Slow)) {
        this.stats.dropped++;
        return 'full';
      }
      p.conn.pushDgram(compact.mark(data), src, vip, this.clock);
      p.framesOut++;
      return 'sent';
    }
    const k = mix.ofHost(data, this.roamVip, this.onlineVip);
    const n = data.length;
    if (!this.send(p, { k: 'raw', data })) return 'full';
    this.stats.mix[k] += n;
    this.stats.mix[mix.KINDS + k] += 1;
    p.framesOut++;
    return 'sent';
  }

  /** send_to as the object the hosts take: sw.send(vip, frame, cause) */
  switchSend() {
    return {
      send: (vip, data, cause) => (this.depth > 0 ? this.sendTo(vip, data, cause ?? null) : this._step(undefined, () => this.sendTo(vip, data, cause ?? null))),
      sendText: (vip, msg) => this.sendText(vip, msg),
      vipsOfOwner: (owner) => this.vipsOfOwner(owner),
    };
  }

  peerCount() {
    return this.all.length;
  }

  /** a newcomer would wait in line (or get "LAN full") now */
  full() {
    return this.members.line.beforeNewcomers() || this.members.full(this.o.maxPeers, this.now);
  }

  waiting() {
    return this.members.line.len();
  }

  messagesByKind() {
    const online = this.online ? this.online.vips() : new Set();
    const roam = this.roam ? this.roam.vips() : new Set();
    const out = MSG_KINDS.map((kind) => ({ kind, players: 0, msgsIn: 0, msgsOut: 0 }));
    for (const p of this.all) {
      const c = p.conn;
      const raced = c.lanSent > 0, i = c.msgsIn, o = c.msgsOut;
      c.lanSent = 0; c.msgsIn = 0; c.msgsOut = 0;
      const k = raced ? 0 : online.has(p.vip) ? 1 : p.lan ? 2 : roam.has(p.vip) ? (p.away ? 4 : 3) : 5;
      out[k].players++;
      out[k].msgsIn += i;
      out[k].msgsOut += o;
    }
    return out;
  }

  breakdown() {
    const online = this.online ? this.online.vips() : new Set();
    const roam = this.roam ? this.roam.vips() : new Set();
    const now = this.mono();
    const n = { players: this.all.length, online: 0, lan: 0, roam: 0, other: 0, behind: 0, thinning: 0, away: 0 };
    for (const p of this.all) {
      if (p.away && !online.has(p.vip) && !p.lan) n.away++;
      if (online.has(p.vip)) n.online++;
      else if (p.lan) n.lan++;
      else if (roam.has(p.vip)) n.roam++;
      else n.other++;
      if (p.probe.lag(now) > BEHIND_MS) n.behind++;
      if (p.share.v < lag.SHARE_FULL) n.thinning++;
    }
    const s = this.stats;
    Object.assign(n, { thinned: s.thinned, bcastSkipped: s.bcastSkipped, bcastSkippedBytes: s.bcastSkippedBytes,
      snapBytes: s.snapBytes, snapEntries: s.snapEntries, fpredEntries: s.fpredEntries, otherBytes: s.otherBytes,
      otherEntries: s.otherEntries, mix: s.mix.slice(), mixIn: s.mixIn.slice(), msgs: s.msgs.slice() });
    [n.waiting, n.waited] = this.lineView();
    return n;
  }

  paths() {
    const roam = this.roam && this.roam.linkPairs ? this.roam.linkPairs() : [];
    const seen = [], lan = [], to = [];
    for (const p of this.all) {
      seen.push(new paths.Seen(p.vip, p.country, p.probe.base()));
      paths.take(p.lanTo, to);
      for (const d of to.splice(0)) if (d !== p.vip) lan.push([Math.min(p.vip, d), Math.max(p.vip, d)]);
    }
    lan.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const dedup = lan.filter((x, i) => i === 0 || x[0] !== lan[i - 1][0] || x[1] !== lan[i - 1][1]);
    return paths.lines(seen, roam, dedup);
  }

  who() {
    const online = this.online ? this.online.vips() : new Set();
    let roam = new Set(), game = new Map();
    if (this.roam) {
      roam = this.roam.vips();
      game = this.roam.otherNames ? this.roam.otherNames() : new Map();
    }
    const v = this.all.map((p) => {
      const doing = online.has(p.vip) ? 'Online' : p.lan ? 'LAN screens' : roam.has(p.vip) ? 'free roam' : '';
      const w = p.who(doing, null);
      w.game = game.get(p.vip) ?? [];
      game.delete(p.vip);
      return w;
    });
    const now = this.now;
    while (this.gone.length && this.gone[0].left !== null && now - this.gone[0].left > GONE_MS) this.gone.shift();
    return v.concat(this.gone.map((w) => ({ ...w })));
  }

  whoAt(vip) {
    const p = this._peerAt(vip);
    const v = p ? [p.who('', null)] : [];
    const now = this.now;
    for (let i = this.gone.length - 1; i >= 0; i--) {
      const w = this.gone[i];
      if (w.vip === vip && w.left !== null && now - w.left <= GONE_MS) v.push({ ...w });
    }
    return v;
  }

  onLine(f) {
    if (!this._onLine) this._onLine = f;
  }
  line(s) {
    if (this._onLine) this._onLine(s);
  }
  onText(f) {
    if (!this._onText) this._onText = f;
  }
  pageText(peer, m) {
    if (this._onText) this._onText(peer.vip, peer.conn.owner, peer.group.id, m);
  }

  /** a control message to the page at vip, when it is there and has room */
  sendText(vip, msg, nowMs) {
    return this._step(nowMs, () => {
      const p = this._peerAt(vip);
      if (!p || !p.open()) return false;
      return this.send(p, { k: 'text', data: typeof msg === 'string' ? utf8(msg) : msg });
    });
  }

  vipsOfOwner(owner) {
    const v = [];
    for (const p of this.table.values()) if (p.open() && p.conn.owner === owner) v.push(p.vip);
    return v.sort((a, b) => slot(a) - slot(b));
  }

  /** the operator removes the player at vip: msg, then the close with code */
  expel(vip, msg, code, nowMs) {
    return this._step(nowMs, () => {
      const p = this._peerAt(vip);
      if (!p || !p.open()) return false;
      this.expelConn(p.conn, typeof msg === 'string' ? utf8(msg) : msg, code);
      return true;
    });
  }

  expelConn(conn, msg, code) {
    conn.expelled = true;
    conn.push({ k: 'text', data: msg });
    const reason = code === CLOSE_KICKED ? 'kicked' : code === CLOSE_RENAME ? 'rename' : 'banned';
    conn.close(closePayload(code, reason));
  }

  setRaces(vip, off, msg, nowMs) {
    return this._step(nowMs, () => {
      const p = this._peerAt(vip);
      if (!p || !p.open()) return false;
      p.conn.noRaces = off;
      this.send(p, { k: 'text', data: typeof msg === 'string' ? utf8(msg) : msg });
      return true;
    });
  }

  /** the switch's counts and its players, as JSON */
  info() {
    const s = this.stats;
    const m = {};
    m.peers = this.all.map((p) => ({ vip: vipStr(p.vip), name: p.name(), framesIn: p.framesIn, framesOut: p.framesOut }));
    for (const k of ['frames', 'bytes', 'dropped', 'limited', 'refused', 'shed', 'thinned', 'echoes', 'bcastSkipped',
      'bcastSkippedBytes', 'bundlesIn', 'bundlesOut', 'snapBytes', 'snapEntries', 'fpredEntries', 'otherBytes',
      'otherEntries', 'resumed', 'released', 'queued', 'rejoined', 'lineIn', 'lineLeft']) m[k] = s[k];
    m.reserved = this.members.reserved.size;
    const kinds = {};
    for (let i = 0; i < mix.KINDS; i++) if (s.mix[mix.KINDS + i] > 0) kinds[mix.name(i)] = [s.mix[i], s.mix[mix.KINDS + i]];
    m.mix = kinds;
    m.waiting = this.members.line.len();
    m.evicted = s.evicted;
    m.cuts = {};
    CUT_NAMES.forEach((k, i) => (m.cuts[k] = s.cuts[i]));
    if (this.impair) {
      m.impair = this.impair.specJson();
      m.lost = s.lost;
    }
    if (this.online) m.online = this.online.info ? this.online.info() : null;
    if (this.roam) m.roam = this.roam.info ? this.roam.info() : null;
    return m;
  }

  /** the timers end, the store is written, the hosts stop */
  stop(nowMs) {
    this._step(nowMs, () => {
      this.stopped = true;
      this.flushNow();
      for (const h of [this.online, this.roam]) if (h && h.stop) h.stop();
    });
  }

  /** lib.rs keepalive: WebSocket pings keep proxies from cutting a quiet connection and find dead ones */
  keepalive(nowMs) {
    if (this.depth === 0) return this._step(nowMs, () => this.keepalive());
    const now = this.now;
    if (this.expire(this.members)) this.persist(this.members);
    for (const p of this.all.slice()) {
      if (!p.open() || !this.room(p, CUT.Queue)) continue;
      const alive = p.alive;
      if (!alive || now - p.lastIn > this.o.idleMs) {
        this.cut(p, alive ? CUT.Idle : CUT.Dead);
        continue;
      }
      p.alive = false;
      const mono = this.mono();
      p.probe.tick(mono);
      const data = p.probe.ping(mono, this.prng);
      p.conn.push({ k: 'ping', data });
    }
  }

  /** lib.rs probe: a ping to every player driving in free roam, to the others every PROBE_OTHERS-th time */
  probe(nowMs) {
    if (this.depth === 0) return this._step(nowMs, () => this.probe());
    const now = this.mono();
    const round = this.probes++;
    for (const p of this.all.slice()) {
      if (!p.open()) continue;
      const at = p.roamAt;
      const drives = at > 0 && now - at < PROBE_ROAM_MS && !p.away;
      if (!drives && (round + p.vip) % PROBE_OTHERS !== 0) continue;
      if (drives && p.conn.echo && !p.conn.stamp) {
        p.conn.stamp = true;
        continue;
      }
      const data = p.probe.ping(now, this.prng);
      p.conn.push({ k: 'ping', data });
    }
  }

  cut(p, why) {
    if (p.conn.terminate()) this.stats.cut(why);
  }

  room(p, why) {
    if (p.conn.buffered <= this.o.sendBuffer) return true;
    this.cut(p, why);
    return false;
  }

  send(p, out) {
    if (!this.room(p, CUT.Slow)) {
      this.stats.dropped++;
      return false;
    }
    p.conn.push(out);
    return true;
  }

  // ---- for the tests ----

  peersView() {
    return this.all.map((p) => ({ vip: p.vip, name: p.name(), hello: p.hello, bundle: p.takesBundles(), lan: p.lan,
      open: p.open(), buffered: p.conn.buffered, rtt: p.probe.rtt() }));
  }
  reservedView() {
    return [...this.members.reserved].map(([vip, r]) => ({ vip, until: r.until, group: r.group, site: r.site }));
  }
  reserveForTest(vip, hash, until, group, site) {
    this.members.reserved.set(vip >>> 0, { hash, until, group: group ?? null, site: site ?? null });
  }
  clearReserved() {
    this.members.reserved.clear();
  }
  expireReserved() {
    for (const r of this.members.reserved.values()) r.until = this.now - 1;
  }
  allocate() {
    this.expire(this.members);
    return this.members.allocate();
  }
  terminateAll(nowMs) {
    this._step(nowMs, () => {
      for (const p of this.all.slice()) p.conn.terminate();
    });
  }
}

installMembers(LanSwitch);
installRoute(LanSwitch);
installReader(LanSwitch);
installQueue(LanSwitch);

export { GONE_MAX, store };

