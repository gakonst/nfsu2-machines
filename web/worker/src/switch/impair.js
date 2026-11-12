// --lan-impair (a test aid, only with the server's --dev): a port of web/server-rs/crates/lan/src/impair.rs.  LAN
// play's frames (kinds 3-5) between browsers get tools/vlanhub.py's impairments: UDP and ICMP are delayed by delay +-
// jitter ms, lost with loss %, reordered with reorder % (2 x delay + 5 ms more); TCP (kind 4) is only delayed, in
// order.  Free roam's frames are never touched.
//
// hold=PCT,holdms=MS is what a player's WebSocket does when a TCP segment is lost on the way: everything after it
// waits for its resend, then comes at once.  A UDP or ICMP datagram starts a hold of holdms on its link (one sender to
// one receiver) with hold %, and that link's datagrams wait until it ends (theirs, if later), then go in the order they
// came.
//
// Legs are each player's own way to the server: leg=MS (leg.N=MS for the browser whose address ends in host number
// N) delays everything a browser sends on its way up, and everything it receives on its way down, +- legjitter ms, in
// order.  A frame from A to B takes A's leg up, then B's leg down, the way down taken in the order frames reach the
// server.  stall=PCT,stallms=MS (stall.N=PCT for one browser): with PCT % per frame on a leg, that leg stops for
// stallms, then hands over all it held at once.
//
// Sans-IO: Rust hands delayed frames to a tokio task that sleeps until each is due; here they wait in a queue inside
// the Impair: the switch calls deliver(stats, from, to, data, dst, nowMs) for a frame, and on its timer due(nowMs), which
// returns the frames to deliver now in Rust's order (by due time, equal times in the order they came; a frame reaching
// the server takes its receiver's leg down first); nextDueMs() says when to call it next.  The random numbers are
// Rust's own xorshift32 from the spec's seed (1 when none), so no PRNG is injected.  Times are one clock, nowMs (Rust
// reads Date.now() for TCP's order and tokio's Instant for the rest).

import { trim } from '../util/js.js';

/** lib.rs KIND_STREAM: LAN play's TCP segment */
export const KIND_STREAM = 4;

/** impair.rs host_of: a browser's host number on the switch (10.77.0.3 -> 3; lib.rs MASK) */
export function hostOf(vip) {
  return vip & 0x7fff;
}

/** impair.rs to_uint32: a number as an unsigned 32-bit integer: its whole part modulo 2^32 (0 for one that is not finite) */
export function toUint32(x) {
  return Number.isFinite(x) ? x >>> 0 : 0;
}

const DIGITS = { 16: /^[0-9a-fA-F]+$/, 8: /^[0-7]+$/, 2: /^[01]+$/ };

/**
 * text.rs to_number: JS +s of a string (the impairment's numbers): its whitespace trimmed, "" is 0, 0x/0o/0b integers
 * (summed digit by digit in f64, as Rust does), a decimal, NaN for anything else.
 */
export function toNumber(s) {
  const t = trim(s); // js::trim (JS's \s set)
  if (t === '') return 0.0;
  for (const [p, radix] of [['0x', 16], ['0X', 16], ['0o', 8], ['0O', 8], ['0b', 2], ['0B', 2]]) {
    if (t.startsWith(p)) {
      const d = t.slice(2);
      if (d === '' || !DIGITS[radix].test(d)) return NaN;
      let a = 0.0;
      for (let i = 0; i < d.length; i++) a = a * radix + parseInt(d[i], radix);
      return a;
    }
  }
  if (t === 'Infinity' || t === '+Infinity') return Infinity;
  if (t === '-Infinity') return -Infinity;
  // JS's StrDecimalLiteral: digits, one dot, an exponent (Rust's parse then; for these characters Number agrees)
  if (!/^[0-9.eE+-]+$/.test(t)) return NaN;
  return Number(t);
}

/** a u32 as Rust's str::parse::<u32> reads it: an optional "+", ASCII digits, at most u32::MAX; else null */
function parseU32(n) {
  if (!/^\+?[0-9]+$/.test(n)) return null;
  const v = Number(n.startsWith('+') ? n.slice(1) : n);
  return v <= 0xFFFFFFFF ? v : null;
}

/** a min-heap of {at, seq} by (at, seq) (Rust's BinaryHeap<Reverse<(Instant, u64)>>) */
class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  static less(x, y) {
    return x.at < y.at || (x.at === y.at && x.seq < y.seq);
  }
  peek() {
    return this.a.length ? this.a[0] : undefined;
  }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** impair.rs Impair: the --lan-impair spec and its state, with the frames it delays */
export class Impair {
  constructor() {
    this.delay = 0.0;
    this.jitter = 0.0;
    this.loss = 0.0;
    this.reorder = 0.0;
    this.hold = 0.0;
    this.holdms = 300.0;
    this.seed = 1.0;
    /** the random numbers: a xorshift32 from seed (0 is 1) */
    this.x = 1;
    /** when the last TCP segment from one browser to another goes out (they stay in order): "a:b" -> {a, b, t} */
    this.tcpLast = new Map();
    /** until when a link of one browser to another holds its UDP and ICMP (hold), and when the last one held goes */
    this.held = new Map();
    /** the legs (leg, leg.N, legjitter, stall, stall.N, stallms); host numbers of the per-browser ones */
    this.leg = 0.0;
    this.legjitter = 0.0;
    this.stall = 0.0;
    this.stallms = 1000.0;
    /** @type {Map<number, number>} */
    this.legOf = new Map();
    /** @type {Map<number, number>} */
    this.stallOf = new Map();
    /** each leg (a browser's address, up): when its last frame goes, and until when it stalls: "vip:up" -> {vip, last, until} */
    this.legs = new Map();
    /** the delayed frames (Rust: the delivery task's heap), and their sequence numbers */
    this.heap = new Heap();
    this.seq = 0;
  }

  /**
   * impair.rs Impair::parse: the --lan-impair spec: "delay=80,jitter=0,loss=100,seed=3"; unknown keys and non-numbers
   * are ignored.  null for "".
   * @param {string} spec
   * @returns {Impair|null}
   */
  static parse(spec) {
    if (spec === '') return null;
    const im = new Impair();
    for (const kv of spec.split(',')) {
      const it = kv.split('=');
      const k = it[0];
      if (it.length < 2) continue;
      const v = toNumber(it[1]);
      if (!Number.isFinite(v)) continue;
      switch (k) {
        case 'delay': im.delay = v; break;
        case 'jitter': im.jitter = v; break;
        case 'loss': im.loss = v; break;
        case 'reorder': im.reorder = v; break;
        case 'hold': im.hold = v; break;
        case 'holdms': im.holdms = v; break;
        case 'seed': im.seed = v; break;
        case 'leg': im.leg = v; break;
        case 'legjitter': im.legjitter = v; break;
        case 'stall': im.stall = v; break;
        case 'stallms': im.stallms = v; break;
        default: {
          const per = (p) => (k.startsWith(p) ? parseU32(k.slice(p.length)) : null);
          const nl = per('leg.');
          if (nl !== null) im.legOf.set(nl, v);
          else {
            const ns = per('stall.');
            if (ns !== null) im.stallOf.set(ns, v);
          }
        }
      }
    }
    const x = toUint32(im.seed);
    im.x = x === 0 ? 1 : x;
    return im;
  }

  /** impair.rs Impair::legs_on: whether frames take the browsers' legs */
  legsOn() {
    return this.leg !== 0.0 || this.legjitter !== 0.0 || this.stall !== 0.0 || this.legOf.size > 0 || this.stallOf.size > 0;
  }

  /**
   * impair.rs Impair::leg_time: when a frame that reaches one end of a browser's leg at from leaves the other end (up:
   * the browser's way to the server, else back): its delay +- legjitter, after a stall of the leg, never before the
   * leg's last
   */
  legTime(vip, up, from) {
    const h = hostOf(vip);
    let d = this.legOf.get(h) ?? this.leg;
    if (this.legjitter !== 0.0) d += (this.rand() * 2.0 - 1.0) * this.legjitter;
    const stall = this.stallOf.get(h) ?? this.stall;
    const start = stall !== 0.0 && this.rand() * 100.0 < stall;
    const key = vip + ':' + (up ? 1 : 0);
    let e = this.legs.get(key);
    if (e === undefined) this.legs.set(key, (e = { vip, last: from, until: from }));
    if (start && e.until <= from) e.until = from + Math.max(this.stallms, 0.0);
    const t = Math.max(from + Math.max(d, 0.0), e.until, e.last);
    e.last = t;
    return t;
  }

  /**
   * impair.rs Impair::spec_json: what info() shows of it, as an object in Rust's key order (JSON.stringify of it is
   * Rust's nfsu2_util::json::stringify)
   */
  specJson() {
    const m = { delay: this.delay, jitter: this.jitter, loss: this.loss, reorder: this.reorder, seed: this.seed };
    if (this.hold !== 0.0) {
      m.hold = this.hold;
      m.holdms = this.holdms;
    }
    if (this.legsOn()) {
      m.leg = this.leg;
      m.legjitter = this.legjitter;
      m.stall = this.stall;
      m.stallms = this.stallms;
      const per = [];
      for (const [n, v] of this.legOf) per.push(['leg.' + n, v]);
      for (const [n, v] of this.stallOf) per.push(['stall.' + n, v]);
      per.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [k, v] of per) m[k] = v;
    }
    // (json::num: -0 is 0, as JSON.stringify writes it)
    for (const k of Object.keys(m)) if (Object.is(m[k], -0)) m[k] = 0;
    return m;
  }

  /** impair.rs Impair::rand: xorshift32 (13, 17, 5), in [0, 1) */
  rand() {
    let x = this.x;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.x = x;
    return x / 4294967296.0;
  }

  /**
   * impair.rs Impair::deliver: a frame of LAN play's between browsers: lost (false, counted in stats.lost: a number,
   * or a util/counter.js Counter; stats may be null), or queued to be delivered later (true; due() hands it back, and
   * the switch's queue rules take it then).  from, to: the peers (anything with a vip; handed back as they are).
   * @param {{lost: any}|null} stats
   * @param {{vip: number}} from
   * @param {{vip: number}} to
   * @param {Uint8Array} data
   * @param {number} dst
   * @param {number} nowMs
   * @returns {boolean}
   */
  deliver(stats, from, to, data, dst, nowMs) {
    if (!(data.length > 0)) throw new RangeError('Impair.deliver: an empty frame');
    let d = this.delay;
    if (data[0] === KIND_STREAM) {
      const now = nowMs;
      const key = from.vip + ':' + to.vip;
      let e = this.tcpLast.get(key);
      if (e === undefined) this.tcpLast.set(key, (e = { a: from.vip, b: to.vip, t: 0.0 }));
      const t = Math.max(now + d, e.t);
      e.t = t;
      d = t - now;
    } else {
      if (this.loss !== 0.0 && this.rand() * 100.0 < this.loss) {
        if (stats) {
          if (typeof stats.lost === 'number') stats.lost += 1;
          else if (stats.lost && typeof stats.lost.inc === 'function') stats.lost.inc();
        }
        return false;
      }
      if (this.jitter !== 0.0) d += (this.rand() * 2.0 - 1.0) * this.jitter;
      if (this.reorder !== 0.0 && this.rand() * 100.0 < this.reorder) d += 2.0 * this.delay + 5.0;
    }
    // under 1 ms is 1 ms (as the Node server's timers had it)
    const now = nowMs;
    let at = now + Math.max(d, 1.0);
    if (this.hold !== 0.0 && data[0] !== KIND_STREAM) {
      // a held link's datagrams go when the hold ends, in order (never before the one before them)
      const start = this.rand() * 100.0 < this.hold;
      const key = from.vip + ':' + to.vip;
      let e = this.held.get(key);
      if (e === undefined) this.held.set(key, (e = { a: from.vip, b: to.vip, until: now, last: now }));
      if (start && e.until <= now) e.until = now + Math.max(this.holdms, 0.0);
      if (e.until > now) {
        at = Math.max(at, e.until, e.last);
        e.last = at;
      }
    }
    const up = this.legsOn();
    if (up) at = this.legTime(from.vip, true, at);
    this.seq += 1;
    this.heap.push({ at, seq: this.seq, from, to, data, dst, up });
    return true;
  }

  /** impair.rs Impair::forget: a browser left: its TCP order and its legs are forgotten */
  forget(vip) {
    for (const [k, e] of this.tcpLast) if (e.a === vip || e.b === vip) this.tcpLast.delete(k);
    for (const [k, e] of this.held) if (e.a === vip || e.b === vip) this.held.delete(k);
    for (const [k, e] of this.legs) if (e.vip === vip) this.legs.delete(k);
  }

  /** when the next delayed frame is due (ms), Infinity when none waits (Rust: the delivery task's sleep_until) */
  nextDueMs() {
    const top = this.heap.peek();
    return top === undefined ? Infinity : top.at;
  }

  /** how many frames wait */
  get waiting() {
    return this.heap.size;
  }

  /**
   * impair.rs Impair::start's loop, one wake: the delayed frames due by nowMs, in the order of their times (equal times
   * in the order they came); a frame still on its way up reaches the server and takes its receiver's leg down first
   * (in the order frames got here).
   * @returns {Array<{from: any, to: any, data: Uint8Array, dst: number}>}
   */
  due(nowMs) {
    const out = [];
    // each frame is popped at most twice (up, then down)
    const bound = 2 * this.heap.size + 1;
    for (let i = 0; ; i++) {
      if (i > bound) throw new Error('Impair.due: more pops than frames');
      const top = this.heap.peek();
      if (top === undefined || top.at > nowMs) break;
      this.heap.pop();
      if (top.up) {
        // at the server: the receiver's leg down next
        top.up = false;
        top.at = this.legTime(top.to.vip, false, top.at);
        this.seq += 1;
        top.seq = this.seq;
        this.heap.push(top);
        continue;
      }
      out.push({ from: top.from, to: top.to, data: top.data, dst: top.dst });
    }
    return out;
  }
}
