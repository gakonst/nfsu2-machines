// A connection: its queue (what the switch sends it, taken by its writer all at once), its writer, the bundle clock,
// and the ws library's states and close rules: crates/lan/src/conn.rs, sans-IO.  The writer hands whole WebSocket
// messages to the transport (Workers does the framing); the bytes they take on the wire are counted as Rust counted
// its frames (header and payload), so every queue rule reads the same numbers.

import * as compact from './compact.js';
import { Fpred } from './fpred.js';
import * as mix from './mix.js';
import { ByteBuf } from './bytebuf.js';

/** how a page takes its datagrams (Conn.compact) */
export const PLAIN = 0;
export const COMPACT = 1;
export const DELTAS = 2;
export const FPRED = 3;
/** with DELTAS or FPRED: every other datagram as what changed too */
export const OTHERS = 0x10;

/** ws's readyState */
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export const KIND_BUNDLE = 32;
/** bytes in one bundle to a client at most (lib.rs BUNDLE_OUT) */
export const BUNDLE_OUT = 32 << 10;
/** how long ws waited for the client's close frame after its own (lib.rs CLOSE_TIMEOUT) */
export const CLOSE_TIMEOUT_MS = 30_000;

/**
 * Something for a connection's writer (conn.rs Out):
 *   {k:'text', data} {k:'raw', data} {k:'frame', data, src, dst} {k:'dgram', data, src, dst, at}
 *   {k:'ping', data /*8 bytes*\/} {k:'pong', data} {k:'close', data} {k:'end'}
 * @typedef {{k:string, data?:Uint8Array, src?:number, dst?:number, at?:number}} Out
 */

/** conn.rs header_len: a frame's header for a payload of len (RFC 6455 5.2: 2, 4 or 10 bytes from a server) */
export function headerLen(len) {
  return len < 126 ? 2 : len < 65536 ? 4 : 10;
}

/** conn.rs Out::wire_len */
export function wireLen(it) {
  switch (it.k) {
    case 'text': case 'raw': case 'pong': case 'close': case 'frame': case 'ping':
      return headerLen(it.data.length) + it.data.length;
    default:
      return 0;
  }
}

/** conn.rs close_payload: a close frame's payload for a code and its reason (1005: none) */
export function closePayload(code, reason) {
  if (code === 1005) return new Uint8Array(0);
  const r = typeof reason === 'string' ? new TextEncoder().encode(reason) : reason;
  const p = new Uint8Array(2 + r.length);
  p[0] = code >> 8;
  p[1] = code & 255;
  p.set(r, 2);
  return p;
}

/** A connection's own state, before and after it holds an address (conn.rs Conn). */
export class Conn {
  /** @param {number} id @param {any} sw the switch (its wake, timers and transport) */
  constructor(id, sw) {
    this.id = id;
    this.sw = sw;
    this.state = OPEN;
    this.killed = false;
    /** OutQueue */
    this.q = [];
    this.buffered = 0;
    this.dgram = 0;
    this.armed = [false, false, false];
    /** CloseState */
    this.cs = { sent: false, received: null, errored: false };
    /** the peer it holds an address as */
    this.peer = null;
    this.streaming = false;
    this.compact = PLAIN;
    this.vip = 0;
    /** queue.rs Wait */
    this.wait = { id: 0, hello: null, texts: null, lastIn: 0 };
    this.expelled = false;
    this.browser = null;
    this.owner = null;
    this.noRaces = false;
    this.msgsIn = 0;
    this.msgsOut = 0;
    this.lanSent = 0;
    this.echo = false;
    this.stamp = false;
    /** the writer's own state (conn.rs write_loop's locals) */
    this.w = { busy: false, done: false, pending: 0, finish: null, closeSent: false, refs: new compact.Refs(), fp: new Fpred(), body: new ByteBuf() };
    /** the reader's own state (reader.rs read_loop's locals) */
    this.rd = { wait: null, waitTimer: null, firstText: true, peer: null, draining: false, done: false };
    this.closeTimer = null;
  }

  /** ws readyState === OPEN */
  open() {
    return this.state === OPEN;
  }

  /** ws terminate(): the connection goes at once (its close logic follows).  True for the call that ended it. */
  terminate() {
    if (this.killed) return false;
    this.killed = true;
    if (this.state === OPEN) this.state = CLOSING;
    this.sw._killed(this);
    return true;
  }

  /** the connection is over (its reader ended): nothing is sent to it any more */
  end() {
    this.killed = true;
    this.state = CLOSED;
    if (this.closeTimer) this.closeTimer.cancel();
    if (this.rd.waitTimer) this.rd.waitTimer.cancel();
  }

  /** queued to the writer, which wakes at once (while the connection is open) */
  push(item) {
    if (!this.open()) return;
    this.pushAny(item);
  }

  pushAny(item) {
    const n = wireLen(item);
    this.q.push(item);
    this.buffered += n;
    this.sw._wake(this);
  }

  /** a datagram for a peer that takes bundles: it waits for the clock (or goes at once without one) */
  pushDgram(data, src, dst, clock) {
    if (!this.open()) return;
    const n = 4 + data.length;
    const at = compact.timed(data) ? (this.sw._nowUs() | 1) >>> 0 : 0;
    this.q.push({ k: 'dgram', data, src, dst, at });
    this.dgram += n;
    const total = this.dgram;
    if (clock && total <= BUNDLE_OUT) {
      if (!this.armed[clock.lane]) {
        this.armed[clock.lane] = true;
        clock.arm(this);
      }
    } else {
      this.sw._wake(this);
    }
  }

  /** ws close(code, reason) with the close frame's payload: the frame, then up to 30 s for the client's */
  close(payload) {
    if (this.state === OPEN) {
      this.state = CLOSING;
      this.pushAny({ k: 'close', data: payload });
      this.closeTimerStart();
    }
  }

  /** the client's close frame (ws receiverOnConclude): answered with its code, and once both went the connection ends */
  closeReceived(code, reason) {
    const answer = closePayload(code, reason);
    this.cs.received = [code, reason];
    if (this.state === OPEN) {
      this.state = CLOSING;
      this.pushAny({ k: 'close', data: answer });
      this.closeTimerStart();
    } else if (this.cs.sent) {
      this.pushAny({ k: 'end' });
    }
  }

  /** a protocol error (ws receiverOnError): a close frame with the error's code only */
  protocolError(code) {
    this.cs.errored = true;
    if (this.state === OPEN) {
      this.state = CLOSING;
      this.pushAny({ k: 'close', data: new Uint8Array([code >> 8, code & 255]) });
      this.closeTimerStart();
    } else if (this.cs.sent) {
      this.pushAny({ k: 'end' });
    }
  }

  /** the writer sent the close frame: true when the connection may end now */
  closeSent() {
    this.cs.sent = true;
    return this.cs.received !== null || this.cs.errored;
  }

  /** what the switch's 'close' sees: the client's close frame, or 1006 without one: [code, reason bytes] */
  closeCode() {
    return this.cs.received ?? [1006, new Uint8Array(0)];
  }

  /** its page let go of its place itself (1000 "idle" or "closed"), or the operator removed it */
  letGo() {
    const [code, reason] = this.closeCode();
    const r = typeof reason === 'string' ? reason : new TextDecoder().decode(reason);
    return (code === 1000 && (r === 'idle' || r === 'closed')) || this.expelled;
  }

  /** ws's closeTimeout: a client that never answers the close frame is cut after 30 s */
  closeTimerStart() {
    if (this.closeTimer) this.closeTimer.cancel();
    this.closeTimer = this.sw._after(CLOSE_TIMEOUT_MS, () => {
      if (!this.killed) this.terminate();
    });
  }
}

/** conn.rs with_addrs: a frame with its source and destination written in; bytes 1-3 are 0 on the wire */
export function withAddrs(data, src, dst) {
  const b = new Uint8Array(data.length);
  b.set(data);
  b[1] = 0; b[2] = 0; b[3] = 0;
  const v = new DataView(b.buffer);
  v.setUint32(4, src >>> 0);
  v.setUint32(8, dst >>> 0);
  return b;
}

/**
 * conn.rs encode: the items into messages in order, the datagrams as bundles (compact ones for a page that takes them)
 * where the first of them stands; nothing after a close frame.
 * @param {any} stats @param {Out[]} items @param {{op:string,data:Uint8Array}[]} out @param {{closeSent:boolean}} st
 * @param {null|{own:number, refs:any, fp:any, others:boolean, body:ByteBuf, stamp:Uint8Array|null, nowUs:number}} c
 */
export function encode(stats, items, out, st, c) {
  const e = { counted: 0, extra: 0, close: false, end: false, msgs: 0 };
  let pending = true;
  for (const it of items) {
    e.counted += wireLen(it);
    if (it.k === 'end') {
      e.end = true;
      continue;
    }
    if (st.closeSent) continue;
    switch (it.k) {
      case 'dgram':
        if (pending) {
          pending = false;
          const start = out.length;
          e.msgs += c ? bundleCompact(stats, items, out, c) : bundle(stats, items, out);
          for (let i = start; i < out.length; i++) e.extra += headerLen(out[i].data.length) + out[i].data.length;
        }
        break;
      case 'text':
        stats.msg(mix.OUT_TEXT);
        e.msgs += 1;
        out.push({ op: 'text', data: it.data });
        break;
      case 'raw':
        stats.msg(mix.OUT_HOST);
        e.msgs += 1;
        out.push({ op: 'binary', data: it.data });
        break;
      case 'frame':
        stats.msg(mix.OUT_FRAME);
        e.msgs += 1;
        out.push({ op: 'binary', data: withAddrs(it.data, it.src, it.dst) });
        break;
      case 'ping':
        stats.msg(mix.OUT_PING);
        e.msgs += 1;
        out.push({ op: 'ping', data: it.data });
        break;
      case 'pong':
        stats.msg(mix.OUT_PONG);
        e.msgs += 1;
        out.push({ op: 'pong', data: it.data });
        break;
      case 'close':
        out.push({ op: 'close', data: it.data });
        st.closeSent = true;
        e.close = true;
        break;
      default:
        throw new Error('unknown out item ' + it.k);
    }
  }
  return e;
}

/** conn.rs bundle: the datagrams as bundles of at most BUNDLE_OUT (entries of n = 0); one alone goes as it is */
function bundle(stats, items, out) {
  const dgrams = items.filter((it) => it.k === 'dgram');
  let msgs = 0;
  let i = 0;
  while (i < dgrams.length) {
    const chunk = [];
    let sum = 0;
    while (i < dgrams.length) {
      const l = 4 + dgrams[i].data.length;
      if (chunk.length > 0 && sum + l > BUNDLE_OUT) break;
      sum += l;
      chunk.push(dgrams[i]);
      i++;
    }
    msgs += 1;
    if (chunk.length === 1) {
      const d = chunk[0];
      stats.msg(mix.OUT_FRAME);
      out.push({ op: 'binary', data: withAddrs(d.data, d.src, d.dst) });
    } else {
      stats.msg(mix.OUT_BUNDLE);
      const b = new Uint8Array(4 + sum);
      b[0] = KIND_BUNDLE;
      let at = 4;
      for (const d of chunk) {
        const len = d.data.length & 0xffff;
        b[at] = 0; b[at + 1] = 0; b[at + 2] = len >> 8; b[at + 3] = len & 255;
        b.set(withAddrs(d.data, d.src, d.dst), at + 4);
        at += 4 + d.data.length;
      }
      out.push({ op: 'binary', data: b });
      stats.bundlesOut++;
    }
  }
  return msgs;
}

/** conn.rs bundle_compact: the datagrams as compact bundles of BUNDLE_OUT at most, a datagram alone in one too */
function bundleCompact(stats, items, out, c) {
  const body = c.body;
  body.clear();
  body.pushBytes(new Uint8Array([compact.KIND_COMPACT, 0, 0, 0]));
  if (c.stamp) {
    body.bytes()[1] = compact.F_STAMPED;
    body.pushBytes(c.stamp);
  }
  let n = 0, msgs = 0;
  const now = c.nowUs >>> 0;
  const moved = new Uint8Array(compact.TIMED_MAX);
  for (const it of items) {
    if (it.k !== 'dgram') continue;
    const data = compact.waited(it.data, it.at !== 0 ? ((now - it.at) >>> 0) : 0, moved);
    const at = body.len;
    compact.entryFp(body, data, it.src, it.dst, c.own, c.refs, c.fp, c.others);
    stats.entryOut(data, it.src, it.dst, body.bytes().subarray(at));
    if (n > 0 && body.len > BUNDLE_OUT) {
      compactOut(stats, out, body.bytes().slice(0, at));
      msgs += 1;
      const tail = body.bytes().slice(at);
      body.truncate(4);
      body.bytes()[1] = 0;
      body.pushBytes(tail);
      n = 0;
    }
    n += 1;
  }
  if (n > 0) {
    compactOut(stats, out, body.bytes().slice());
    msgs += 1;
  }
  return msgs;
}

function compactOut(stats, out, bundle) {
  stats.msg(mix.OUT_BUNDLE);
  out.push({ op: 'binary', data: bundle });
  stats.bundlesOut++;
}

const SHARDS = 16;

/**
 * The bundle clock (conn.rs Clock): the writers of the peers with datagrams waiting, woken every tick, in 16 shards
 * at phases of their own; each tick the period give or take jitter of it, at random (the injected PRNG instead of a
 * time-seeded xorshift per shard).
 */
export class Clock {
  constructor(sw, periodMs, jitter, lane) {
    this.sw = sw;
    this.shards = Array.from({ length: SHARDS }, () => []);
    this.periodUs = Math.round(periodMs * 1000);
    this.jitter = Number.isFinite(jitter) ? Math.min(Math.max(jitter, 0), 0.9) : 0;
    this.lane = Math.min(lane, 2);
  }
  /** the next tick's length (µs) */
  nextPeriodUs(prng) {
    const p = this.period();
    if (this.jitter <= 0) return p;
    const u = prng.unit();
    return p * (1 + this.jitter * (2 * u - 1));
  }
  period() {
    return Math.max(this.periodUs, 1);
  }
  setPeriod(us) {
    this.periodUs = Math.floor(us);
  }
  arm(conn) {
    this.shards[conn.id % SHARDS].push(conn);
  }
  tick(shard) {
    const list = this.shards[shard];
    this.shards[shard] = [];
    for (const c of list) {
      c.armed[this.lane] = false;
      this.sw._wake(c);
    }
  }
  /** its timers from now (the switch's own timer queue) */
  start(now) {
    const period = this.period();
    for (let shard = 0; shard < SHARDS; shard++) {
      let next = now + (period * shard) / SHARDS / 1000;
      const run = () => {
        if (this.sw.stopped) return;
        this.tick(shard);
        next = Math.max(next + this.nextPeriodUs(this.sw.prng) / 1000, this.sw.now);
        this.sw.timers.at(next, run);
      };
      this.sw.timers.at(next, run);
    }
  }
}

