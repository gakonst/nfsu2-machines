// How far behind each player's path is, and the share of free roam's snapshots it gets meanwhile: a port of
// web/server-rs/crates/lan/src/lag.rs.
//
// Between the switch and a player are queues the switch never sees: the kernel's socket buffers, a proxy's, the
// tunnel to Cloudflare, Cloudflare's own.  When the path takes less than free roam sends the player (32 friends, 20
// snapshots a second each), the rest waits there and the player sees the other cars late.
//
// So the switch times each path: a WebSocket ping every probe_ms (the browser answers it by itself) goes out behind
// everything queued before it, and its pong comes back once all of that was read.  The lowest round trip of the last
// 30-60 s (at most BASE_MAX_MS: a path queued from the start must not count as its own base) is the path without
// queues; what a round trip has above it waited in them.  A path whose round trips stay above that through two whole
// windows of a cut share is that long without queues of ours (a satellite link, a far mobile one): its lowest round
// trip is its base from then on, or it never got its share back.  While a player's waits are long, it gets only a
// share of the snapshots sent to it (RC_MSG_SNAP; every other message of free roam goes): the share halves for a round
// trip over LAG_HIGH_MS (once for each round trip: only a ping queued after the last cut cuts again), drops to the
// least at once past LAG_SEVERE_MS, and grows by an eighth for each round trip under LAG_LOW_MS.
//
// Sans-IO: times are the caller's monotonic ms; a ping's payload comes from an injected PRNG (Rust: the OS's random
// bytes); a share is an object {v} standing in for Rust's AtomicU32 (Peer::share); pick() takes its RNG (Rust: a
// thread-local xorshift64 seeded from the OS; PickRng is that xorshift64, bit for bit).

import { fmax, fmin } from '../util/f64.js';

/** lag.rs SHARE_FULL: a player's share of the snapshots sent to it, in 1/SHARE_FULL (Peer::share) */
export const SHARE_FULL = 1 << 16;
/** lag.rs SHARE_MIN: the least share: a snapshot in 16 (a car near by still moves about once a second) */
export const SHARE_MIN = SHARE_FULL / 16;
/** lag.rs LAG_HIGH_MS: a round trip this much over the base: halve the share */
export const LAG_HIGH_MS = 400.0;
/** lag.rs LAG_SEVERE_MS: this much: the least share at once */
export const LAG_SEVERE_MS = 1500.0;
/** lag.rs LAG_LOW_MS: under this much: an eighth more */
export const LAG_LOW_MS = 150.0;
/** lag.rs BASE_WINDOW_MS: the base is the lowest round trip of this window and the one before */
export const BASE_WINDOW_MS = 30_000.0;
/** lag.rs BASE_MAX_MS: and at most this, until a cut share shows the path is longer (Probe.floor) */
export const BASE_MAX_MS = 400.0;
/** lag.rs MAX_OUT: pings waiting for their pong at most (past it the oldest is forgotten) */
export const MAX_OUT = 64;

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** lag.rs Probe: one player's pings and what their round trips say */
export class Probe {
  /** lag.rs Probe::new */
  constructor(now) {
    /** the pings not answered yet, oldest first: {data: Uint8Array(8), sent: ms} */
    this.out = [];
    /** the keepalive's last tick: only a pong to a ping queued since says the client is there */
    this.tickAt = now;
    /** the last round trip (ms; NaN before the first; Rust's field rtt, renamed for the method rtt()) */
    this.lastRtt = NaN;
    /** the lowest round trip of this window and of the one before, and when this one and the one before began */
    this.baseNow = Infinity;
    this.basePrev = Infinity;
    this.windowAt = now;
    this.prevAt = -Infinity;
    /** the most the base counts as (BASE_MAX_MS, or the path's own lowest round trip through two windows of a cut share) */
    this.floor = BASE_MAX_MS;
    /** when the share was last cut: only a ping queued after it halves it again */
    this.cutAt = -Infinity;
    /** since when the share is under all (Infinity: it is all) */
    this.thinAt = Infinity;
  }

  /**
   * lag.rs Probe::ping: a new ping's payload (random: only a client that reads can answer it), noted with its time.
   * prng: anything with bytes(n) (util/prng.js Prng); Rust fills it from the OS.
   * @returns {Uint8Array} 8 bytes
   */
  ping(now, prng) {
    const data = Uint8Array.from(prng.bytes(8));
    if (data.length !== 8) throw new Error('Probe.ping: the PRNG must give 8 bytes');
    if (this.out.length === MAX_OUT) this.out.shift();
    this.out.push({ data, sent: now });
    return data;
  }

  /** lag.rs Probe::tick: the keepalive's tick: from now on only a pong to a ping queued since says the client is there */
  tick(now) {
    this.tickAt = now;
  }

  /**
   * lag.rs Probe::pong: null when it answers none of the pings waiting (it never counts as a sign of life), else
   * whether it says the client is there.  Its round trip moves share.v.  A client may answer only the newest of
   * several pings (RFC 6455 5.5.3), so those before the one answered go.
   * @param {Uint8Array} d the pong's payload
   * @param {number} now
   * @param {{v: number}} share the peer's share (Rust's AtomicU32)
   * @returns {boolean|null}
   */
  pong(d, now, share) {
    const i = this.out.findIndex((p) => sameBytes(p.data, d));
    if (i < 0) return null;
    const sent = this.out[i].sent;
    this.out.splice(0, i + 1);
    // (an echo's now is less the page's own wait, which the page says: never under 0)
    const rtt = fmax(now - sent, 0.0);
    this.lastRtt = rtt;
    if (now - this.windowAt >= BASE_WINDOW_MS) {
      this.basePrev = this.baseNow;
      this.baseNow = Infinity;
      this.prevAt = this.windowAt;
      this.windowAt = now;
    }
    this.baseNow = fmin(this.baseNow, rtt);
    const base = fmin(this.baseNow, this.basePrev);
    // both windows of the base under a cut share: what is left above BASE_MAX_MS is the path, not a queue of ours
    if (this.thinAt <= this.prevAt) this.floor = fmax(this.floor, base);
    const waited = rtt - fmin(base, this.floor);
    const s = share.v >>> 0;
    let next;
    if (waited > LAG_SEVERE_MS) next = SHARE_MIN;
    else if (waited > LAG_HIGH_MS && sent > this.cutAt) next = Math.max(s >>> 1, SHARE_MIN);
    else if (waited < LAG_LOW_MS) next = Math.min(s + SHARE_FULL / 8, SHARE_FULL);
    else next = s;
    if (next < s) this.cutAt = now;
    if (next === SHARE_FULL) this.thinAt = Infinity;
    else if (this.thinAt === Infinity) this.thinAt = now;
    share.v = next >>> 0;
    return sent >= this.tickAt;
  }

  /** lag.rs Probe::rtt: the last round trip (ms), null before the first */
  rtt() {
    return this.lastRtt !== this.lastRtt ? null : this.lastRtt;
  }

  /**
   * lag.rs Probe::base: the path's round trip without queues (ms): its lowest of the last 30-60 s (not capped at
   * floor); null before its first pong
   */
  base() {
    const b = fmin(this.baseNow, this.basePrev);
    return Number.isFinite(b) ? b : null;
  }

  /** lag.rs Probe::lag: how far behind the path is now (ms): the last round trip, or longer while a ping waits longer */
  lag(now) {
    const waiting = this.out.length === 0 ? 0.0 : now - this.out[0].sent;
    return this.lastRtt !== this.lastRtt ? waiting : fmax(this.lastRtt, waiting);
  }
}

/**
 * lag.rs is_snap: a free-roam snapshot (runtime/roam_core.h RC_MSG_SNAP, version 1): a frame of kind 1 whose datagram
 * (past the switch's 16-byte header) begins "N2FR", 1, 3
 * @param {Uint8Array} frame
 */
export function isSnap(frame) {
  return frame.length > 21 && frame[16] === 0x4e && frame[17] === 0x32 && frame[18] === 0x46 && frame[19] === 0x52 &&
    frame[20] === 1 && frame[21] === 3;
}

/**
 * lag.rs's per-thread RNG for pick(): xorshift64 (13, 7, 17), started at seed | 1 (Rust: the OS's u64 | 1), kept as two
 * u32 halves (no BigInt on the hot path).  next32() is the high half after a step: what Rust's pick compares.
 */
export class PickRng {
  /** @param {bigint|number} seed */
  constructor(seed) {
    const s = BigInt.asUintN(64, typeof seed === 'bigint' ? seed : BigInt(Math.trunc(seed))) | 1n;
    this.hi = Number(s >> 32n) >>> 0;
    this.lo = Number(s & 0xFFFFFFFFn) >>> 0;
  }

  /** seeded from an injected PRNG (util/prng.js Prng), as Rust seeds from the OS */
  static fromPrng(prng) {
    return new PickRng(prng.next64());
  }

  /** one xorshift64 step; the state's high 32 bits */
  next32() {
    let hi = this.hi, lo = this.lo;
    // x ^= x << 13
    let h = ((hi << 13) | (lo >>> 19)) >>> 0, l = (lo << 13) >>> 0;
    hi = (hi ^ h) >>> 0; lo = (lo ^ l) >>> 0;
    // x ^= x >> 7
    l = ((lo >>> 7) | (hi << 25)) >>> 0; h = hi >>> 7;
    hi = (hi ^ h) >>> 0; lo = (lo ^ l) >>> 0;
    // x ^= x << 17
    h = ((hi << 17) | (lo >>> 15)) >>> 0; l = (lo << 17) >>> 0;
    hi = (hi ^ h) >>> 0; lo = (lo ^ l) >>> 0;
    this.hi = hi; this.lo = lo;
    return hi;
  }
}

/**
 * lag.rs pick: true with the probability share / SHARE_FULL.  rng: a PickRng (Rust's algorithm, bit for bit) or
 * anything with next32() (such as util/prng.js Prng).
 */
export function pick(share, rng) {
  return (rng.next32() & (SHARE_FULL - 1)) < share;
}
