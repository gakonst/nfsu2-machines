// Token buckets and budgets: a port of web/server-rs/crates/util/src/bucket.rs.
//
// - Bucket: a token bucket (rate a second, a burst of two seconds' worth or one of its own), with a spendAt() that
//   may run into a debt of one burst.
// - Budget: what clients hold at once (per client, per site, in all, a free share for newcomers).
// - Rate: how often a client may do something (a bucket per client and per site).
//
// Sans-IO: Rust's forms that read mono_ms() themselves (Bucket::new/has/take/spend, Rate::take/check/prune) take the
// time as an argument here (nowMs, the switch's monotonic milliseconds).  The f64 math is Rust's, operation for
// operation, so the levels are bit-identical (test/switch/timing-diff.test.mjs checks it against the Rust code).

import { fmax, fmin } from './f64.js';

/**
 * bucket.rs Bucket: a token bucket: rate a second, at most 2 * rate (two seconds' worth) stored, or burst
 * (withBurstAt), full at the start.  Times are the caller's monotonic milliseconds.
 */
export class Bucket {
  /** a bucket as it is (Rust's struct literal): rate, cap, level v, time t */
  constructor(rate, cap, v, t) {
    this.rate = rate;
    this.cap = cap;
    this.v = v;
    this.t = t;
  }

  /** bucket.rs Bucket::new_at: a burst of two seconds' worth */
  static newAt(rate, now) {
    return Bucket.withBurstAt(rate, rate * 2.0, now);
  }

  /** bucket.rs Bucket::with_burst_at: at most burst stored */
  static withBurstAt(rate, burst, now) {
    return new Bucket(rate, burst, burst, now);
  }

  /** bucket.rs Bucket::level_at: what there is at now, the bucket left as it is */
  levelAt(now) {
    return fmin(this.cap, this.v + (now - this.t) / 1000.0 * this.rate);
  }

  /** bucket.rs Bucket::has_at: refilled to now, and n is there */
  hasAt(now, n) {
    this.v = this.levelAt(now);
    this.t = now;
    return this.v >= n;
  }

  /** bucket.rs Bucket::take_at: n taken when it is there */
  takeAt(now, n) {
    if (!this.hasAt(now, n)) return false;
    this.v -= n;
    return true;
  }

  /** bucket.rs Bucket::spend_at: n spent whether it is there or not (a debt of at most one burst); false once it was not */
  spendAt(now, n) {
    this.hasAt(now, 0.0);
    this.v = fmax(-this.cap, this.v - n);
    return this.v >= 0.0;
  }
}

/** (m.get(k) ?? 0) + 1 */
function inc(m, k) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** (m.get(k) ?? 1) - 1, kept while above 0 */
function dec(m, k) {
  const v = m.get(k);
  if (v === undefined) return;
  if (v > 1) m.set(k, v - 1);
  else m.delete(k);
}

/**
 * bucket.rs Budget: what clients hold at once.  At most per for one client (key), perSite for one site, total in
 * all, and the last free share of the total only for a client (and site) that holds none yet.  An empty site is
 * none (an IPv4 client).  total: Infinity (Rust's usize::MAX) for no limit.
 */
export class Budget {
  /** bucket.rs Budget::new */
  constructor(per, perSite, total, free) {
    if (total === Number.MAX_SAFE_INTEGER) total = Infinity;
    let open;
    if (total === Infinity) open = Infinity;
    else {
      // (Rust: (total as f64 * free).floor() as usize, a saturating cast)
      const f = Math.floor(total * free);
      open = total - (f > 0 ? f : 0);
      if (!(open >= 0)) throw new RangeError('Budget: free above 1 (Rust overflows)');
    }
    this.per = per;
    this.perSite = perSite;
    this.total = total;
    this.open = open;
    /** @type {Map<string, number>} */
    this.by = new Map();
    /** @type {Map<string, number>} */
    this.bySite = new Map();
    this.n = 0;
  }

  /** bucket.rs Budget::take: one more for this client: false when it has its share */
  take(key, site) {
    if (!this.fits(key, site)) return false;
    inc(this.by, key);
    if (site !== '') inc(this.bySite, site);
    this.n += 1;
    return true;
  }

  /** bucket.rs Budget::room: whether take would go through now, taking nothing */
  room(key, site) {
    return this.fits(key, site);
  }

  /** bucket.rs Budget::fits */
  fits(key, site) {
    const a = this.by.get(key) ?? 0;
    const b = site === '' ? 0 : (this.bySite.get(site) ?? 0);
    if (a >= this.per || b >= this.perSite || this.n >= this.total) return false;
    return !(this.n >= this.open && (a > 0 || b > 0));
  }

  /** bucket.rs Budget::give */
  give(key, site) {
    dec(this.by, key);
    if (site !== '') dec(this.bySite, site);
    this.n = this.n > 0 ? this.n - 1 : 0;
  }

  /** bucket.rs Budget::held */
  held(key) {
    return this.by.get(key) ?? 0;
  }

  /** bucket.rs Budget::count: held in all */
  count() {
    return this.n;
  }
}

/**
 * bucket.rs Rate: how often a client may do something: a token bucket per client (burst, perSec) and per site (twice
 * the client's).  prune(nowMs) (every minute) drops the buckets that are full again.
 */
export class Rate {
  /** bucket.rs Rate::new */
  constructor(burst, perSec) {
    this.burst = burst;
    this.rate = perSec;
    /** @type {Map<string, Bucket>} */
    this.m = new Map();
  }

  /** bucket.rs Rate::one: the key's bucket, made full when new, refilled to now */
  one(k, scale, now) {
    let b = this.m.get(k);
    if (b === undefined) {
      b = Bucket.withBurstAt(this.rate * scale, this.burst * scale, now);
      this.m.set(k, b);
    }
    b.hasAt(now, 0.0);
    return b;
  }

  /** bucket.rs Rate::take (Rust reads mono_ms() itself) */
  take(key, site, now) {
    const a = this.one(key, 1.0, now).v;
    const b = site === '' ? null : this.one('site ' + site, 2.0, now).v;
    if (a < 1.0 || (b !== null && b < 1.0)) return false;
    this.m.get(key).v -= 1.0;
    if (site !== '') this.m.get('site ' + site).v -= 1.0;
    return true;
  }

  /** bucket.rs Rate::check: whether take would go through now, taking nothing */
  check(key, site, now) {
    const left = (k) => {
      const b = this.m.get(k);
      return b === undefined || b.levelAt(now) >= 1.0;
    };
    return left(key) && (site === '' || left('site ' + site));
  }

  /** bucket.rs Rate::prune: the buckets full again go (the ones not full are kept) */
  prune(now) {
    for (const [k, b] of this.m) if (!(b.levelAt(now) < b.cap)) this.m.delete(k);
  }
}
